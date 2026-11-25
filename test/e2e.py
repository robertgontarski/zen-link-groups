#!/usr/bin/env python3
"""End-to-end check of Zen Link Groups in a throwaway, headless Zen.

Nothing touches your real profile or the Zen.app bundle: the script builds a
temporary profile, starts Zen with Marionette, registers fx-autoconfig at
runtime (what config.js does on a real install), opens a fresh window so the
loader injects the mod, then clicks real links (target=_blank and cmd+click)
and checks the groups. It finally restarts Zen on the same profile to check
that groups survive a restart. Sidebar screenshots go to the output directory.

    python3 -I test/e2e.py [--zen /Applications/Zen.app] [--out DIR] [--headed]
                           [--layout fx-autoconfig|sine]

`--layout sine` checks the mod the way the Sine mod manager installs it,
without running Sine itself: the repository sits in chrome/sine-mods/<id>,
is served as chrome://sine/content/<id>/, the script declared in theme.json
is loaded into each window, and the style is applied as a user sheet.

Standard library only.
"""

import argparse
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "test" / "fixtures"
PORT = 28283
ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf"
META_KEY = ""

PREFS = {
    "marionette.port": PORT,
    "zen.welcome-screen.seen": True,
    "zen.updates.show-update-notification": False,
    "browser.shell.checkDefaultBrowser": False,
    "browser.startup.page": 3,
    "browser.tabs.warnOnClose": False,
    "browser.warnOnQuit": False,
    # target=_blank links open in the background, like cmd+click.
    "browser.tabs.loadDivertedInBackground": True,
    "browser.link.open_newwindow": 3,
    "userChromeJS.firstRunShown": True,
    # Retina-like screenshots.
    "layout.css.devPixelsPerPx": "2.0",
}


class MarionetteError(Exception):
    pass


class Marionette:
    """Just enough of the Marionette protocol: length-prefixed JSON."""

    def __init__(self, port, timeout=60):
        deadline = time.time() + timeout
        while True:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.3)
        self.sock.settimeout(120)
        self.msg_id = 0
        self._read()  # server hello

    def _read(self):
        header = b""
        while not header.endswith(b":"):
            chunk = self.sock.recv(1)
            if not chunk:
                raise MarionetteError("connection closed")
            header += chunk
        length = int(header[:-1])
        body = b""
        while len(body) < length:
            chunk = self.sock.recv(length - len(body))
            if not chunk:
                raise MarionetteError("connection closed")
            body += chunk
        return json.loads(body)

    def send(self, name, params=None):
        self.msg_id += 1
        payload = json.dumps([0, self.msg_id, name, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._read()
            if msg[0] == 1 and msg[1] == self.msg_id:
                if msg[2]:
                    raise MarionetteError(f"{name}: {msg[2]}")
                return msg[3]

    def context(self, value):
        self.send("Marionette:SetContext", {"value": value})

    def js(self, script, *args):
        """Runs `script` (an async function body) in the current chrome window."""
        wrapped = f"return (async function () {{\n{script}\n}}).apply(this, arguments);"
        return self.send("WebDriver:ExecuteScript", {"script": wrapped, "args": list(args)})["value"]

    def wait(self, condition, *args, timeout=10, message="condition"):
        deadline = time.time() + timeout
        while True:
            value = self.js(condition, *args)
            if value:
                return value
            if time.time() > deadline:
                raise AssertionError(f"timed out waiting for {message}")
            time.sleep(0.1)

    def window_handles(self):
        handles = self.send("WebDriver:GetWindowHandles")
        return handles.get("value", handles) if isinstance(handles, dict) else handles


def build_profile(path, layout):
    shutil.rmtree(path, ignore_errors=True)
    chrome = path / "chrome"
    if layout == "sine":
        # What Sine leaves in a profile: the mod's repository under
        # sine-mods/<id>, its bootloader's mapping of that folder to
        # chrome://sine/content/, and one sheet importing every mod's style.
        theme = json.loads((ROOT / "theme.json").read_text())
        mod = chrome / "sine-mods" / theme["id"]
        shutil.copytree(ROOT / "src", mod / "src")
        shutil.copy(ROOT / "theme.json", mod)
        (chrome / "utils").mkdir(parents=True)
        (chrome / "utils" / "chrome.manifest").write_text("content sine ../sine-mods/\n")
        style = (mod / theme["style"]["chrome"]).as_uri()
        (chrome / "sine-mods" / "chrome.css").write_text(f'@import "{style}";\n')
    else:
        shutil.copytree(ROOT / "vendor" / "fx-autoconfig" / "profile" / "chrome" / "utils", chrome / "utils")
        shutil.copytree(ROOT / "src" / "JS", chrome / "JS")
        shutil.copytree(ROOT / "src" / "CSS", chrome / "CSS")
    lines = [f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k, v in PREFS.items()]
    (path / "user.js").write_text("\n".join(lines) + "\n")


def describe_layout(layout, profile):
    """Where the store module lives, and what the harness has to inject."""
    if layout != "sine":
        # fx-autoconfig injects the script and the style into new windows itself.
        return {"store": "chrome://userscripts/content/zen-link-groups/store.sys.mjs", "inject": None}
    theme = json.loads((ROOT / "theme.json").read_text())
    (script,) = theme["scripts"]
    base = f"chrome://sine/content/{theme['id']}/"
    return {
        "store": f"{base}{script.rpartition('/')[0]}/zen-link-groups/store.sys.mjs",
        "inject": {
            "script": base + script,
            "sheet": (profile / "chrome" / "sine-mods" / "chrome.css").as_uri(),
        },
    }


# --- chrome-side snippets -------------------------------------------------

WAIT_FOR_ZEN = (
    "return typeof gZenWorkspaces !== 'undefined' && gBrowser.tabs.length > 0 &&"
    " gZenWorkspaces.promiseInitialized.then(() => true)"
)

# What config.js does at startup, then a new window for the loader to inject.
REGISTER_MANIFEST = """
const manifest = Services.dirsvc.get("UChrm", Ci.nsIFile);
manifest.append("utils");
manifest.append("chrome.manifest");
Components.manager.QueryInterface(Ci.nsIComponentRegistrar).autoRegister(manifest);
"""

BOOT_LOADER = """
ChromeUtils.importESModule("chrome://userchromejs/content/boot.sys.mjs");
"""

# `arguments[0]`, when set, is what Sine's manager does for a window on load.
OPEN_MOD_WINDOW = """
const win = OpenBrowserWindow();
await new Promise(resolve => win.addEventListener("load", resolve, { once: true }));
const inject = arguments[0];
if (inject) {
  Services.scriptloader.loadSubScriptWithOptions(inject.script, { target: win, ignoreCache: true });
  win.windowUtils.loadSheet(Services.io.newURI(inject.sheet), win.windowUtils.USER_SHEET);
}
for (let i = 0; i < 100 && !win.gZenLinkGroups; i++) {
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!win.gZenLinkGroups) {
  throw new Error("mod was not injected into the new window");
}
await win.gZenLinkGroups.initialized;
return true;
"""

HANDLE_OF = """
function handleOf(tab) {
  for (const [url, name] of [
    ["chrome://remote/content/shared/NavigableManager.sys.mjs", "NavigableManager"],
    ["chrome://remote/content/shared/TabManager.sys.mjs", "TabManager"],
  ]) {
    try {
      const id = ChromeUtils.importESModule(url)[name].getIdForBrowser(tab.linkedBrowser);
      if (id) return String(id);
    } catch (e) {}
  }
  throw new Error("cannot resolve the Marionette handle of a tab");
}
"""

NEW_TAB = HANDLE_OF + """
const tab = gBrowser.addTrustedTab("about:blank", { inBackground: false });
gBrowser.selectedTab = tab;
return handleOf(tab);
"""

TAB_BY_TITLE = HANDLE_OF + """
const tab = gBrowser.tabs.find(t => t.label === arguments[0] && !t.closing);
return tab ? handleOf(tab) : null;
"""

# Unpinned tabs of the section holding `arguments[0]`, in visual order.
STATE = """
const anchor = gBrowser.tabs.find(t => t.label === arguments[0] && !t.closing && !t.pinned)
  ?? gBrowser.tabs.find(t => !t.pinned && !t.closing);
return [...anchor.parentElement.children]
  .filter(el => el.classList?.contains("tabbrowser-tab") && !el.closing && !el.hasAttribute("zen-empty-tab"))
  .map(t => ({
    label: t.label,
    role: t.getAttribute("zlg-role"),
    color: t.getAttribute("zlg-color"),
    trunk: t.hasAttribute("zlg-trunk"),
    first: t.hasAttribute("zlg-first"),
    last: t.hasAttribute("zlg-last"),
    orphan: t.hasAttribute("zlg-orphan"),
    hidden: t.hasAttribute("zlg-hidden"),
    collapsed: t.hasAttribute("zlg-collapsed"),
    pinned: t.pinned,
    count: t.querySelector(".zlg-count")?.getAttribute("value") ?? null,
    selected: t.selected,
  }));
"""

# Root label -> sorted member labels, for the whole window.
GROUPS = """
const byId = new Map(gBrowser.tabs.map(t => [t.id, t]));
const { LinkGroupsStore } = ChromeUtils.importESModule(arguments[0]);
const result = {};
for (const rootId of LinkGroupsStore.roots()) {
  const root = byId.get(rootId);
  result[root?.label ?? "?" + rootId] = LinkGroupsStore.membersOf(rootId)
    .map(id => byId.get(id)?.label ?? "?" + id)
    .sort();
}
return result;
"""

# What the stylesheet makes of a group: the trunk under the root, the line and
# the elbow next to its members, the badge, the indent.
DRAWN = """
const root = gBrowser.tabs.find(t => t.label === arguments[0] && !t.closing);
const members = gBrowser.tabs.filter(t => t.getAttribute("zlg-role") === "member" && !t.closing);
const line = el => {
  const style = getComputedStyle(el, el === root ? "::after" : "::before");
  return [style.content, style.position, style.borderInlineStartWidth, style.borderInlineStartStyle].join(" ");
};
const first = getComputedStyle(members[0], "::before");
const badge = getComputedStyle(root.querySelector(".zlg-toggle"));
return {
  trunk: line(root),
  line: line(members[0]),
  elbow: getComputedStyle(members.find(t => t.hasAttribute("zlg-last")), "::before").borderBottomStyle,
  lineColor: first.borderInlineStartColor,
  badgeColor: badge.backgroundColor,
  countMargin: getComputedStyle(root.querySelector(".zlg-count")).margin,
  indent: getComputedStyle(members[0]).getPropertyValue("--zen-folder-indent").trim(),
};
"""

RENDERED_GROUPS = """
const result = {};
const roots = gBrowser.tabs.filter(t => t.getAttribute("zlg-role") === "root");
for (const root of roots) {
  const color = root.getAttribute("zlg-color");
  result[root.label] = gBrowser.tabs
    .filter(t => t.getAttribute("zlg-role") === "member" && t.getAttribute("zlg-color") === color)
    .map(t => t.label)
    .sort();
}
return result;
"""


# Opens the tab context menu on a tab, reports which of our items are hidden,
# optionally runs one of them.
CONTEXT_MENU = """
const tab = gBrowser.tabs.find(t => t.label === arguments[0] && !t.closing);
const menu = document.getElementById("tabContextMenu");
const shown = new Promise(resolve => menu.addEventListener("popupshown", resolve, { once: true }));
// A right click on the middle of the tab, as EventUtils does it.
tab.scrollIntoView({ block: "center" });
const r = tab.getBoundingClientRect();
tab.dispatchEvent(new MouseEvent("contextmenu", {
  bubbles: true,
  cancelable: true,
  button: 2,
  clientX: r.left + r.width / 2,
  clientY: r.top + r.height / 2,
  view: window,
}));
await shown;
const ids = ["zlg-context-collapse", "zlg-context-remove", "zlg-context-ungroup", "zlg-context-close"];
const hidden = Object.fromEntries(ids.map(id => [id, document.getElementById(id).hidden]));
if (arguments[1]) {
  document.getElementById(arguments[1]).doCommand();
}
const hiddenEvent = new Promise(resolve => menu.addEventListener("popuphidden", resolve, { once: true }));
menu.hidePopup();
await hiddenEvent;
await new Promise(resolve => setTimeout(resolve, 600));
return hidden;
"""


# Errors and console.error calls coming from the mod.
MOD_ERRORS = """
const pattern = /zenLinkGroups|zen-link-groups|ZenLinkGroups/;
// The test profile may sit in a directory named after the mod: a path into it
// is not a mention of the mod.
const mentionsMod = text => pattern.test(text.replaceAll(PathUtils.profileDir, "<profile>"));
const fromConsoleService = Services.console.getMessageArray()
  .filter(m => m instanceof Ci.nsIScriptError && !(m.flags & Ci.nsIScriptError.warningFlag))
  .map(m => `${m.sourceName}:${m.lineNumber} ${m.errorMessage}`)
  .filter(mentionsMod);
const storage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(Ci.nsIConsoleAPIStorage);
const fromConsoleApi = storage.getEvents()
  .filter(e => e.level === "error")
  .map(e => `${e.filename}:${e.lineNumber} ${(e.arguments || []).map(String).join(" ")}`)
  .filter(mentionsMod);
return [...fromConsoleService, ...fromConsoleApi];
"""

class Run:
    def __init__(self, m, out, layout):
        self.m = m
        self.out = out
        self.layout = layout
        self.failures = []
        self.shots = 0

    # browser helpers

    def chrome_window(self):
        self.m.context("chrome")

    def open_page(self, name, title):
        handle = self.m.js(NEW_TAB)
        self.m.context("content")
        self.m.send("WebDriver:SwitchToWindow", {"handle": handle, "focus": True})
        self.m.send("WebDriver:Navigate", {"url": (FIXTURES / name).as_uri()})
        self.chrome_window()
        # The tab label follows the page title a moment after the load.
        self.m.wait(
            "return gBrowser.tabs.some(t => t.label === arguments[0])", title, message=f"tab {title!r}"
        )

    def click(self, tab_title, selector, cmd=False):
        handle = self.m.js(TAB_BY_TITLE, tab_title)
        assert handle, f"no tab titled {tab_title!r}"
        count = self.m.js("return gBrowser.tabs.length")
        self.m.context("content")
        self.m.send("WebDriver:SwitchToWindow", {"handle": handle, "focus": True})
        el = self.m.send("WebDriver:FindElement", {"using": "css selector", "value": selector})["value"]
        if cmd:
            pause = {"type": "pause", "duration": 0}
            self.m.send("WebDriver:PerformActions", {"actions": [
                {"type": "key", "id": "keyboard", "actions": [
                    {"type": "keyDown", "value": META_KEY}, pause, pause, pause,
                    {"type": "keyUp", "value": META_KEY},
                ]},
                {"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
                    pause,
                    {"type": "pointerMove", "origin": {ELEMENT_KEY: el[ELEMENT_KEY]}, "x": 0, "y": 0},
                    {"type": "pointerDown", "button": 0},
                    {"type": "pointerUp", "button": 0},
                    pause,
                ]},
            ]})
            self.m.send("WebDriver:ReleaseActions")
        else:
            self.m.send("WebDriver:ElementClick", {"id": el[ELEMENT_KEY]})
        self.chrome_window()
        self.m.wait("return gBrowser.tabs.length > arguments[0]", count, message=f"tab from {selector}")
        self.m.wait(
            "return !gBrowser.tabs.some(t => t.hasAttribute('busy') || t.label.endsWith('.html'))",
            message="new tab title",
        )
        self.settle()

    def settle(self, seconds=0.6):
        # Lets Zen place the tab and the mod reconcile and repaint.
        time.sleep(seconds)

    def state(self, anchor="News"):
        return self.m.js(STATE, anchor)

    def groups(self):
        return self.m.js(GROUPS, self.layout["store"])

    def tab_eval(self, title, body, *extra):
        return self.m.js(
            "const tab = gBrowser.tabs.find(t => t.label === arguments[0] && !t.closing);"
            "if (!tab) throw new Error('no tab ' + arguments[0]);" + body,
            title,
            *extra,
        )

    def move_after(self, title, target_title):
        """A tab move as the user's drag-and-drop ends it."""
        self.tab_eval(
            title,
            "gBrowser.moveTabAfter(tab, gBrowser.tabs.find(t => t.label === arguments[1] && !t.closing));"
            "return true;",
            target_title,
        )
        self.settle()

    def screenshot(self, name):
        self.shots += 1
        self.chrome_window()
        el = self.m.send("WebDriver:FindElement", {"using": "css selector", "value": "#navigator-toolbox"})["value"]
        data = self.m.send("WebDriver:TakeScreenshot", {"id": el[ELEMENT_KEY], "full": False, "hash": False})
        path = self.out / f"{self.shots:02d}-{name}.png"
        path.write_bytes(base64.b64decode(data["value"]))
        return path

    # assertions

    def check(self, label, condition, detail=""):
        status = "ok  " if condition else "FAIL"
        print(f"  [{status}] {label}" + (f" -- {detail}" if detail and not condition else ""))
        if not condition:
            self.failures.append(label)

    @staticmethod
    def by_label(state):
        return {t["label"]: t for t in state}

    @staticmethod
    def order(state):
        return [t["label"] for t in state]


def scenario(run):
    print("1. Links from one tab group under it")
    run.open_page("mail.html", "Mail")
    run.open_page("news.html", "News")
    for link in ("#l1", "#l2", "#l3"):
        run.click("News", link)
    s = run.state()
    tabs = run.by_label(s)
    run.check("News is the root with a trunk", tabs["News"]["role"] == "root" and tabs["News"]["trunk"], tabs["News"])
    run.check("three articles are members", all(tabs[f"Article {i}"]["role"] == "member" for i in (1, 2, 3)), s)
    run.check("count badge says 3", tabs["News"]["count"] == "3", tabs["News"])
    members = [t for t in s if t["role"] == "member"]
    order = run.order(s)
    run.check("members sit right under News", order.index("News") + 1 == order.index(members[0]["label"]), order)
    run.check("first and last members are marked", members[0]["first"] and members[-1]["last"], members)
    run.check("unrelated Mail tab stays ungrouped", tabs["Mail"]["role"] is None, tabs["Mail"])
    drawn = run.m.js(DRAWN, "News")
    solid = '"" absolute 2px solid'
    run.check("the trunk and the member line are drawn", drawn["trunk"] == solid and drawn["line"] == solid, drawn)
    run.check("the last member gets an elbow", drawn["elbow"] == "solid", drawn)
    run.check("the badge has the color of the line", drawn["badgeColor"] == drawn["lineColor"], drawn)
    run.check("the count sits tight in the badge", drawn["countMargin"] == "0px", drawn)
    run.check("members are indented", drawn["indent"] == "18px", drawn)
    run.screenshot("group")

    print("2. A link from a member joins the same flat group")
    run.click("Article 1", "#deeper")
    tabs = run.by_label(run.state())
    run.check(
        "Deep dive is a member of News's group",
        tabs["Deep dive"]["role"] == "member" and tabs["Deep dive"]["color"] == tabs["News"]["color"],
        tabs["Deep dive"],
    )
    run.check("count badge says 4", tabs["News"]["count"] == "4", tabs["News"])

    print("3. A second group, also from cmd+click on a plain link")
    run.open_page("forum.html", "Forum")
    run.click("Forum", "#f1")
    run.click("Forum", "#f2")
    run.click("Forum", "#f3", cmd=True)
    tabs = run.by_label(run.state())
    run.check("Forum is a root", tabs["Forum"]["role"] == "root", tabs["Forum"])
    run.check("cmd+click opened Thread 3 into the group", tabs.get("Thread 3", {}).get("role") == "member", tabs.get("Thread 3"))
    run.check("count badge says 3", tabs["Forum"]["count"] == "3", tabs["Forum"])
    run.check(
        "groups differ in color",
        tabs["Forum"]["color"] != tabs["News"]["color"],
        (tabs["Forum"]["color"], tabs["News"]["color"]),
    )
    run.screenshot("two-groups")

    print("4. Collapse from the toggle keeps the selection")
    run.tab_eval("Mail", "gBrowser.selectedTab = tab; return true;")
    run.settle(0.3)
    run.tab_eval("News", "tab.querySelector('.zlg-toggle').click(); return true;")
    run.settle()
    s = run.state()
    tabs = run.by_label(s)
    run.check("News is collapsed", tabs["News"]["collapsed"], tabs["News"])
    news_members = [t for t in s if t["role"] == "member" and t["color"] == tabs["News"]["color"]]
    run.check("its members are hidden", news_members and all(t["hidden"] for t in news_members), s)
    run.check("clicking the toggle did not select News", tabs["Mail"]["selected"], tabs["Mail"])
    run.screenshot("collapsed")
    run.tab_eval("News", "tab.querySelector('.zlg-toggle').click(); return true;")
    run.settle()
    run.check("expands again", not run.by_label(run.state())["Article 2"]["hidden"])

    print("5. Dragging a member out removes it from the group")
    run.move_after("Article 2", "Thread 3")
    tabs = run.by_label(run.state())
    run.check("Article 2 left the group", tabs["Article 2"]["role"] is None, tabs["Article 2"])
    run.check("Forum did not swallow it (dropped at its end)", tabs["Forum"]["count"] == "3", tabs["Forum"])

    print("6. Dragging a tab into the middle of a group adds it")
    run.move_after("Mail", "Thread 1")
    tabs = run.by_label(run.state())
    run.check(
        "Mail joined Forum's group",
        tabs["Mail"]["role"] == "member" and tabs["Mail"]["color"] == tabs["Forum"]["color"],
        tabs["Mail"],
    )

    print("7. Moving a root takes its members along")
    run.move_after("News", "Article 2")
    run.settle(0.4)
    s = run.state()
    order = run.order(s)
    color = run.by_label(s)["News"]["color"]
    news_members = [t["label"] for t in s if t["role"] == "member" and t["color"] == color]
    following = order[order.index("News") + 1 : order.index("News") + 1 + len(news_members)]
    # Article 1, Deep dive, Article 3 (Article 2 left in step 5).
    run.check("members follow News", news_members == following and len(news_members) == 3, order)
    run.screenshot("moved-root")

    print("7b. Undo close tab restores a member to its group")
    run.tab_eval("Deep dive", "gBrowser.removeTab(tab, { animate: false }); return true;")
    run.settle()
    run.m.js("SessionStore.undoCloseTab(window, 0); return true;")
    run.m.wait("return gBrowser.tabs.some(t => t.label === 'Deep dive' && !t.closing)", message="reopened tab")
    run.settle(1.0)
    tabs = run.by_label(run.state())
    run.check(
        "Deep dive is back in News's group",
        tabs["Deep dive"]["role"] == "member" and tabs["Deep dive"]["color"] == tabs["News"]["color"],
        tabs["Deep dive"],
    )

    print("8. Closing the root hands the group to its first member")
    run.tab_eval("News", "gBrowser.removeTab(tab, { animate: false }); return true;")
    run.settle()
    s = run.state("Article 1")
    new_root = next((t for t in s if t["role"] == "root" and t["color"] == color), None)
    run.check("a member became the root and kept the color", new_root is not None, s)
    run.check("the rest stay members", new_root and new_root["count"] == "2", new_root)
    run.screenshot("promoted")

    print("9. A pinned root keeps its group in the tab list")
    run.tab_eval("Forum", "gBrowser.pinTab(tab); return true;")
    run.settle()
    forum = run.m.js(
        "const t = gBrowser.tabs.find(t => t.label === 'Forum');"
        "return { pinned: t.pinned, role: t.getAttribute('zlg-role') };"
    )
    s = run.state("Thread 1")
    forum_members = [t for t in s if t["role"] == "member" and t["label"] in ("Thread 1", "Mail", "Thread 2", "Thread 3")]
    run.check("Forum is pinned and still a root", forum["pinned"] and forum["role"] == "root", forum)
    run.check("its members stay grouped", len(forum_members) == 4, s)
    run.check("their run starts as an orphan", forum_members and forum_members[0]["orphan"], forum_members[:1])
    run.screenshot("pinned-root")

    print("10. Collapsed sidebar")
    run.m.js("Services.prefs.setBoolPref('zen.view.sidebar-expanded', false); return true;")
    run.settle()
    run.screenshot("sidebar-collapsed")
    run.m.js("Services.prefs.setBoolPref('zen.view.sidebar-expanded', true); return true;")
    run.settle()

    print("11. The state is saved to the profile")
    saved = run.m.js(
        "const { LinkGroupsStore } = ChromeUtils.importESModule(arguments[0]);"
        "await LinkGroupsStore.flush();"
        "return IOUtils.readJSON(PathUtils.join(PathUtils.profileDir, 'zen-link-groups.json'));",
        run.layout["store"],
    )
    run.check("file lists two groups", len(saved.get("groups", {})) == 2, saved)

    print("12. A second synced window shows the same groups")
    expected = run.groups()
    run.m.js(OPEN_MOD_WINDOW, run.layout["inject"])
    run.settle(1.5)
    run.m.send("WebDriver:SwitchToWindow", {"handle": run.m.window_handles()[-1], "focus": True})
    rendered = run.m.js(RENDERED_GROUPS)
    run.check("second window renders the same groups", rendered == expected, (rendered, expected))
    run.screenshot("second-window")
    return expected


def start_zen(args, profile, layout, log_name):
    binary = Path(args.zen) / "Contents" / "MacOS" / "zen"
    cmd = [str(binary), "--marionette", "-no-remote", "-profile", str(profile)]
    if not args.headed:
        cmd += ["--headless", "--window-size=1280,860"]
    env = {**os.environ, "MOZ_CRASHREPORTER_DISABLE": "1", "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"}
    log = open(args.out / log_name, "w")
    proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, env=env)
    m = Marionette(PORT)
    m.send("WebDriver:NewSession", {"capabilities": {}})
    m.context("chrome")
    m.wait(WAIT_FOR_ZEN, timeout=60, message="Zen startup")
    m.js(REGISTER_MANIFEST)
    if not layout["inject"]:
        m.js(BOOT_LOADER)
    m.js(OPEN_MOD_WINDOW, layout["inject"])
    m.send("WebDriver:SwitchToWindow", {"handle": m.window_handles()[-1], "focus": True})
    return proc, m, log


def stop_zen(proc, m, log, graceful):
    try:
        m.send("Marionette:Quit", {"flags": ["eAttemptQuit" if graceful else "eForceQuit"]})
    except Exception:
        pass
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--zen", default="/Applications/Zen.app")
    parser.add_argument("--out", type=Path, default=Path(tempfile.gettempdir()) / "zen-link-groups-e2e")
    parser.add_argument("--headed", action="store_true", help="show the window instead of running headless")
    parser.add_argument(
        "--layout",
        choices=("fx-autoconfig", "sine"),
        default="fx-autoconfig",
        help="install the mod as install.sh does, or as the Sine mod manager does",
    )
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    for old in args.out.glob("*.png"):
        old.unlink()
    profile = args.out / "profile"
    build_profile(profile, args.layout)
    layout = describe_layout(args.layout, profile)

    proc, m, log = start_zen(args, profile, layout, "zen.log")
    run = Run(m, args.out, layout)
    try:
        expected = scenario(run)
        errors = m.js(MOD_ERRORS)
        run.check("no errors from the mod in the browser console", not errors, errors)
    finally:
        stop_zen(proc, m, log, graceful=True)

    print("13. Groups survive a restart")
    proc, m, log = start_zen(args, profile, layout, "zen-restart.log")
    run.m = m
    try:
        run.settle(1.5)
        restored = m.js(RENDERED_GROUPS)
        run.check("same groups after restart", restored == expected, (restored, expected))
        run.screenshot("after-restart")

        print("14. Context menu")
        items = run.m.js(CONTEXT_MENU, "Mail", "zlg-context-remove")
        run.check("a member's menu offers every group action", all(not hidden for hidden in items.values()), items)
        tabs = run.by_label(run.state("Thread 3"))
        order = run.order(run.state("Thread 3"))
        run.check("'Remove from group' ungroups the tab", tabs["Mail"]["role"] is None, tabs["Mail"])
        run.check("...and moves it below the group", order.index("Mail") == order.index("Thread 3") + 1, order)
        items = run.m.js(CONTEXT_MENU, "Article 1", "zlg-context-ungroup")
        run.check("a root's menu has no 'Remove from group'", items["zlg-context-remove"], items)
        groups = run.groups()
        run.check("'Ungroup' dissolves the group", "Article 1" not in groups, groups)
        run.m.js(CONTEXT_MENU, "Forum", "zlg-context-close")
        try:
            run.m.wait(
                "return !gBrowser.tabs.some(t => !t.closing && ['Thread 1', 'Thread 2', 'Thread 3'].includes(t.label))",
                timeout=5,
                message="group tabs to close",
            )
            closed = True
        except AssertionError:
            closed = False
        run.check("'Close group' closes the members", closed, run.m.js("return gBrowser.tabs.map(t => t.label)"))
        run.check(
            "...but keeps a pinned root",
            run.m.js("return gBrowser.tabs.some(t => t.label === 'Forum' && t.pinned && !t.closing)"),
        )
        run.check("no groups are left", run.groups() == {}, run.groups())
        items = run.m.js(CONTEXT_MENU, "Mail", None)
        run.check("an ungrouped tab shows none of the items", all(items.values()), items)
        errors = m.js(MOD_ERRORS)
        run.check("no errors from the mod in the browser console", not errors, errors)
    finally:
        stop_zen(proc, m, log, graceful=False)

    print(f"\nscreenshots and logs: {args.out}")
    if run.failures:
        print(f"{len(run.failures)} check(s) failed")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
