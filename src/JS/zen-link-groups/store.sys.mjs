/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * One store for the whole browser. Tabs are keyed by Zen's sync id
 * (`tab.id`, saved in the session as `zenSyncId`), which is the same for a
 * tab in every synced window and survives restarts. The state is written to
 * `<profile>/zen-link-groups.json`.
 */

import { GroupState } from "chrome://userscripts/content/zen-link-groups/model.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const FILE_NAME = "zen-link-groups.json";
const SAVE_DELAY_MS = 1000;

class LinkGroupsStoreImpl {
  #state = new GroupState();
  #listeners = new Set();
  #notifyQueued = false;
  #saveTimer = null;
  #dirty = false;
  #pruned = false;
  /** Nesting depth of tab moves made by the mod itself. */
  #selfMoves = 0;

  ready;

  constructor() {
    this.ready = this.#load();
    lazy.AsyncShutdown.profileBeforeChange.addBlocker(
      "Zen Link Groups: saving tab groups",
      () => this.flush()
    );
  }

  get #path() {
    return PathUtils.join(PathUtils.profileDir, FILE_NAME);
  }

  async #load() {
    try {
      if (await IOUtils.exists(this.#path)) {
        this.#state = GroupState.fromJSON(await IOUtils.readJSON(this.#path));
      }
    } catch (error) {
      console.error("[ZenLinkGroups] Could not read saved groups, starting empty.", error);
    }
  }

  /* Reads */

  rootOf(id) {
    return this.#state.rootOf(id);
  }
  isRoot(id) {
    return this.#state.isRoot(id);
  }
  groupOf(id) {
    return this.#state.groupOf(id);
  }
  info(rootId) {
    return this.#state.info(rootId);
  }
  roots() {
    return this.#state.roots();
  }
  membersOf(rootId) {
    return this.#state.membersOf(rootId);
  }

  /* Writes: each one notifies every window and schedules a save. */

  addMember(childId, openerId) {
    return this.#commit(this.#state.addMember(childId, openerId));
  }
  removeMember(id) {
    return this.#commit(this.#state.removeMember(id));
  }
  forget(id, successorId) {
    return this.#commit(this.#state.forget(id, successorId));
  }
  dissolve(rootId) {
    return this.#commit(this.#state.dissolve(rootId));
  }
  setCollapsed(rootId, collapsed) {
    return this.#commit(this.#state.setCollapsed(rootId, collapsed));
  }

  /**
   * Runs once per session, after every window finished restoring: drops
   * groups of tabs that did not come back.
   *
   * @param {() => Set<string>} collectLiveIds
   */
  pruneOnce(collectLiveIds) {
    if (this.#pruned) {
      return;
    }
    this.#pruned = true;
    this.#commit(this.#state.prune(collectLiveIds()));
  }

  /**
   * Tab moves made by the mod itself. Every window ignores TabMove while this
   * is non-zero, including the mirrored moves Zen's window sync makes.
   */
  get selfMoving() {
    return this.#selfMoves > 0;
  }
  runSelfMove(callback) {
    this.#selfMoves++;
    try {
      return callback();
    } finally {
      this.#selfMoves--;
    }
  }

  /** @returns {() => void} unsubscribe */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #commit(result) {
    if (!result) {
      return result;
    }
    this.#dirty = true;
    this.#scheduleSave();
    if (!this.#notifyQueued) {
      this.#notifyQueued = true;
      Promise.resolve().then(() => {
        this.#notifyQueued = false;
        for (const listener of this.#listeners) {
          try {
            listener();
          } catch (error) {
            console.error("[ZenLinkGroups] listener failed", error);
          }
        }
      });
    }
    return result;
  }

  #scheduleSave() {
    if (this.#saveTimer) {
      return;
    }
    this.#saveTimer = lazy.setTimeout(() => {
      this.#saveTimer = null;
      this.flush();
    }, SAVE_DELAY_MS);
  }

  async flush() {
    if (this.#saveTimer) {
      lazy.clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    if (!this.#dirty) {
      return;
    }
    this.#dirty = false;
    try {
      await IOUtils.writeJSON(this.#path, this.#state, {
        tmpPath: this.#path + ".tmp",
      });
    } catch (error) {
      this.#dirty = true;
      console.error("[ZenLinkGroups] Could not save groups.", error);
    }
  }
}

export const LinkGroupsStore = new LinkGroupsStoreImpl();
