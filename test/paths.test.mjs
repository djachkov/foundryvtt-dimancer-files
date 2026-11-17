import { test } from "node:test";
import assert from "node:assert/strict";
import { containerProblem, encodePath, entryProblem, nameProblem, toSegments } from "../companion/paths.mjs";

const seg = p => toSegments(p);

test("client paths decode per segment", () => {
  assert.deepEqual(seg("worlds/test/My%20Map.webp"), ["worlds", "test", "My Map.webp"]);
  assert.deepEqual(seg("/assets/tokens/"), ["assets", "tokens"]);
  assert.deepEqual(seg(""), []);
  assert.equal(encodePath("assets/Bob's map.png"), "assets/Bob%27s%20map.png");
});

test("traversal, hidden and malformed segments are refused", () => {
  for ( const p of ["../etc", "assets/../../x", "assets/%2E%2E/x", "assets//x", ".dimancer-trash/x", "assets/.git",
    "assets/a%2Fb", "a\0b", "assets/%00" ] ) {
    assert.throws(() => seg(p), p);
  }
});

test("package structure can't be changed", () => {
  const blocked = [
    "", "worlds", "modules", "systems",
    "worlds/test", "modules/dnd-ui", "systems/dnd5e",
    "worlds/test/world.json", "modules/x/module.json", "systems/dnd5e/system.json",
    "worlds/test/data", "worlds/test/data/actors", "worlds/test/packs/monsters",
    "modules/x/scripts/main.mjs", "modules/x/packs/a", "systems/dnd5e/icons/a.webp",
    "modules/x/storage"
  ];
  for ( const p of blocked ) assert.ok(entryProblem(seg(p), { isDir: true }), `${p} should be refused`);
});

test("assets anywhere else can be changed", () => {
  const allowed = [
    "assets", "assets/maps/city.webp", "worlds/test/scenes", "worlds/test/scenes/a.webp", "worlds/test/notes.txt",
    "modules/x/storage/a.png", "modules/x/storage/sub", "systems/dnd5e/storage/a.png"
  ];
  for ( const p of allowed ) assert.equal(entryProblem(seg(p), { isDir: !p.includes(".") }), null, p);
});

test("the Data root takes folders but not files", () => {
  assert.equal(containerProblem([], { isDir: true }), null);
  assert.ok(containerProblem([], { isDir: false }));
  assert.ok(entryProblem(seg("stray.png")));
  assert.equal(entryProblem(seg("assets"), { isDir: true }), null);
});

test("destinations follow Foundry's upload rules", () => {
  assert.equal(containerProblem(seg("worlds/test")), null);
  assert.equal(containerProblem(seg("modules/x/storage")), null);
  assert.ok(containerProblem(seg("worlds")));
  assert.ok(containerProblem(seg("modules/x")));
  assert.ok(containerProblem(seg("worlds/test/data")));
});

test("names", () => {
  assert.equal(nameProblem("City Map.webp"), null);
  for ( const n of ["", " a", "a ", "a/b", "a\\b", ".hidden", "..", "x".repeat(256)] ) assert.ok(nameProblem(n), n);
});
