#!/usr/bin/env node
/**
 * dimancer_files companion: a tiny HTTP service that runs next to Foundry and does the file
 * operations Foundry's server can't (delete, move, rename, sizes, recursive search).
 * Node built-ins only; nothing to install.
 *
 * Environment:
 *   FOUNDRY_DATA          the Foundry "Data" folder (required)
 *   DIMANCER_FILES_TOKEN  shared secret the GM enters in Foundry (required, 16+ characters)
 *   PORT                  default 30001
 *   HOST                  default 127.0.0.1; keep it local and put it behind your reverse proxy
 *   CORS_ORIGIN           allow a different origin, e.g. http://localhost:30000 for local dev
 */
import crypto from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { Operations } from "./operations.mjs";
import { PathError } from "./paths.mjs";

export const VERSION = "0.1.0";
const MAX_BODY = 1024 * 1024;
/** The path the client uses on Foundry's origin; see README for the proxy rule. */
export const BASE_PATH = "/dimancer-files";

/**
 * Build the request handler. Exported for the tests.
 * @param {{dataRoot: string, token: string, corsOrigin?: string, log?: Function}} config
 */
export function createServer({ dataRoot, token, corsOrigin = "", log = () => {} }) {
  if ( !token || token.length < 16 ) throw new Error("DIMANCER_FILES_TOKEN must be at least 16 characters.");
  const ops = new Operations(dataRoot);
  const expected = crypto.createHash("sha256").update(token).digest();

  const authorized = req => {
    const header = req.headers.authorization ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    const hash = crypto.createHash("sha256").update(given).digest();
    return crypto.timingSafeEqual(hash, expected);
  };

  const routes = {
    "GET /health": () => ({ ok: true, version: VERSION }),
    "POST /stat": b => ({ entries: ops.stat(b.paths) }),
    "POST /search": b => ops.search(b),
    "POST /delete": b => ops.delete(b.paths, { permanent: b.permanent === true }),
    "POST /rename": b => ops.rename(b.path, b.name),
    "POST /move": b => ops.move(b.paths, b.toDir),
    "GET /trash": () => ops.trashList(),
    "POST /trash/restore": b => ops.trashRestore(b.ids),
    "POST /trash/empty": b => ops.trashEmpty(b.ids)
  };

  // Comma-separated; localhost and 127.0.0.1 stand for each other, since browsers treat them as
  // different origins and Foundry is reachable on both.
  const origins = new Set();
  for ( const o of String(corsOrigin).split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean) ) {
    origins.add(o);
    origins.add(o.replace("//localhost", "//127.0.0.1"));
    origins.add(o.replace("//127.0.0.1", "//localhost"));
  }

  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if ( origin && origins.size && !origins.has(origin) ) {
      log(`refused origin ${origin} (allowed: ${[...origins].join(", ")})`);
    }
    const send = (status, body) => {
      const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
      if ( origins.size ) {
        Object.assign(headers, {
          "Access-Control-Allow-Origin": origins.has(origin) ? origin : [...origins][0],
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          Vary: "Origin"
        });
      }
      res.writeHead(status, headers);
      res.end(body === undefined ? "" : JSON.stringify(body));
    };

    if ( req.method === "OPTIONS" ) return send(204);
    // Work behind the /dimancer-files prefix whether or not the reverse proxy strips it.
    let pathname = new URL(req.url, "http://localhost").pathname.replace(/\/+$/, "") || "/";
    // Foundry may also run under a route prefix (/foundry/dimancer-files/...).
    const base = pathname.indexOf(`${BASE_PATH}/`);
    if ( base !== -1 ) pathname = pathname.slice(base + BASE_PATH.length);
    const route = `${req.method} ${pathname}`;
    if ( !(route in routes) ) return send(404, { error: "Unknown endpoint." });
    if ( !authorized(req) ) return send(401, { error: "Wrong or missing token." });

    try {
      const body = req.method === "POST" ? await readJSON(req) : {};
      const result = await routes[route](body);
      log(`${route} ok`);
      send(200, result);
    } catch (err) {
      const status = err instanceof PathError ? err.status : (err.status ?? 500);
      log(`${route} ${status} ${err.message}`);
      send(status, { error: err.message });
    }
  });
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if ( size > MAX_BODY ) {
        reject(Object.assign(new Error("Request too large."), { status: 413 }));
        req.destroy();
      }
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if ( !chunks.length ) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(body && typeof body === "object" ? body : {});
      } catch {
        reject(Object.assign(new Error("Body must be JSON."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/* -------------------------------------------- */
/*  Run directly                                */
/* -------------------------------------------- */

if ( import.meta.url === pathToFileURL(process.argv[1] ?? "").href ) {
  const { FOUNDRY_DATA, DIMANCER_FILES_TOKEN, PORT = "30001", HOST = "127.0.0.1", CORS_ORIGIN = "" } = process.env;
  if ( !FOUNDRY_DATA ) {
    console.error("Set FOUNDRY_DATA to the Foundry Data folder.");
    process.exit(1);
  }
  let server;
  try {
    server = createServer({
      dataRoot: FOUNDRY_DATA, token: DIMANCER_FILES_TOKEN, corsOrigin: CORS_ORIGIN,
      log: msg => console.log(`${new Date().toISOString()} ${msg}`)
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  server.listen(Number(PORT), HOST, () => {
    console.log(`dimancer_files companion ${VERSION} on http://${HOST}:${PORT} for ${FOUNDRY_DATA}`);
  });
}
