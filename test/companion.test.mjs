import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Operations, nested } from "../companion/operations.mjs";
import { createServer } from "../companion/server.mjs";

let tmp;
let data;
let outside;
let ops;

const write = (rel, content = "x") => {
  const abs = path.join(data, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
const exists = rel => fs.existsSync(path.join(data, rel));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dimancer-files-"));
  data = path.join(tmp, "Data");
  outside = path.join(tmp, "elsewhere");
  write("assets/maps/City Map.webp", "map");
  write("assets/maps/cave.png", "cave!");
  write("assets/tokens/bob.png");
  write("worlds/test/world.json", "{}");
  write("worlds/test/data/actors/000001.ldb");
  write("worlds/test/scenes/a.webp");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.png"), "s");
  fs.mkdirSync(path.join(data, "modules"));
  fs.symlinkSync(outside, path.join(data, "modules", "linked"));
  fs.symlinkSync(outside, path.join(data, "assets", "escape"));
  ops = new Operations(data);
});

test("stat reports size and folders", () => {
  const [file, dir, missing] = ops.stat(["assets/maps/cave.png", "assets/maps", "assets/nope.png"]);
  assert.equal(file.size, 5);
  assert.equal(file.isDir, false);
  assert.equal(dir.isDir, true);
  assert.ok(missing.error);
});

test("search finds names below a folder and skips links", () => {
  const { results } = ops.search({ root: "assets", query: "map" });
  assert.deepEqual(results.map(r => r.path).sort(), ["assets/maps", "assets/maps/City%20Map.webp"]);
  assert.equal(ops.search({ query: "secret" }).results.length, 0);
  assert.deepEqual(ops.search({ query: "map", extensions: [".png"] }).results.map(r => r.path), ["assets/maps"]);
  assert.deepEqual(ops.search({ query: "ca", extensions: [".png"] }).results.map(r => r.path), ["assets/maps/cave.png"]);
});

test("delete goes to the trash and restores", async () => {
  const { results } = await ops.delete(["assets/maps/City%20Map.webp"]);
  assert.ok(results[0].trashId, results[0].error);
  assert.equal(exists("assets/maps/City Map.webp"), false);
  const { items } = ops.trashList();
  assert.equal(items.length, 1);
  assert.equal(items[0].path, "assets/maps/City%20Map.webp");

  // Something new took the name in the meantime.
  write("assets/maps/City Map.webp", "new");
  const restored = await ops.trashRestore([items[0].id]);
  assert.equal(restored.results[0].path, "assets/maps/City%20Map%20(restored).webp");
  assert.equal(fs.readFileSync(path.join(data, "assets/maps/City Map (restored).webp"), "utf8"), "map");
  assert.equal(ops.trashList().items.length, 0);
});

test("a whole folder restores into a re-created parent", async () => {
  await ops.delete(["assets/maps/cave.png"]);
  await ops.delete(["assets/maps"]);
  assert.equal(exists("assets/maps"), false);
  const cave = ops.trashList().items.find(i => i.name === "cave.png");
  await ops.trashRestore([cave.id]);
  assert.equal(exists("assets/maps/cave.png"), true);
});

test("permanent delete and empty trash", async () => {
  await ops.delete(["assets/tokens/bob.png"], { permanent: true });
  assert.equal(exists("assets/tokens/bob.png"), false);
  assert.equal(ops.trashList().items.length, 0);
  await ops.delete(["assets/maps"]);
  assert.equal((await ops.trashEmpty()).removed, 1);
  assert.equal(ops.trashList().items.length, 0);
});

test("protected paths and symlinks are refused", async () => {
  const { results } = await ops.delete([
    "worlds/test", "worlds/test/world.json", "worlds/test/data", "worlds/test/data/actors/000001.ldb",
    "modules/linked", "modules/linked/secret.png", "assets/escape", "assets/escape/secret.png", "../elsewhere",
    ".dimancer-trash"
  ]);
  for ( const r of results ) assert.ok(r.error, `${r.path} should fail`);
  assert.equal(fs.existsSync(path.join(outside, "secret.png")), true);
  assert.equal(exists("worlds/test/world.json"), true);
});

test("rename keeps the extension and never overwrites", async () => {
  assert.deepEqual(await ops.rename("assets/maps/cave.png", "Cave.png"),
    { from: "assets/maps/cave.png", to: "assets/maps/Cave.png" });
  await assert.rejects(ops.rename("assets/maps/Cave.png", "cave.webp"), /extension/);
  await assert.rejects(ops.rename("assets/maps/Cave.png", "City Map.webp"), /extension/);
  write("assets/maps/taken.png");
  await assert.rejects(ops.rename("assets/maps/Cave.png", "taken.png"), /already exists/);
  await assert.rejects(ops.rename("assets/maps/Cave.png", "../x.png"), /slashes|dot/);
  assert.equal((await ops.rename("assets/maps", "Maps")).to, "assets/Maps");
  await assert.rejects(ops.rename("assets", "worlds"), /worlds/);
});

test("move never overwrites and refuses folders into themselves", async () => {
  write("assets/tokens/cave.png", "other");
  const { results } = await ops.move(["assets/maps/cave.png", "assets/maps/City%20Map.webp"], "assets/tokens");
  assert.match(results[0].error, /already exists/);
  assert.equal(results[1].to, "assets/tokens/City%20Map.webp");
  const self = await ops.move(["assets"], "assets/maps");
  assert.match(self.results[0].error, /into itself/);
  const pkg = await ops.move(["assets/tokens/bob.png"], "worlds");
  assert.ok(pkg.results[0].error);
  const ok = await ops.move(["assets/tokens/bob.png"], "worlds/test");
  assert.equal(ok.results[0].to, "worlds/test/bob.png");
});

test("nested paths collapse into their folder", () => {
  assert.deepEqual(nested(["a/b", "a", "a/b/c.png", "d/e.png", "ab"]), ["a", "d/e.png", "ab"]);
});

/* -------------------------------------------- */
/*  HTTP                                        */
/* -------------------------------------------- */

const TOKEN = "test-token-0123456789";
let server;
let base;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimancer-files-http-"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets", "a.png"), "a");
  server = createServer({ dataRoot: dir, token: TOKEN, corsOrigin: "http://localhost:30000" });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = (p, body, token = TOKEN) => fetch(base + p, {
  method: body ? "POST" : "GET",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: body ? JSON.stringify(body) : undefined
});

test("http: token is required", async () => {
  assert.equal((await call("/health", null, "wrong")).status, 401);
  assert.equal((await call("/health", null, "")).status, 401);
  const ok = await call("/health");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:30000");
  const loopback = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: "http://127.0.0.1:30000" } });
  assert.equal(loopback.headers.get("access-control-allow-origin"), "http://127.0.0.1:30000");
});

test("http: works with and without the proxy prefix", async () => {
  assert.equal((await call("/dimancer-files/health")).status, 200);
  assert.equal((await call("/foundry/dimancer-files/health")).status, 200);
  assert.equal((await call("/nope")).status, 404);
});

test("http: errors carry their status", async () => {
  const res = await call("/stat", { paths: ["assets/a.png"] });
  assert.equal((await res.json()).entries[0].size, 1);
  const bad = await call("/rename", { path: "assets/missing.png", name: "b.png" });
  assert.equal(bad.status, 404);
  assert.match((await bad.json()).error, /Not found/);
  const json = await fetch(`${base}/stat`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: "{" });
  assert.equal(json.status, 400);
});

test("http: short tokens are refused at start", () => {
  assert.throws(() => createServer({ dataRoot: os.tmpdir(), token: "short" }), /16/);
});
