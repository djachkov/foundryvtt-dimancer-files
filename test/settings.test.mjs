import { test } from "node:test";
import assert from "node:assert/strict";
import { replaceCategory } from "../scripts/settings.mjs";

test("pickers map to the replace setting of their kind", () => {
  assert.equal(replaceCategory({ type: "image" }), "images");
  assert.equal(replaceCategory({ type: "imagevideo" }), "images");
  assert.equal(replaceCategory({ type: "texture" }), "images");
  assert.equal(replaceCategory({ type: "audio" }), "audio");
  assert.equal(replaceCategory({ type: "video" }), "video");
  assert.equal(replaceCategory({ type: "folder" }), "folders");
  assert.equal(replaceCategory({ type: "text" }), "other");
  assert.equal(replaceCategory({}), "other");
  assert.equal(replaceCategory({ type: "something-new" }), "other");
  // The canvas Tile Browser is a texture picker with a tile size: it has its own switch.
  assert.equal(replaceCategory({ type: "texture", tileSize: true }), "tiles");
});
