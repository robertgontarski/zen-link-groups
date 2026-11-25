// Unit tests for the pure group logic: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GroupState,
  layout,
  pickColor,
  placementTarget,
  planFollow,
  reconcileSection,
} from "../src/JS/zen-link-groups/model.sys.mjs";

/**
 * Builds section items from a compact spec: "R" is a root, "R>a" a member of
 * R, "x" an ungrouped tab, "#" an opaque item (split view, folder).
 */
function section(...spec) {
  const roots = new Set(spec.filter(s => s.includes(">")).map(s => s.split(">")[0]));
  return spec.map(s => {
    if (s === "#") {
      return { id: null, opaque: true };
    }
    const [left, right] = s.split(">");
    if (right) {
      return { id: right, root: left, isRoot: false };
    }
    return { id: left, root: null, isRoot: roots.has(left) };
  });
}

test("flat groups: a link opened from a member joins the member's root", () => {
  const state = new GroupState();
  assert.equal(state.addMember("a", "R"), "R");
  assert.equal(state.addMember("b", "a"), "R");
  assert.deepEqual(state.membersOf("R"), ["a", "b"]);
  assert.equal(state.isRoot("a"), false);
});

test("a tab never joins its own group or becomes a member while leading one", () => {
  const state = new GroupState();
  state.addMember("a", "R");
  assert.equal(state.addMember("R", "a"), null);
  assert.equal(state.addMember("x", "x"), null);
  assert.equal(state.rootOf("R"), null);
});

test("closing a root hands the group to the successor and keeps its color", () => {
  const state = new GroupState();
  state.addMember("a", "R");
  state.addMember("b", "R");
  state.addMember("c", "R");
  const color = state.info("R").color;
  state.forget("R", "b");
  assert.equal(state.isRoot("R"), false);
  assert.equal(state.isRoot("b"), true);
  assert.deepEqual(state.membersOf("b"), ["a", "c"]);
  assert.equal(state.info("b").color, color);
});

test("a group left with one tab dissolves", () => {
  const state = new GroupState();
  state.addMember("a", "R");
  state.forget("R", "a");
  assert.equal(state.roots().length, 0);
  assert.equal(state.rootOf("a"), null);

  state.addMember("b", "S");
  state.forget("b");
  assert.equal(state.isRoot("S"), false);
});

test("prune drops dead members and re-roots groups whose root vanished", () => {
  const state = new GroupState();
  state.addMember("a", "R");
  state.addMember("b", "R");
  state.addMember("c", "S");
  assert.equal(state.prune(new Set(["a", "b", "S"])), true);
  assert.equal(state.isRoot("a"), true);
  assert.deepEqual(state.membersOf("a"), ["b"]);
  assert.equal(state.isRoot("S"), false);
});

test("state survives a JSON round trip and tolerates junk", () => {
  const state = new GroupState();
  state.addMember("a", "R");
  state.setCollapsed("R", true);
  const copy = GroupState.fromJSON(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(copy.membersOf("R"), ["a"]);
  assert.equal(copy.info("R").collapsed, true);

  const junk = GroupState.fromJSON({ members: { x: "nope", y: 5 }, groups: { z: null } });
  assert.equal(junk.roots().length, 0);
  assert.equal(GroupState.fromJSON("garbage").roots().length, 0);
});

test("new groups take the least used color", () => {
  assert.equal(pickColor([]), 0);
  assert.equal(pickColor([0, 1, 2]), 3);
  assert.equal(pickColor([0, 0, 1, 2, 3, 4, 5, 6, 7]), 1);
});

test("a tab dragged into the middle of a group joins it", () => {
  const items = section("R", "R>a", "x", "R>b");
  const result = reconcileSection(items, { touched: new Set(["x"]) });
  assert.deepEqual(result, { join: [["x", "R"]], leave: [] });
});

test("an ungrouped tab the user did not move does not join", () => {
  const items = section("R", "R>a", "x", "R>b");
  const result = reconcileSection(items, { touched: new Set(["b"]) });
  assert.deepEqual(result.join, []);
  assert.deepEqual(result.leave, ["b"]);
});

test("a member dragged out of the group leaves it", () => {
  assert.deepEqual(
    reconcileSection(section("R", "R>a", "x", "y", "R>b"), { touched: new Set(["b"]) }).leave,
    ["b"]
  );
  assert.deepEqual(
    reconcileSection(section("R>a", "x", "R", "R>b"), { touched: new Set(["a"]) }).leave,
    ["a"],
    "a member above its root is cut off"
  );
});

test("dropping a tab at the very end of a group does not join it", () => {
  const result = reconcileSection(section("R", "R>a", "x"), { touched: new Set(["x"]) });
  assert.deepEqual(result, { join: [], leave: [] });
});

test("a split view or folder inside a group cuts it", () => {
  const result = reconcileSection(section("R", "R>a", "#", "R>b"), { touched: new Set() });
  assert.deepEqual(result.leave, ["b"]);
});

test("members of a pinned root keep the run with most untouched members", () => {
  const items = section("R>a", "x", "R>b", "R>c");
  const result = reconcileSection(items, {
    touched: new Set(["a"]),
    rootPlacement: () => "elsewhere",
  });
  assert.deepEqual(result.leave, ["a"]);
});

test("members whose root lives in another section leave", () => {
  const items = section("R>a", "R>b");
  const result = reconcileSection(items, { rootPlacement: () => "other-section" });
  assert.deepEqual(result.leave.sort(), ["a", "b"]);
});

test("a consistent section is left alone", () => {
  const items = section("x", "R", "R>a", "R>b", "S", "S>c", "y");
  assert.deepEqual(reconcileSection(items, { touched: new Set(["R", "S"]) }), { join: [], leave: [] });
});

test("members follow a root the user dragged away", () => {
  const items = section("R>a", "R>b", "x", "R");
  assert.deepEqual(planFollow(items, "R"), { after: "R", ids: ["a", "b"] });
  assert.deepEqual(planFollow(items, "R", new Set(["b"])), { after: "R", ids: ["a"] });
  assert.deepEqual(planFollow(section("R", "R>a"), "R"), { after: "a", ids: [] });
});

test("a new member is moved next to its group only when it landed elsewhere", () => {
  assert.equal(placementTarget(section("R", "R>a", "R>new"), "new"), null);
  assert.equal(placementTarget(section("R", "R>new", "R>a"), "new"), null);
  assert.equal(placementTarget(section("R>new", "x", "R", "R>a"), "new"), "a");
  assert.equal(placementTarget(section("x", "R>new"), "new"), null, "first member of a pinned root");
});

test("layout marks roots, first and last members", () => {
  const map = layout(section("x", "R", "R>a", "R>b", "R>c", "y"));
  assert.deepEqual(map.get("R"), { role: "root", gid: "R", trunk: true });
  assert.deepEqual(map.get("a"), { role: "member", gid: "R", hidden: false, first: true, orphan: false });
  assert.equal(map.get("b").first, undefined);
  assert.equal(map.get("c").last, true);
  assert.equal(map.has("x"), false);
});

test("a collapsed group hides members except the selected one", () => {
  const map = layout(section("R", "R>a", "R>b", "R>c"), {
    isCollapsed: () => true,
    selectedId: "b",
  });
  assert.equal(map.get("a").hidden, true);
  assert.equal(map.get("b").hidden, false);
  assert.equal(map.get("R").trunk, true, "the selected member keeps the line");
  const none = layout(section("R", "R>a"), { isCollapsed: () => true });
  assert.equal(none.get("R").trunk, false);
  assert.equal(map.get("b").first, true);
  assert.equal(map.get("b").last, true);
});

test("members of a root outside the section start an orphan run", () => {
  const map = layout(section("R>a", "R>b"));
  assert.equal(map.get("a").orphan, true);
  assert.equal(map.get("b").last, true);
});
