"""install.sh against a stand-in Zen.app and profile, without a browser.

    python3 -I -m unittest discover -s test -p 'test_*.py'

Standard library only; runs on any OS with bash and python3.
"""

import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
THEME = json.loads((ROOT / "theme.json").read_text())
VENDOR = ROOT / "vendor" / "fx-autoconfig"


class Installer(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.app = base / "Zen.app"
        (self.app / "Contents" / "Resources").mkdir(parents=True)
        self.profile = base / "profile"
        self.profile.mkdir()
        (self.profile / "prefs.js").write_text('user_pref("browser.startup.page", 3);\n')

    def tearDown(self):
        # Undo the read-only loader of one test so the folder can go.
        for path in Path(self.tmp.name).rglob("*"):
            if path.is_file() and not path.is_symlink():
                path.chmod(stat.S_IMODE(path.stat().st_mode) | stat.S_IWUSR)
        self.tmp.cleanup()

    def run_installer(self, *args):
        result = subprocess.run(
            ["bash", str(ROOT / "install.sh"), "--app", str(self.app), "--profile", str(self.profile), *args],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def mods(self):
        return json.loads((self.profile / "zen-themes.json").read_text())

    def test_install_lists_the_mod_in_zen_mods(self):
        self.run_installer()
        chrome = self.profile / "chrome"
        self.assertTrue((chrome / "JS" / "zenLinkGroups.uc.js").is_file())
        self.assertTrue((chrome / "CSS" / "zenLinkGroups.uc.css").is_file())
        entry = self.mods()[THEME["id"]]
        self.assertIs(entry["enabled"], True)
        self.assertEqual(entry["version"], THEME["version"])
        folder = chrome / "zen-themes" / THEME["id"]
        self.assertEqual(
            (folder / "chrome.css").read_text(), (ROOT / "src" / "zen-mod" / "chrome.css").read_text()
        )
        self.assertEqual(
            json.loads((folder / "preferences.json").read_text()),
            json.loads((ROOT / "preferences.json").read_text()),
        )
        self.assertIn("Zen Link Groups", (chrome / "zen-themes.css").read_text())

    def test_an_identical_loader_is_not_written_again(self):
        # After an earlier install with sudo the loader in the app belongs to
        # root; an update must not need to write it.
        resources = self.app / "Contents" / "Resources"
        (resources / "defaults" / "pref").mkdir(parents=True)
        for src, dst in (
            (VENDOR / "program" / "config.js", resources / "config.js"),
            (VENDOR / "program" / "defaults" / "pref" / "config-prefs.js", resources / "defaults" / "pref" / "config-prefs.js"),
        ):
            shutil.copyfile(src, dst)
            dst.chmod(0o444)
        output = self.run_installer()
        self.assertNotIn("backing it up", output)

    def test_uninstall_removes_the_mod_and_its_settings(self):
        self.run_installer()
        prefs = self.profile / "prefs.js"
        prefs.write_text(prefs.read_text() + 'user_pref("zen-link-groups.indent", "24px");\n')
        self.run_installer("--uninstall")
        self.assertNotIn(THEME["id"], self.mods())
        self.assertFalse((self.profile / "chrome" / "zen-themes" / THEME["id"]).exists())
        self.assertFalse((self.profile / "chrome" / "JS" / "zenLinkGroups.uc.js").exists())
        self.assertNotIn("zen-link-groups.", prefs.read_text())
        self.assertIn("browser.startup.page", prefs.read_text())

    def test_dry_run_changes_nothing(self):
        before = sorted(p.relative_to(self.tmp.name) for p in Path(self.tmp.name).rglob("*"))
        self.assertIn("Dry run", self.run_installer("--dry-run"))
        after = sorted(p.relative_to(self.tmp.name) for p in Path(self.tmp.name).rglob("*"))
        self.assertEqual(before, after)


class Manifest(unittest.TestCase):
    def test_settings_are_read_by_the_stylesheet(self):
        css = (ROOT / THEME["style"]["chrome"]).read_text()
        for pref in json.loads((ROOT / THEME["preferences"]).read_text()):
            self.assertEqual(pref["type"], "string", pref)
            self.assertTrue(pref["property"].startswith(THEME["id"] + "."), pref)
            self.assertIn("var(--" + pref["property"].replace(".", "-") + ",", css, pref)


if __name__ == "__main__":
    unittest.main()
