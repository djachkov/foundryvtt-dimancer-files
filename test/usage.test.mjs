import { test } from "node:test";
import assert from "node:assert/strict";
import { changedKeys, pathMatcher, rewriteString, rewriteValue, spellings } from "../scripts/usage-core.mjs";

test("both spellings of a path", () => {
  assert.deepEqual(spellings("assets/My%20Map.webp"), ["assets/My%20Map.webp", "assets/My Map.webp"]);
  assert.deepEqual(spellings("assets/a.png"), ["assets/a.png"]);
});

test("files match at path boundaries only", () => {
  const m = pathMatcher([{ path: "assets/maps/a.png" }]);
  for ( const yes of [
    `{"src":"assets/maps/a.png"}`, `"/assets/maps/a.png"`, `<img src="assets/maps/a.png">`,
    `url(assets/maps/a.png)`, `"https://example.com/assets/maps/a.png"`, `"assets/maps/a.png?v=2"`
  ] ) assert.ok(m.test(yes), yes);
  for ( const no of [
    `"assets/maps/a.png.bak"`, `"assets/maps/a.pngx"`, `"old/assets/maps/a.png"`, `"xassets/maps/a.png"`
  ] ) assert.equal(m.test(no), false, no);
});

test("encoded and decoded data both match", () => {
  const m = pathMatcher([{ path: "assets/My%20Map.webp" }]);
  assert.ok(m.test(`"assets/My%20Map.webp"`));
  assert.ok(m.test(`"assets/My Map.webp"`));
});

test("folders match everything below them", () => {
  const m = pathMatcher([{ path: "assets/maps", isDir: true }]);
  assert.ok(m.test(`"assets/maps/a/b.png"`));
  assert.equal(m.test(`"assets/maps2/b.png"`), false);
  assert.equal(m.test(`"assets/maps"`), false);
});

test("rewriting keeps the spelling it found", () => {
  const moves = [{ from: "assets/My%20Map.webp", to: "maps/City%20Map.webp" }];
  assert.equal(rewriteString(`a "assets/My%20Map.webp" b "assets/My Map.webp"`, moves),
    `a "maps/City%20Map.webp" b "maps/City Map.webp"`);
  assert.equal(rewriteString(`"/assets/My%20Map.webp"`, moves), `"/maps/City%20Map.webp"`);
  assert.equal(rewriteString(`"assets/My%20Map.webp.bak"`, moves), `"assets/My%20Map.webp.bak"`);
});

test("a plain old path gets the encoded new path", () => {
  const moves = [{ from: "maps/cave.png", to: "maps/cave%20renamed.png" }];
  assert.equal(rewriteString(`"maps/cave.png"`, moves), `"maps/cave%20renamed.png"`);
});

test("rewriting a folder moves paths below it, once", () => {
  const moves = [{ from: "assets", to: "assets/old", isDir: true }];
  assert.equal(rewriteString("assets/a.png", moves), "assets/old/a.png");
  assert.equal(rewriteString("assets/x/y/a.png", moves), "assets/old/x/y/a.png");
  assert.equal(rewriteString("assets2/a.png", moves), "assets2/a.png");
});

test("rewriting data returns the same objects when nothing changed", () => {
  const data = { name: "Castle", background: { src: "assets/a.png" }, notes: ["x", "assets/a.png"], n: 3 };
  const same = rewriteValue(data, [{ from: "assets/b.png", to: "assets/c.png" }]);
  assert.equal(same, data);
  const moved = rewriteValue(data, [{ from: "assets/a.png", to: "maps/a.png" }]);
  assert.notEqual(moved, data);
  assert.equal(moved.background.src, "maps/a.png");
  assert.deepEqual(moved.notes, ["x", "maps/a.png"]);
  assert.deepEqual(changedKeys(data, moved), { background: { src: "maps/a.png" }, notes: ["x", "maps/a.png"] });
});
