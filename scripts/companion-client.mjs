/**
 * Talking to the companion service (a separate install: COMPANION_URL). Only the GM's browser has the token.
 */
import { MODULE_ID } from "./constants.mjs";
import { SETTINGS, setting } from "./settings.mjs";

const CHECK_EVERY = 60_000;

/** The companion HTTP API versions this module speaks (the companion's /health `api`). */
export const COMPANION_API = [1];

/** Repository of the separately installed companion service. */
export const COMPANION_URL = "https://github.com/djachkov/foundryvtt-dimancer-files-companion";

/** A health answer as a status: refuses a companion whose API this module doesn't know. */
function healthStatus(r) {
  if ( !COMPANION_API.includes(r?.api) ) {
    return { ok: false, version: r?.version, at: Date.now(),
      error: game.i18n.format("DIMANCER_FILES.Companion.Incompatible", { version: r?.version ?? "?", url: COMPANION_URL }) };
  }
  return { ok: true, version: r.version, at: Date.now() };
}

class CompanionClient {
  /** @type {{ok: boolean, version?: string, error?: string, at: number}|null} */
  status = null;

  #checking = null;

  get config() {
    return { url: "", token: "", ...(setting(SETTINGS.companion) ?? {}) };
  }

  /** The service's base URL: as configured, or /dimancer-files on Foundry's own origin. */
  get base() {
    return this.#baseOf(this.config);
  }

  #baseOf(config) {
    const url = (config.url ?? "").trim().replace(/\/+$/, "");
    return url || foundry.utils.getRoute("dimancer-files").replace(/\/+$/, "");
  }

  /** Try a URL and token without saving them. */
  async probe(config) {
    try {
      return healthStatus(await this.request("health", null, { timeout: 4000, config }));
    } catch (err) {
      return { ok: false, error: err.message, at: Date.now() };
    }
  }

  /** Whether file changes can be offered: a GM with a token and a service that answered. */
  get available() {
    return !!(game.user.isGM && this.config.token && this.status?.ok);
  }

  async saveConfig({ url, token }) {
    await game.settings.set(MODULE_ID, SETTINGS.companion, { url: url ?? "", token: token ?? "" });
    this.status = null;
    return this.check({ force: true });
  }

  /**
   * Ask the service whether it's there, at most once a minute unless forced.
   * @returns {Promise<CompanionClient["status"]>}
   */
  async check({ force = false } = {}) {
    if ( !game.user.isGM || !this.config.token ) {
      this.status = { ok: false, error: "No token", at: Date.now() };
      return this.status;
    }
    if ( !force && this.status && (Date.now() - this.status.at < CHECK_EVERY) ) return this.status;
    this.#checking ??= this.request("health", null, { timeout: 4000 })
      .then(healthStatus)
      .catch(err => ({ ok: false, error: err.message, at: Date.now() }))
      .finally(() => this.#checking = null);
    this.status = await this.#checking;
    return this.status;
  }

  /**
   * Call an endpoint. GET without a body, POST with one. Throws with the service's error message.
   * @param {string} endpoint  e.g. "delete" or "trash/restore"
   * @param {object|null} body
   */
  async request(endpoint, body = {}, { timeout = 60_000, config = this.config } = {}) {
    const base = this.#baseOf(config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetch(`${base}/${endpoint}`, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        cache: "no-store"
      });
    } catch (err) {
      throw new Error(err.name === "AbortError"
        ? game.i18n.localize("DIMANCER_FILES.Companion.Timeout")
        : game.i18n.format("DIMANCER_FILES.Companion.Unreachable", { url: base, origin: window.location.origin }));
    } finally {
      clearTimeout(timer);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(game.i18n.format("DIMANCER_FILES.Companion.NotCompanion", { url: base }));
    }
    if ( !response.ok ) throw new Error(data?.error ?? `HTTP ${response.status}`);
    return data;
  }
}

export const companion = new CompanionClient();
