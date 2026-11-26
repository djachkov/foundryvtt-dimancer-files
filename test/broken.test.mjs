import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bestSuggestion, buildIndex, normalizeRef, pathsInString, referencedPaths, suggest, unlistedFolder
} from "../scripts/broken-core.mjs";

const site = { origin: "https://foundry.example.com", prefix: "" };

test("references normalize to decoded Data paths", () => {
  const cases = {
    "assets/My%20Map.webp": "assets/My Map.webp",
    "/assets/a.png": "assets/a.png",
    "assets/a.png?v=2#x": "assets/a.png",
    "https://foundry.example.com/assets/b.jpg": "assets/b.jpg",
    "Gorm.jpg": "Gorm.jpg",
    "worlds/w/sounds/rain.OGG": "worlds/w/sounds/rain.OGG",
    "icons/svg/mystery-man.svg": "icons/svg/mystery-man.svg"
  };
  for ( const [raw, want] of Object.entries(cases) ) assert.equal(normalizeRef(raw, site), want, raw);
  for ( const no of ["https://other.example.com/a.png", "data:image/png;base64,xx", "//cdn/a.png", "tokens/goblin*.png",
    "assets/{{name}}.png", "assets/a.js", "worlds/w/data", "Some text", "../x.png", "./a.png", "a//b.png",
    "blob:https://foundry.example.com/x", ""] ) {
    assert.equal(normalizeRef(no, site), null, no);
  }
  assert.equal(normalizeRef("foundry/assets/a.png", { prefix: "foundry" }), "assets/a.png");
});

test("links inside HTML and CSS", () => {
  const html = `<p><img src="assets/a%20b.png"> <a href='worlds/w/doc.pdf'>doc</a>
    <a href="https://example.org/x.png">ext</a> <video poster="assets/p.jpg" src="/assets/v.webm"></video>
    <div style="background: url('assets/bg.webp')"></div> <a href="@UUID[Actor.x]">no</a></p>`;
  assert.deepEqual(pathsInString(html, site).sort(),
    ["assets/a b.png", "assets/bg.webp", "assets/p.jpg", "assets/v.webm", "worlds/w/doc.pdf"]);
  assert.deepEqual(pathsInString("Map at (assets/x.png)", site), []);
});

test("paths across nested data", () => {
  const data = { img: "assets/t.png", items: [{ img: "icons/x.svg", system: { description: { value: `<img src="assets/d.png">` } } }],
    flags: { m: { list: ["assets/t.png", 3, null, "plain"] } } };
  assert.deepEqual([...referencedPaths(data, site)].sort(), ["assets/d.png", "assets/t.png", "icons/x.svg"]);
});

test("unlisted folders", () => {
  assert.ok(unlistedFolder(["modules", "x", "a.png"]));
  assert.ok(unlistedFolder(["systems", "dnd5e"]));
  assert.ok(unlistedFolder(["worlds", "w", "data"]));
  assert.equal(unlistedFolder(["worlds", "w", "scenes"]), false);
  assert.equal(unlistedFolder(["assets"]), false);
});

test("suggestions: converted, case, moved, moved and converted", () => {
  const index = buildIndex([
    "assets/maps/City.webp", "assets/maps/City.avif", "assets/maps/city.mp3",
    "assets/Tokens/bob.png", "archive/tokens/bob.png", "other/bob.png",
    "assets/new/Gorm.jpg", "elsewhere/Gorm.webp", "Lone.webp"
  ]);
  const converted = suggest("assets/maps/City.png", index);
  assert.deepEqual(converted.map(s => [s.path, s.reason]),
    [["assets/maps/City.webp", "converted"], ["assets/maps/City.avif", "converted"]],
    "same kind only (the .mp3 is audio), WebP first");
  assert.equal(bestSuggestion(converted).path, "assets/maps/City.webp");

  const cased = suggest("assets/tokens/bob.png", index);
  assert.equal(cased[0].path, "assets/Tokens/bob.png");
  assert.equal(cased[0].reason, "case");
  assert.equal(bestSuggestion(cased).path, "assets/Tokens/bob.png");

  const moved = suggest("old/tokens/bob.png", index);
  assert.equal(moved[0].path, "archive/tokens/bob.png", "shares the tokens folder");
  assert.equal(moved[0].reason, "moved");

  const both = suggest("Gorm.jpg", index);
  assert.deepEqual(both.map(s => s.reason), ["moved", "movedConverted"]);
  assert.equal(bestSuggestion(both).path, "assets/new/Gorm.jpg");

  assert.deepEqual(suggest("nothing/here.png", index), []);
  assert.equal(bestSuggestion([]), null);
});

test("ties aren't preselected", () => {
  const index = buildIndex(["a/x.png", "b/x.png"]);
  const s = suggest("c/x.png", index);
  assert.equal(s.length, 2);
  assert.equal(bestSuggestion(s), null);
});
