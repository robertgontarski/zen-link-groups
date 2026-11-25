// ==UserScript==
// @name           Zen Link Groups
// @description    Tabs opened from links are grouped under the tab they came from, Dia style.
// @include        main
// ==/UserScript==

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

(function () {
  "use strict";

  if (window.gZenLinkGroups) {
    return;
  }

  const BASE = "chrome://userscripts/content/zen-link-groups/";
  const { LinkGroupsStore: store } = ChromeUtils.importESModule(BASE + "store.sys.mjs");
  const model = ChromeUtils.importESModule(BASE + "model.sys.mjs");

  const TAB_EVENTS = ["TabOpen", "TabClose", "TabMove", "TabSelect", "TabPinned", "TabUnpinned"];
  const DECORATIONS = [
    "zlg-role",
    "zlg-color",
    "zlg-trunk",
    "zlg-first",
    "zlg-last",
    "zlg-orphan",
    "zlg-hidden",
    "zlg-collapsed",
  ];
  // Containers whose direct children are the unpinned tabs of one space.
  const SECTION_SELECTOR = ".zen-workspace-normal-tabs-section, #tabbrowser-arrowscrollbox";
  // Items that sit among tabs but are not plain tabs: they cut a group's run.
  const OPAQUE_SELECTOR = "tab-group, zen-folder, tab-split-view-wrapper";
  // Wait for a drag to settle before re-deriving groups from tab order.
  const SETTLE_MS = 80;
  const OPEN_RETRIES = 10;
  const RECENTLY_CLOSED_LIMIT = 50;

  const STRINGS = {
    en: {
      collapse: "Collapse group",
      expand: "Expand group",
      removeFromGroup: "Remove from group",
      ungroup: "Ungroup",
      closeGroup: "Close group",
      toggleTooltip: count => `${count} tab${count === 1 ? "" : "s"} opened from here – click to collapse or expand`,
    },
    pl: {
      collapse: "Zwiń grupę",
      expand: "Rozwiń grupę",
      removeFromGroup: "Wyjmij z grupy",
      ungroup: "Rozgrupuj",
      closeGroup: "Zamknij grupę",
      toggleTooltip: count => `Karty otwarte stąd: ${count} – kliknij, aby zwinąć lub rozwinąć`,
    },
  };
  const t = Services.locale.appLocaleAsBCP47.startsWith("pl") ? STRINGS.pl : STRINGS.en;

  const isTab = el => !!el?.classList?.contains("tabbrowser-tab");
  const isAlive = tab => isTab(tab) && tab.isConnected && !tab.closing;

  function setAttr(el, name, value) {
    if (value === null || value === undefined || value === false) {
      if (el.hasAttribute(name)) {
        el.removeAttribute(name);
      }
      return;
    }
    const text = value === true ? "true" : String(value);
    if (el.getAttribute(name) !== text) {
      el.setAttribute(name, text);
    }
  }

  /** Every tab id across all browser windows (and all Zen spaces). */
  function collectLiveIds() {
    const ids = new Set();
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      const tabs = [...(win.gBrowser?.tabs ?? []), ...(win.gZenWorkspaces?.allStoredTabs ?? [])];
      for (const tab of tabs) {
        if (tab.id) {
          ids.add(tab.id);
        }
      }
    }
    return ids;
  }

  class ZenLinkGroups {
    /** @type {WeakMap<Element, Element|null>} opener captured at TabOpen */
    #openers = new WeakMap();
    /** Tabs opened since the last pass, waiting for Zen to give them an id. */
    #pendingOpened = new Set();
    /** Tabs that just joined a group because they were opened from a link. */
    #fresh = new Set();
    /** Tabs the user moved or opened since the last reconcile. */
    #touched = new Set();
    /** id -> root id of recently closed members, so undo-close restores them. */
    #recentlyClosed = new Map();
    /** glance tab -> { parent, observer } until the glance is opened fully. */
    #glances = new Map();
    #decorated = new Set();
    #menu = null;
    /** Tab the context menu was opened on. */
    #menuTab = null;
    #openTimer = null;
    #reconcileTimer = null;
    #renderTimer = null;
    #unsubscribe = null;
    #ready = false;

    async init() {
      await delayedStartupPromise;
      await window.gZenWorkspaces?.promiseInitialized;
      await store.ready;
      if (window.closed) {
        return;
      }
      for (const type of TAB_EVENTS) {
        window.addEventListener(type, this);
      }
      window.addEventListener("unload", this, { once: true });
      this.#unsubscribe = store.subscribe(() => this.scheduleRender());
      this.#initContextMenu();
      this.#ready = true;
      SessionStore.promiseAllWindowsRestored.then(() => store.pruneOnce(collectLiveIds));
      this.scheduleRender();
    }

    #uninit() {
      this.#ready = false;
      for (const type of TAB_EVENTS) {
        window.removeEventListener(type, this);
      }
      this.#unsubscribe?.();
      for (const { observer } of this.#glances.values()) {
        observer.disconnect();
      }
      this.#glances.clear();
      clearTimeout(this.#openTimer);
      clearTimeout(this.#reconcileTimer);
      clearTimeout(this.#renderTimer);
    }

    handleEvent(event) {
      switch (event.type) {
        case "TabOpen":
          this.#onTabOpen(event.target);
          break;
        case "TabClose":
          this.#onTabClose(event.target);
          break;
        case "TabMove":
          this.#onTabMove(event.target);
          break;
        case "TabPinned":
          if (store.rootOf(event.target.id)) {
            store.removeMember(event.target.id);
          }
          this.scheduleRender();
          break;
        case "TabSelect":
        case "TabUnpinned":
          this.scheduleRender();
          break;
        case "popupshowing":
          if (event.target.id === "tabContextMenu") {
            this.#updateContextMenu(event.target);
          }
          break;
        case "unload":
          this.#uninit();
          break;
      }
    }

    /* Public actions (context menu, toggle button, debugging) */

    toggleCollapsed(rootId) {
      const info = store.info(rootId);
      if (info) {
        store.setCollapsed(rootId, !info.collapsed);
      }
    }

    removeFromGroup(tab) {
      const root = store.rootOf(tab?.id);
      if (!root) {
        return;
      }
      // Step out below the group so the remaining run stays in one piece.
      const section = this.#sectionOf(tab);
      if (section) {
        const items = this.#itemsOf(section);
        const index = items.findIndex(item => item.id === tab.id);
        const run = model.clusters(items).find(c => c.start <= index && index <= c.end);
        if (run && run.end !== index) {
          const last = this.#tabById(items[run.end].id);
          store.runSelfMove(() => gBrowser.moveTabAfter(tab, last));
        }
      }
      store.removeMember(tab.id);
    }

    ungroup(rootId) {
      store.dissolve(rootId);
    }

    /** Closes the members, and the root too unless it is pinned or an Essential. */
    closeGroup(rootId) {
      const root = this.#tabById(rootId);
      const keepRoot = root?.pinned || root?.hasAttribute("zen-essential");
      const tabs = [...(keepRoot ? [] : [rootId]), ...store.membersOf(rootId)]
        .map(id => this.#tabById(id))
        .filter(isAlive);
      gBrowser.removeTabs(tabs);
    }

    /* Tab lifecycle */

    #onTabOpen(tab) {
      this.#openers.set(tab, tab.openerTab ?? null);
      this.#pendingOpened.add(tab);
      if (!this.#openTimer) {
        // Zen assigns the tab id and its space right after TabOpen.
        this.#openTimer = setTimeout(() => this.#processOpened(0), 0);
      }
    }

    #processOpened(attempt) {
      this.#openTimer = null;
      const waiting = new Set();
      for (const tab of this.#pendingOpened) {
        if (!isAlive(tab)) {
          continue;
        }
        if (!tab.id && attempt < OPEN_RETRIES) {
          waiting.add(tab);
          continue;
        }
        this.#classify(tab);
        this.#touched.add(tab);
      }
      this.#pendingOpened = waiting;
      if (waiting.size) {
        this.#openTimer = setTimeout(() => this.#processOpened(attempt + 1), 50);
      }
      this.#scheduleReconcile(0);
    }

    #classify(tab) {
      if (tab.hasAttribute("zen-glance-tab")) {
        this.#watchGlance(tab);
        return;
      }
      const formerRoot = this.#recentlyClosed.get(tab.id);
      this.#recentlyClosed.delete(tab.id);
      const opener = this.#resolveOpener(this.#openers.get(tab));
      if (opener && this.#canGroup(tab, opener)) {
        if (store.addMember(tab.id, opener.id)) {
          this.#fresh.add(tab);
        }
        return;
      }
      const root = formerRoot && this.#tabById(formerRoot);
      if (root && this.#canGroup(tab, root)) {
        store.addMember(tab.id, root.id);
      }
    }

    #resolveOpener(opener) {
      if (!isAlive(opener)) {
        return null;
      }
      // A link clicked inside a Glance preview belongs to the Glance's parent.
      return window.gZenGlanceManager?.getTabOrGlanceParent?.(opener) ?? opener;
    }

    #isGroupable(tab) {
      return (
        isAlive(tab) &&
        !!tab.id &&
        !tab.pinned &&
        !tab.hidden &&
        !tab.hasAttribute("zen-essential") &&
        !tab.hasAttribute("zen-glance-tab") &&
        !tab.hasAttribute("zen-empty-tab") &&
        !!tab.parentElement?.matches(SECTION_SELECTOR)
      );
    }

    #canGroup(tab, parent) {
      if (!isAlive(parent) || parent === tab || !parent.id || parent.hasAttribute("zen-empty-tab")) {
        return false;
      }
      if (!this.#isGroupable(tab)) {
        return false;
      }
      // Essentials are shared by every space; anything else must share the space.
      return (
        parent.hasAttribute("zen-essential") ||
        parent.getAttribute("zen-workspace-id") === tab.getAttribute("zen-workspace-id")
      );
    }

    #watchGlance(tab) {
      if (this.#glances.has(tab)) {
        return;
      }
      const viaGlance = this.#resolveOpener(tab);
      const parent = viaGlance !== tab ? viaGlance : this.#resolveOpener(this.#openers.get(tab));
      if (!isAlive(parent)) {
        return;
      }
      const observer = new MutationObserver(() => {
        if (tab.hasAttribute("zen-glance-tab")) {
          return;
        }
        this.#stopGlanceWatch(tab);
        // Zen moves the tab next to its parent around the same time.
        setTimeout(() => {
          if (this.#canGroup(tab, parent) && store.addMember(tab.id, parent.id)) {
            this.#fresh.add(tab);
            this.#touched.add(tab);
            this.#scheduleReconcile(0);
          }
        }, 0);
      });
      observer.observe(tab, { attributes: true, attributeFilter: ["zen-glance-tab"] });
      this.#glances.set(tab, { parent, observer });
    }

    #stopGlanceWatch(tab) {
      this.#glances.get(tab)?.observer.disconnect();
      this.#glances.delete(tab);
    }

    #onTabClose(tab) {
      this.#pendingOpened.delete(tab);
      this.#touched.delete(tab);
      this.#fresh.delete(tab);
      this.#stopGlanceWatch(tab);
      const id = tab.id;
      if (!id) {
        return;
      }
      if (store.isRoot(id)) {
        store.forget(id, this.#successorOf(id));
        return;
      }
      const root = store.rootOf(id);
      if (root) {
        this.#recentlyClosed.set(id, root);
        if (this.#recentlyClosed.size > RECENTLY_CLOSED_LIMIT) {
          this.#recentlyClosed.delete(this.#recentlyClosed.keys().next().value);
        }
        store.removeMember(id);
      }
    }

    /** First member in tab order: it takes over the group of a closing root. */
    #successorOf(rootId) {
      for (const tab of gBrowser.tabs) {
        if (isAlive(tab) && store.rootOf(tab.id) === rootId) {
          return tab.id;
        }
      }
      return null;
    }

    #onTabMove(tab) {
      if (store.selfMoving) {
        return;
      }
      // Zen mirrors every move into the other synced windows. Only the window
      // the user works in re-derives groups; the others just repaint.
      if (Services.wm.getMostRecentWindow("navigator:browser") !== window) {
        this.scheduleRender();
        return;
      }
      this.#touched.add(tab);
      this.#scheduleReconcile(SETTLE_MS);
    }

    /* Membership from tab order */

    #scheduleReconcile(delay) {
      clearTimeout(this.#reconcileTimer);
      this.#reconcileTimer = setTimeout(() => this.#reconcile(), delay);
    }

    #reconcile() {
      this.#reconcileTimer = null;
      if (gBrowser.tabContainer.hasAttribute("movingtab")) {
        this.#scheduleReconcile(SETTLE_MS);
        return;
      }
      const touched = [...this.#touched].filter(isAlive);
      const fresh = this.#fresh;
      this.#touched = new Set();
      this.#fresh = new Set();
      if (touched.length) {
        const touchedIds = new Set(touched.map(tab => tab.id));
        store.runSelfMove(() => {
          for (const tab of touched) {
            this.#keepTogether(tab, fresh.has(tab), touchedIds);
          }
        });
        for (const section of this.#sections()) {
          const { join, leave } = model.reconcileSection(this.#itemsOf(section), {
            touched: touchedIds,
            rootPlacement: id => this.#rootPlacement(id, section),
          });
          for (const id of leave) {
            store.removeMember(id);
          }
          for (const [id, root] of join) {
            store.addMember(id, root);
          }
        }
      }
      this.scheduleRender();
    }

    /** A moved root pulls its members along; a new member lands next to its group. */
    #keepTogether(tab, isFresh, touchedIds) {
      const section = this.#sectionOf(tab);
      if (!section) {
        return;
      }
      if (store.isRoot(tab.id)) {
        const { after, ids } = model.planFollow(this.#itemsOf(section), tab.id, touchedIds);
        const members = ids.map(id => this.#tabById(id)).filter(isAlive);
        if (members.length) {
          gBrowser.moveTabsAfter(members, this.#tabById(after));
        }
      } else if (isFresh && store.rootOf(tab.id)) {
        const after = model.placementTarget(this.#itemsOf(section), tab.id);
        if (after) {
          gBrowser.moveTabAfter(tab, this.#tabById(after));
        }
      }
    }

    #rootPlacement(rootId, section) {
      const root = this.#tabById(rootId);
      if (!isAlive(root)) {
        return "missing";
      }
      if (root.parentElement === section) {
        return "here";
      }
      if (!root.pinned && root.parentElement?.matches(SECTION_SELECTOR)) {
        return "other-section";
      }
      return "elsewhere";
    }

    /* DOM helpers */

    #tabById(id) {
      const el = id ? document.getElementById(id) : null;
      return isTab(el) ? el : null;
    }

    #sections() {
      return document.querySelectorAll(SECTION_SELECTOR);
    }

    #sectionOf(tab) {
      const parent = tab?.parentElement;
      return parent?.matches(SECTION_SELECTOR) ? parent : null;
    }

    #itemsOf(section) {
      const items = [];
      for (const el of section.children) {
        if (isTab(el)) {
          if (
            !isAlive(el) ||
            !el.id ||
            el.hidden ||
            el.hasAttribute("zen-empty-tab") ||
            el.hasAttribute("zen-glance-tab")
          ) {
            continue;
          }
          items.push({ id: el.id, root: store.rootOf(el.id), isRoot: store.isRoot(el.id) });
        } else if (el.matches(OPAQUE_SELECTOR)) {
          items.push({ id: null, opaque: true });
        }
      }
      return items;
    }

    /* Rendering */

    scheduleRender() {
      if (this.#renderTimer || !this.#ready) {
        return;
      }
      this.#renderTimer = setTimeout(() => {
        this.#renderTimer = null;
        this.#render();
      }, 0);
    }

    #render() {
      if (!this.#ready) {
        return;
      }
      const selectedId = gBrowser.selectedTab?.id ?? null;
      const isCollapsed = id => !!store.info(id)?.collapsed;
      const next = new Map();
      for (const section of this.#sections()) {
        const decorations = model.layout(this.#itemsOf(section), { isCollapsed, selectedId });
        for (const [id, decoration] of decorations) {
          const tab = this.#tabById(id);
          if (tab) {
            next.set(tab, decoration);
          }
        }
      }
      // Roots outside the unpinned list (pinned, Essentials, split views).
      for (const rootId of store.roots()) {
        const tab = this.#tabById(rootId);
        if (isAlive(tab) && !next.has(tab)) {
          next.set(tab, { role: "root", gid: rootId });
        }
      }
      for (const tab of this.#decorated) {
        if (!next.has(tab)) {
          this.#undecorate(tab);
        }
      }
      for (const [tab, decoration] of next) {
        this.#decorate(tab, decoration);
      }
      this.#decorated = new Set(next.keys());
    }

    #decorate(tab, { role, gid, trunk, first, last, orphan, hidden }) {
      const info = store.info(gid);
      setAttr(tab, "zlg-role", role);
      setAttr(tab, "zlg-color", info?.color ?? 0);
      setAttr(tab, "zlg-trunk", !!trunk);
      setAttr(tab, "zlg-first", !!first);
      setAttr(tab, "zlg-last", !!last);
      setAttr(tab, "zlg-orphan", !!orphan);
      setAttr(tab, "zlg-hidden", !!hidden);
      setAttr(tab, "zlg-collapsed", role === "root" && !!info?.collapsed);
      if (role === "root") {
        this.#ensureToggle(tab, store.membersOf(gid).length);
      } else {
        tab.querySelector(".zlg-toggle")?.remove();
      }
    }

    #undecorate(tab) {
      for (const name of DECORATIONS) {
        tab.removeAttribute(name);
      }
      tab.querySelector(".zlg-toggle")?.remove();
    }

    #ensureToggle(tab, count) {
      const content = tab.querySelector(".tab-content");
      if (!content) {
        return;
      }
      let toggle = content.querySelector(":scope > .zlg-toggle");
      if (!toggle) {
        toggle = document.createXULElement("hbox");
        toggle.className = "zlg-toggle";
        toggle.setAttribute("role", "button");
        toggle.setAttribute("align", "center");
        const twisty = document.createXULElement("image");
        twisty.className = "zlg-twisty";
        const label = document.createXULElement("label");
        label.className = "zlg-count";
        toggle.append(label, twisty);
        for (const type of ["mousedown", "mouseup", "click", "dblclick"]) {
          toggle.addEventListener(type, this.#onToggleEvent);
        }
        const close = content.querySelector(":scope > .tab-close-button");
        content.insertBefore(toggle, close);
      }
      setAttr(toggle.querySelector(".zlg-count"), "value", count);
      setAttr(toggle, "tooltiptext", t.toggleTooltip(count));
    }

    /** The toggle must not select, drag, rename or close the tab under it. */
    #onToggleEvent = event => {
      event.stopPropagation();
      event.preventDefault();
      if (event.type === "click" && event.button === 0) {
        this.toggleCollapsed(event.currentTarget.closest(".tabbrowser-tab")?.id);
      }
    };

    /* Context menu */

    #initContextMenu() {
      const menu = document.getElementById("tabContextMenu");
      if (!menu) {
        return;
      }
      const item = (id, onCommand) => {
        const el = document.createXULElement("menuitem");
        el.id = id;
        el.addEventListener("command", () => {
          const tab = this.#menuTab;
          const gid = store.groupOf(tab?.id);
          if (gid) {
            onCommand(tab, gid);
          }
        });
        return el;
      };
      const separator = document.createXULElement("menuseparator");
      separator.id = "zlg-context-separator";
      this.#menu = {
        collapse: item("zlg-context-collapse", (_tab, gid) => this.toggleCollapsed(gid)),
        remove: item("zlg-context-remove", tab => this.removeFromGroup(tab)),
        ungroup: item("zlg-context-ungroup", (_tab, gid) => this.ungroup(gid)),
        close: item("zlg-context-close", (_tab, gid) => this.closeGroup(gid)),
        separator,
      };
      this.#menu.remove.setAttribute("label", t.removeFromGroup);
      this.#menu.ungroup.setAttribute("label", t.ungroup);
      this.#menu.close.setAttribute("label", t.closeGroup);
      // Right above "Close Tab"; the whole block hides for ungrouped tabs.
      const anchor = document.getElementById("context_closeTab");
      const nodes = Object.values(this.#menu);
      if (anchor?.parentNode === menu) {
        for (const node of nodes) {
          menu.insertBefore(node, anchor);
        }
      } else {
        menu.append(...nodes);
      }
      menu.addEventListener("popupshowing", this);
    }

    #updateContextMenu(menu) {
      // Same lookup as Firefox's TabContextMenu, without depending on which
      // popupshowing listener runs first.
      const trigger = menu.triggerNode;
      const tab = trigger?.tab ?? trigger?.closest?.(".tabbrowser-tab") ?? gBrowser.selectedTab;
      this.#menuTab = tab;
      const gid = tab?.id ? store.groupOf(tab.id) : null;
      for (const node of Object.values(this.#menu)) {
        node.hidden = !gid;
      }
      if (!gid) {
        return;
      }
      this.#menu.collapse.setAttribute("label", store.info(gid)?.collapsed ? t.expand : t.collapse);
      this.#menu.remove.hidden = store.isRoot(tab.id);
    }
  }

  window.gZenLinkGroups = new ZenLinkGroups();
  /** Resolves once the window listens to tabs (used by the e2e test). */
  window.gZenLinkGroups.initialized = window.gZenLinkGroups
    .init()
    .catch(error => console.error("[ZenLinkGroups] init failed", error));
})();
