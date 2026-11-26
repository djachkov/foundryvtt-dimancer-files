import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gifFrameCount, isAnimated, isConvertible, planConversions, pngIsAnimated, savings, webpName
} from "../scripts/convert-core.mjs";

/* A 1×1 GIF with a 2-colour global table and `frames` image blocks. */
function gif(frames) {
  const out = [...Buffer.from("GIF89a"), 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
  for ( let f = 0; f < frames; f++ ) {
    out.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0); // graphic control extension
    out.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0); // image descriptor + data
  }
  out.push(0x21, 0xfe, 3, 0x61, 0x62, 0x63, 0); // a comment extension
  out.push(0x3b);
  return Uint8Array.from(out);
}

/* A PNG skeleton: signature and the named chunks (empty data except IHDR; CRCs are zeros). */
function png(...types) {
  const out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for ( const type of types ) {
    const data = type === "IHDR" ? new Array(13).fill(0) : type === "acTL" ? new Array(8).fill(0) : [];
    out.push(0, 0, 0, data.length, ...Buffer.from(type), ...data, 0, 0, 0, 0);
  }
  return Uint8Array.from(out);
}

test("GIF frames", () => {
  assert.equal(gifFrameCount(gif(1)), 1);
  assert.equal(gifFrameCount(gif(3)), 2, "stops counting at 2");
  assert.equal(gifFrameCount(gif(3), 10), 3);
  assert.equal(gifFrameCount(Uint8Array.from([1, 2, 3])), 0);
  assert.equal(isAnimated(gif(1), "gif"), false);
  assert.equal(isAnimated(gif(2), "gif"), true);
});

test("APNG has acTL before IDAT", () => {
  assert.equal(pngIsAnimated(png("IHDR", "IDAT", "IEND")), false);
  assert.equal(pngIsAnimated(png("IHDR", "acTL", "IDAT", "IEND")), true);
  assert.equal(pngIsAnimated(png("IHDR", "IDAT", "acTL")), false, "acTL after IDAT isn't an APNG");
  assert.equal(pngIsAnimated(Uint8Array.from([1, 2, 3])), false);
  assert.equal(isAnimated(png("IHDR", "acTL", "IDAT"), "png"), true);
  assert.equal(isAnimated(png("IHDR", "acTL", "IDAT"), "jpg"), false);
});

test("which files convert", () => {
  for ( const yes of ["assets/a.png", "assets/My%20Map.JPG", "worlds/w/b.jpeg", "x.gif", "a/b.bmp"] ) {
    assert.ok(isConvertible(yes), yes);
  }
  for ( const no of ["assets/a.webp", "assets/a.svg", "assets/a.avif", "assets/a", "modules/m/a.png",
    "systems/s/a.png", "assets/a.mp4"] ) assert.equal(isConvertible(no), false, no);
});

test("webp names", () => {
  assert.equal(webpName("My Map.png"), "My Map.webp");
  assert.equal(webpName("a.b.jpeg"), "a.b.webp");
  assert.equal(webpName("noext"), "noext.webp");
});

test("planning refuses taken names, on disk and within the batch", () => {
  const taken = new Map([["assets", new Set(["Old.WEBP"])]]);
  const plan = planConversions(
    ["assets/old.png", "assets/My%20Map.png", "assets/My%20Map.jpg", "maps/a.png", "assets/old.png"], taken
  );
  assert.deepEqual(plan, [
    { path: "assets/old.png", folder: "assets", name: "old.webp", clash: true },
    { path: "assets/My%20Map.png", folder: "assets", name: "My Map.webp", clash: false },
    { path: "assets/My%20Map.jpg", folder: "assets", name: "My Map.webp", clash: true },
    { path: "maps/a.png", folder: "maps", name: "a.webp", clash: false }
  ]);
  assert.deepEqual([...taken.get("assets")], ["Old.WEBP"], "the caller's sets aren't changed");
});

test("savings", () => {
  assert.deepEqual(savings([{ before: 1000, after: 250 }, { before: 1000, after: 750 }]),
    { before: 2000, after: 1000, percent: 50 });
  assert.deepEqual(savings([]), { before: 0, after: 0, percent: 0 });
});
