/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Pure group logic for Zen Link Groups. No Gecko APIs here, so it runs
 * under `node --test` as well as in the browser.
 *
 * Terms:
 *  - root:   the tab the links were opened from (the group's parent).
 *  - member: a tab opened from the root, directly or through another member.
 *            Groups are flat: a link opened from a member joins the root.
 *  - item:   one top-level entry of a tab section, in visual order:
 *            { id, root, isRoot } for a tab, { opaque: true } for anything
 *            that is not a plain tab (a split view, a folder) and breaks runs.
 */

export const PALETTE_SIZE = 8;

/** Least used palette slot, lowest index on ties. */
export function pickColor(usedColors, size = PALETTE_SIZE) {
  const counts = new Array(size).fill(0);
  for (const color of usedColors) {
    if (Number.isInteger(color) && color >= 0 && color < size) {
      counts[color]++;
    }
  }
  let best = 0;
  for (let i = 1; i < size; i++) {
    if (counts[i] < counts[best]) {
      best = i;
    }
  }
  return best;
}

/**
 * Membership state shared by all windows: member id -> root id, and per-root
 * metadata. A root exists in `groups` only while it has at least one member.
 */
export class GroupState {
  /** @type {Map<string, string>} member id -> root id */
  members = new Map();
  /** @type {Map<string, {color: number, collapsed: boolean}>} */
  groups = new Map();

  rootOf(id) {
    return this.members.get(id) ?? null;
  }

  isRoot(id) {
    return this.groups.has(id);
  }

  groupOf(id) {
    return this.isRoot(id) ? id : this.rootOf(id);
  }

  info(rootId) {
    return this.groups.get(rootId) ?? null;
  }

  roots() {
    return [...this.groups.keys()];
  }

  /** Members of a root in the order they joined. */
  membersOf(rootId) {
    const result = [];
    for (const [member, root] of this.members) {
      if (root === rootId) {
        result.push(member);
      }
    }
    return result;
  }

  /**
   * Adds `childId` to the group of `openerId`. If the opener is itself a
   * member, the child joins the opener's root (flat groups).
   *
   * @returns {string|null} the root id, or null when nothing changed.
   */
  addMember(childId, openerId) {
    if (!childId || !openerId || childId === openerId) {
      return null;
    }
    if (this.isRoot(childId)) {
      // A tab that already leads a group never becomes someone's member.
      return null;
    }
    const root = this.rootOf(openerId) ?? openerId;
    if (root === childId || this.members.get(childId) === root) {
      return null;
    }
    const previousRoot = this.rootOf(childId);
    this.members.set(childId, root);
    if (previousRoot) {
      this.#dropRootIfEmpty(previousRoot);
    }
    if (!this.groups.has(root)) {
      const used = [...this.groups.values()].map(g => g.color);
      this.groups.set(root, { color: pickColor(used), collapsed: false });
    }
    return root;
  }

  /** @returns {boolean} whether anything changed. */
  removeMember(id) {
    const root = this.rootOf(id);
    if (!root) {
      return false;
    }
    this.members.delete(id);
    this.#dropRootIfEmpty(root);
    return true;
  }

  /**
   * Hands the group of a closing root to `successorId` (falls back to the
   * oldest member). A group left with a single tab is dissolved.
   *
   * @returns {string|null} the new root id.
   */
  promote(rootId, successorId) {
    const meta = this.groups.get(rootId);
    if (!meta) {
      return null;
    }
    const members = this.membersOf(rootId);
    const next = members.includes(successorId) ? successorId : members[0];
    this.groups.delete(rootId);
    this.members.delete(next);
    const rest = members.filter(id => id !== next);
    for (const id of rest) {
      this.members.set(id, next);
    }
    if (!rest.length) {
      return null;
    }
    this.groups.set(next, meta);
    return next;
  }

  /** Called when a tab closes. */
  forget(id, successorId = null) {
    if (this.isRoot(id)) {
      this.promote(id, successorId);
      return true;
    }
    return this.removeMember(id);
  }

  dissolve(rootId) {
    if (!this.groups.has(rootId)) {
      return false;
    }
    for (const id of this.membersOf(rootId)) {
      this.members.delete(id);
    }
    this.groups.delete(rootId);
    return true;
  }

  setCollapsed(rootId, collapsed) {
    const meta = this.groups.get(rootId);
    if (!meta || meta.collapsed === !!collapsed) {
      return false;
    }
    meta.collapsed = !!collapsed;
    return true;
  }

  /**
   * Drops everything that refers to tabs which no longer exist. A missing
   * root hands its group to its oldest surviving member.
   *
   * @param {Set<string>} liveIds
   * @returns {boolean} whether anything changed.
   */
  prune(liveIds) {
    let changed = false;
    for (const id of [...this.members.keys()]) {
      if (!liveIds.has(id)) {
        this.removeMember(id);
        changed = true;
      }
    }
    for (const root of this.roots()) {
      if (!liveIds.has(root)) {
        this.promote(root, null);
        changed = true;
      }
    }
    return changed;
  }

  #dropRootIfEmpty(root) {
    if (!this.membersOf(root).length) {
      this.groups.delete(root);
    }
  }

  toJSON() {
    return {
      version: 1,
      members: Object.fromEntries(this.members),
      groups: Object.fromEntries(this.groups),
    };
  }

  /** Tolerant loader: anything malformed is skipped, never thrown. */
  static fromJSON(data) {
    const state = new GroupState();
    if (!data || typeof data !== "object") {
      return state;
    }
    const groups = data.groups && typeof data.groups === "object" ? data.groups : {};
    for (const [root, meta] of Object.entries(groups)) {
      state.groups.set(root, {
        color: Number.isInteger(meta?.color) && meta.color >= 0 ? meta.color % PALETTE_SIZE : 0,
        collapsed: !!meta?.collapsed,
      });
    }
    const members = data.members && typeof data.members === "object" ? data.members : {};
    for (const [member, root] of Object.entries(members)) {
      if (typeof root === "string" && state.groups.has(root) && !state.groups.has(member)) {
        state.members.set(member, root);
      }
    }
    for (const root of state.roots()) {
      state.#dropRootIfEmpty(root);
    }
    return state;
  }
}

/** Group an item belongs to: its own id for a root, its root for a member. */
function gidOf(item) {
  if (!item || item.opaque) {
    return null;
  }
  return item.isRoot ? item.id : item.root ?? null;
}

/**
 * Maximal runs of adjacent items in the same group. A root always opens a new
 * run, so a member placed above its root forms a run of its own.
 *
 * @returns {Array<{gid: string, start: number, end: number, hasRoot: boolean}>}
 */
export function clusters(items) {
  const result = [];
  let current = null;
  items.forEach((item, index) => {
    const gid = gidOf(item);
    const startsNew = !current || gid !== current.gid || item.isRoot;
    if (!gid) {
      current = null;
      return;
    }
    if (startsNew) {
      current = { gid, start: index, end: index, hasRoot: !!item.isRoot };
      result.push(current);
    } else {
      current.end = index;
    }
  });
  return result;
}

/**
 * Picks the run that keeps a group's membership when the group is split:
 * the run holding the root, otherwise the one with most members the user did
 * not just move (then the biggest, then the first).
 */
function anchorOf(groupClusters, items, touched) {
  const withRoot = groupClusters.find(c => c.hasRoot);
  if (withRoot) {
    return withRoot;
  }
  let best = null;
  let bestScore = null;
  for (const c of groupClusters) {
    let untouched = 0;
    for (let i = c.start; i <= c.end; i++) {
      if (!touched.has(items[i].id)) {
        untouched++;
      }
    }
    const score = [untouched, c.end - c.start + 1];
    if (!best || score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Re-derives membership of one tab section from its visual order, after the
 * user moved tabs or new tabs appeared.
 *
 *  - Ungrouped tabs the user dropped between two tabs of one group join it.
 *  - Members cut off from their group's main run leave the group.
 *  - Members whose root sits in another normal section leave the group.
 *
 * @param {Array} items  section items in visual order.
 * @param {object} ctx
 * @param {Set<string>} ctx.touched  ids the user just moved or opened.
 * @param {(rootId: string) => "here"|"elsewhere"|"other-section"|"missing"} ctx.rootPlacement
 *        where the root is: in this section, outside any normal section
 *        (pinned, Essentials, split view), in another normal section, or gone.
 * @returns {{join: Array<[string, string]>, leave: string[]}}
 */
export function reconcileSection(items, { touched = new Set(), rootPlacement = () => "here" } = {}) {
  const work = items.map(item => ({ ...item }));

  // 1. Ungrouped tabs dropped inside a group join it.
  let i = 0;
  while (i < work.length) {
    if (work[i].opaque || gidOf(work[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < work.length && !work[j + 1].opaque && !gidOf(work[j + 1])) {
      j++;
    }
    const before = gidOf(work[i - 1]);
    const after = gidOf(work[j + 1]);
    const allTouched = work.slice(i, j + 1).every(item => touched.has(item.id));
    if (before && before === after && !work[j + 1].isRoot && allTouched) {
      for (let k = i; k <= j; k++) {
        work[k].root = before;
      }
    }
    i = j + 1;
  }

  // 2. Keep one run per group, release the rest.
  const byGroup = new Map();
  for (const c of clusters(work)) {
    if (!byGroup.has(c.gid)) {
      byGroup.set(c.gid, []);
    }
    byGroup.get(c.gid).push(c);
  }
  for (const [gid, groupClusters] of byGroup) {
    const placement = rootPlacement(gid);
    const keep = placement === "other-section" ? null : anchorOf(groupClusters, work, touched);
    for (const c of groupClusters) {
      if (c === keep) {
        continue;
      }
      for (let k = c.start; k <= c.end; k++) {
        if (!work[k].isRoot) {
          work[k].root = null;
        }
      }
    }
  }

  const join = [];
  const leave = [];
  work.forEach((item, index) => {
    const before = items[index];
    if (item.opaque || item.isRoot) {
      return;
    }
    if (item.root && item.root !== before.root) {
      join.push([item.id, item.root]);
    } else if (!item.root && before.root) {
      leave.push(item.id);
    }
  });
  return { join, leave };
}

/**
 * Members of `rootId` that should follow it after the user moved the root:
 * those outside the root's run that the user did not move themselves.
 *
 * @returns {{after: string|null, ids: string[]}} move `ids` after `after`.
 */
export function planFollow(items, rootId, touched = new Set()) {
  const rootCluster = clusters(items).find(c => c.gid === rootId && c.hasRoot);
  if (!rootCluster) {
    return { after: null, ids: [] };
  }
  const ids = [];
  items.forEach((item, index) => {
    const outside = index < rootCluster.start || index > rootCluster.end;
    if (outside && !item.opaque && !item.isRoot && item.root === rootId && !touched.has(item.id)) {
      ids.push(item.id);
    }
  });
  return { after: items[rootCluster.end].id, ids };
}

/**
 * Where a newly opened member should go so it sits next to its group.
 *
 * @returns {string|null} id to move the tab after, or null if it is fine.
 */
export function placementTarget(items, tabId) {
  const index = items.findIndex(item => item.id === tabId);
  if (index < 0) {
    return null;
  }
  const gid = gidOf(items[index]);
  if (!gid) {
    return null;
  }
  const others = items.map((item, k) => (k === index ? { opaque: true } : item));
  const groupClusters = clusters(others).filter(c => c.gid === gid);
  if (!groupClusters.length) {
    return null;
  }
  const adjacent = groupClusters.some(c => c.end === index - 1 || c.start === index + 1);
  if (adjacent) {
    return null;
  }
  const anchor = anchorOf(groupClusters, others, new Set());
  return others[anchor.end].id;
}

/**
 * Decoration for every grouped item of one section.
 *
 * @param {Array} items
 * @param {object} ctx
 * @param {(rootId: string) => boolean} ctx.isCollapsed
 * @param {string|null} ctx.selectedId  the selected tab stays visible in a collapsed group.
 * @returns {Map<string, {role: "root"|"member", gid: string, trunk?: boolean,
 *          first?: boolean, last?: boolean, orphan?: boolean, hidden?: boolean}>}
 *          `trunk` marks a root with visible members right below it.
 */
export function layout(items, { isCollapsed = () => false, selectedId = null } = {}) {
  const result = new Map();
  for (const c of clusters(items)) {
    const collapsed = isCollapsed(c.gid);
    const visibleMembers = [];
    let root = null;
    for (let k = c.start; k <= c.end; k++) {
      const item = items[k];
      if (item.isRoot) {
        root = { role: "root", gid: c.gid, trunk: false };
        result.set(item.id, root);
        continue;
      }
      const hidden = collapsed && item.id !== selectedId;
      result.set(item.id, { role: "member", gid: c.gid, hidden });
      if (!hidden) {
        visibleMembers.push(item.id);
      }
    }
    if (visibleMembers.length) {
      if (root) {
        root.trunk = true;
      }
      const first = result.get(visibleMembers[0]);
      first.first = true;
      first.orphan = !c.hasRoot;
      result.get(visibleMembers.at(-1)).last = true;
    }
  }
  return result;
}
