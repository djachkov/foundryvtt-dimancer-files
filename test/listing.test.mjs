import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseName, buildItems, crumbs, dirName, fileKind, filterItems, rangeBetween, sortItems, uniqueName
} from "../scripts/listing.mjs";

test("names and kinds", () => {
  assert.equal(baseName("assets/My%20Map.webp"), "My Map.webp");
  assert.equal(baseName("assets/maps/"), "maps");
  assert.equal(dirName("assets/maps/a.png"), "assets/maps");
  assert.equal(fileKind("a/b.WEBP"), "image");
  assert.equal(fileKind("a/b.webm"), "video");
  assert.equal(fileKind("a/b.ogg"), "audio");
  assert.equal(fileKind("a/b.pdf"), "pdf");
  assert.equal(fileKind("a/b"), "file");
});

test("items: folders first, private folders marked, stats attached", () => {
  const items = buildItems(
    { dirs: ["a/z", "a/b"], files: ["a/c.png"], privateDirs: ["a/z"] },
    new Map([["a/c.png", { size: 10, mtime: 5 }]])
  );
  assert.deepEqual(items.map(i => [i.name, i.isDir, i.private ?? false, i.size]),
    [["z", true, true, null], ["b", true, false, null], ["c.png", false, false, 10]]);
});

test("sorting keeps folders first and handles numbers and missing stats", () => {
  const items = buildItems({ dirs: ["d/b", "d/a"], files: ["d/map10.png", "d/map2.png", "d/x.jpg"] },
    new Map([["d/map10.png", { size: 3, mtime: 1 }], ["d/map2.png", { size: 1, mtime: 2 }]]));
  assert.deepEqual(sortItems(items, "name", 1).map(i => i.name), ["a", "b", "map2.png", "map10.png", "x.jpg"]);
  assert.deepEqual(sortItems(items, "name", -1).map(i => i.name), ["b", "a", "x.jpg", "map10.png", "map2.png"]);
  assert.deepEqual(sortItems(items, "size", -1).map(i => i.name), ["a", "b", "map10.png", "map2.png", "x.jpg"]);
  assert.deepEqual(sortItems(items, "size", 1).map(i => i.name), ["a", "b", "map2.png", "map10.png", "x.jpg"]);
  assert.deepEqual(sortItems(items, "type", 1).map(i => i.name), ["a", "b", "x.jpg", "map2.png", "map10.png"]);
});

test("filter matches every word", () => {
  const items = buildItems({ dirs: [], files: ["a/Dark Forest.png", "a/forest day.png", "a/cave.png"] });
  assert.deepEqual(filterItems(items, "forest dark").map(i => i.name), ["Dark Forest.png"]);
  assert.equal(filterItems(items, "  ").length, 3);
});

test("ranges, crumbs, unique names", () => {
  assert.deepEqual(rangeBetween(["a", "b", "c", "d"], "c", "a"), ["a", "b", "c"]);
  assert.deepEqual(rangeBetween(["a", "b"], "x", "b"), ["b"]);
  assert.deepEqual(crumbs("assets/My%20Maps/x"), [
    { label: "assets", path: "assets" }, { label: "My Maps", path: "assets/My%20Maps" },
    { label: "x", path: "assets/My%20Maps/x" }
  ]);
  assert.equal(uniqueName("a.png", ["A.png", "a (1).png"]), "a (2).png");
  assert.equal(uniqueName("b.png", ["a.png"]), "b.png");
});
