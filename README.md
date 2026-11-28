<p align="center">
  <img src="docs/banner.webp" width="100%" alt="Zen Link Groups: tabs opened from links group under the tab they came from. A News page with three links sits next to the Zen sidebar, where the three tabs those links opened are indented under the News tab on a colored tree line.">
</p>

# Zen Link Groups

[![CI](https://github.com/robertgontarski/zen-link-groups/actions/workflows/ci.yml/badge.svg)](https://github.com/robertgontarski/zen-link-groups/actions/workflows/ci.yml)
[![License: MPL 2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](LICENSE)

A mod for the [Zen](https://zen-browser.app) browser. Tabs opened from links line up under the tab they came from, the way they do in Dia, so you can always see where a tab came from.

<p>
  <img src="docs/preview.png" width="230" alt="Two groups: Forum with three threads and News with articles, each in its own color">
  <img src="docs/preview-collapsed.png" width="230" alt="The News group collapsed to a single row with a count of 4">
</p>

The banner is an illustration. The two images above are real screenshots, taken by the end-to-end test.

## What it does

- **Grouping.** A link opened in a new tab lands under the tab it was opened from, indented and joined by a colored line. Every group gets its own color. It works with cmd+click, middle click, `target=_blank` links and "Open Link in New Tab".
- **Flat groups.** A link opened from a child tab joins the same group, as in Dia and in Chrome's tab groups.
- **Collapsing.** The parent tab carries a badge with the number of tabs. Clicking it collapses or expands the group. The selected tab stays visible even in a collapsed group.
- **Drag and drop.**
  - A child dragged out of the group leaves it.
  - A tab dropped into the middle of a group joins it.
  - A dragged parent takes its children along.
- **Closing the parent.** The first child takes over the group and keeps its color. A group left with a single tab disappears.
- **Pinned parent and Essentials.** The children stay grouped in the tab list, under a slim row that shows the parent's icon and title, so the tree still has a visible start. Click the row to jump to the parent. Its arrow collapses the group into the parent's badge, and the row goes away with the children.
- **Glance.** A link clicked in a Glance preview joins the group of the tab the preview was opened from. A Glance opened as a regular tab joins that group too.
- **Tab context menu.** It gains *Collapse / Expand group*, *Remove from group*, *Ungroup* and *Close group*. A pinned parent stays open; only its children close. The labels are in English, or in Polish when the browser runs in Polish.
- **Persistence.** Groups survive a browser restart and reopening a closed tab (Cmd+Shift+T). They show up in every synced Zen window.
- **Collapsed sidebar.** Instead of a tree, grouped tabs get an outline in the group's color.
- **Zen Mods.** The mod shows up in *Settings → Zen Mods*. Its switch turns grouping off and on right away, and its settings set the indent and the tree line (see [Settings](#settings)).

The mod does not group tabs opened by hand (Cmd+T, the address bar), pinned tabs, Essentials, tabs in a split view, or tabs from a different space than the parent.

## Install

Requirements: macOS, Zen 1.24 or newer in `/Applications/Zen.app`, and `python3`. The mod was tested on Zen 1.24.3b (Gecko 160).

```sh
git clone https://github.com/robertgontarski/zen-link-groups.git
cd zen-link-groups

# 1. Quit Zen (Cmd+Q).
./install.sh --dry-run   # optional: shows what would be copied, changes nothing
./install.sh
# 2. Start Zen.
```

Zen's native mods are CSS only, which is also why this mod is not in the Zen Mods store. Grouping needs JavaScript, so the installer adds the [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) loader. A copy of it lives in `vendor/fx-autoconfig`, pinned to the commit recorded in `vendor/fx-autoconfig/VERSION`. The installer also lists the mod in Zen Mods, the way Zen lists a mod from its store, so you can switch it and set it up in Zen's settings.

| Where | What |
| --- | --- |
| `Zen.app/Contents/Resources/config.js`<br>`Zen.app/Contents/Resources/defaults/pref/config-prefs.js` | the loader (two files inside the app) |
| `<profile>/chrome/utils/` | the rest of the loader |
| `<profile>/chrome/JS/zenLinkGroups.uc.js`<br>`<profile>/chrome/JS/zen-link-groups/` | the mod |
| `<profile>/chrome/CSS/zenLinkGroups.uc.css` | its styles |
| `<profile>/chrome/zen-themes/zen-link-groups/`<br>`<profile>/zen-themes.json`<br>`<profile>/chrome/zen-themes.css` | its entry in Zen Mods: switch and settings |
| `<profile>/zen-link-groups.json` | saved groups (the mod creates this file itself) |

By default the installer picks the profile this Zen install starts with (`installs.ini`). Point it at another one with `--profile "<profile directory>"`. If the app already has a different `config.js`, the installer keeps it as `config.js.backup-<date>`.

Run the installer without `sudo`. Files that root owns in the profile are out of reach for Zen, which runs as you: Zen could not save the mod's switch. The installer refuses to run as root, and stops with a `chown` command when it finds root's files from an earlier run.

> The loader gives scripts in `<profile>/chrome/JS` full browser privileges. Keep only code you trust there.

**After a Zen update.** An update can replace the app's files, the loader included. If groups stop working, quit Zen and run `./install.sh` again.

**When macOS blocks writing to Zen.app.** Open *System Settings → Privacy & Security → App Management*, enable your terminal there and run the installer again.

**If you use [Sine](https://github.com/CosmoCreeper/Sine).** Do not run `install.sh`: Sine keeps its own bootloader in the same place inside the app (`config.js` and `defaults/`), and the installer would replace it, leaving the old `config.js` as a backup. Install the mod through Sine instead, from this repository's URL. The repository carries the `theme.json` Sine reads. Until the mod is listed in Sine's marketplace, Sine runs its script only when `sine.allow-unsafe-js` is set to `true` in `about:config`.

Sine support is new. The end-to-end test covers the way Sine serves and loads the mod (`--layout sine`, see [Tests](#tests)), but the mod has not been tried in a real Sine install yet.

### Uninstall

```sh
./install.sh --uninstall
```

This removes the mod, its entry in Zen Mods, its settings and the saved groups. The loader is removed only when no other scripts are left in `chrome/JS` and `chrome/CSS` and its files are identical to the copy in this repository.

*Remove mod* in Zen Mods only switches the mod off for good: the script stops and nothing is drawn, but its files stay until you run `./install.sh --uninstall`. Run `./install.sh` to bring the entry back.

## Settings

*Settings → Zen Mods → Zen Link Groups*. The switch turns the mod off and on at once, in every window: switched off, it draws nothing, adds nothing to the tab menu and does not group new tabs. The groups it had come back when you switch it on again.

The gear opens the settings. Each field takes a CSS length such as `24px`; an empty field keeps the default.

| Field | Meaning | Default |
| --- | --- | --- |
| Indent of child tabs | how far the children sit to the right | `18px` |
| Thickness of the tree line | | `2px` |
| Tree line from the tab's left edge | position of the line, measured from the parent's left edge (the middle of its icon) | `19.5px` |

They are stored in `about:config` as `zen-link-groups.indent`, `zen-link-groups.line-width` and `zen-link-groups.line-x`. [Zen Link Size](https://github.com/robertgontarski/zen-link-size), which changes the size and the padding of tabs, moves the line along with the icon by itself.

## Customizing the look

More variables sit in `:root` at the top of `src/CSS/zenLinkGroups.uc.css`:

| Variable | Meaning | Default |
| --- | --- | --- |
| `--zlg-elbow-reach` | where the curve into the last child ends | `8px` |
| `--zlg-c0` … `--zlg-c7` | the group palette (`light-dark(light, dark)`) | |

After a change, run `./install.sh` and restart Zen.

## How it works

- **Parent.** When Firefox opens a tab from a link, it sets `tab.openerTab` on that tab. The mod reads the value on the `TabOpen` event.
- **Tab identity.** The key is Zen's `tab.id`. Zen saves it in the session as `zenSyncId`, and a tab has the same id in every synced window. That lets one shared state (`store.sys.mjs`, saved to `zen-link-groups.json`) serve all windows and survive a restart.
- **Drag and drop.** After a tab is dropped, the mod derives membership from the tab order (`reconcileSection` in `model.sys.mjs`). Only the window you are working in recomputes it. The other windows, into which Zen mirrors tab moves, only repaint.
- **Look.** The controller sets `zlg-*` attributes on the tabs and the CSS draws from them. The indent reuses `--zen-folder-indent`, the variable Zen uses for folders.
- **Parent outside the tab list.** A pinned parent sits in another part of the sidebar than its children. The controller puts a `.zlg-anchor` row above the first visible child. The row is not a tab, and Zen leaves anything that is not a tab out when it lists or drags tabs. A right click on it opens the parent's context menu.
- **Zen Mods.** Zen keeps its mods in `zen-themes.json` and flips the `zen.mods.updated-value-observer` pref after every change to them. The controller watches that pref (and `zen.themes.disable-all`), reads whether its entry is there and switched on, and starts or stops in each window. Stopping takes every `zlg-*` attribute, badge and anchor row off. Zen applies its mods below its own styles, so the entry's own stylesheet (`src/zen-mod/chrome.css`) is empty: the groups keep being drawn by the sheet fx-autoconfig loads, which draws only from the attributes. Zen puts filled-in settings on `:root` (`--zen-link-groups-indent` and so on), and that sheet reads them. Under Sine, which switches mods itself, the script does not look at Zen Mods.

```text
src/JS/zenLinkGroups.uc.js              window controller: tab events, drag and drop, rendering, menu, switch
src/JS/zen-link-groups/model.sys.mjs    pure group logic (no browser APIs)
src/JS/zen-link-groups/store.sys.mjs    state shared by all windows, and saving it
src/CSS/zenLinkGroups.uc.css            indents, lines, colors, badge
src/zen-mod/chrome.css                  the entry's stylesheet in Zen Mods (empty, see above)
preferences.json                        the settings, as Zen Mods shows them
theme.json                              manifest for the Sine mod manager and the Zen Mods entry
tools/zen_mods.py                       adds the mod to Zen Mods in the profile (used by install.sh)
vendor/fx-autoconfig/                   pinned copy of the loader
test/                                   unit and end-to-end tests
```

## Tests

```sh
node --test test/*.test.mjs                  # group logic, 21 tests
python3 -I -m unittest discover -s test -p 'test_*.py'   # installer and settings, no browser
python3 -I test/e2e.py --out /tmp/zlg-e2e    # end to end on a real Zen, headless
python3 -I test/e2e.py --layout sine --out /tmp/zlg-e2e-sine   # the same, installed the way Sine does it
```

The end-to-end test does not touch your profile or `Zen.app`. It starts Zen through Marionette on a temporary profile, turns the loader on in the running browser and clicks real links. It checks 17 scenarios, including drag and drop, a pinned parent, the context menu, a second window, a restart, and the switch, the settings and *Remove mod* in Zen Mods, and saves sidebar screenshots to the `--out` directory. With `--headed` you can watch the browser window. It needs only Python 3 (standard library).

`--layout sine` runs the same scenarios with the mod installed the way the Sine mod manager does it: served from `chrome://sine/content/<mod id>/`, with the script named in `theme.json` loaded into each window and the style applied as a user sheet. Sine itself is not started.

CI runs the unit tests and the installer tests, and lints the installer. The end-to-end test needs macOS with Zen installed, so it runs locally only.

## Known limitations

- The line position matches Zen's default tab look. A theme or another mod that changes tab spacing may need the line position set in [Settings](#settings).
- A collapsed group hides its tabs with CSS. Dragging other tabs right next to a collapsed group can insert them between the hidden tabs. When in doubt, expand the group before dragging.
- The parent is detected only at the moment a tab opens. The mod will not group tabs that were opened before it was installed.

## License

[MPL-2.0](LICENSE). The bundled fx-autoconfig loader in `vendor/fx-autoconfig` is MPL-2.0 as well and ships with its own license file.

This project is not affiliated with Zen Browser or Dia.
