/**
 * Talking to the companion service (a separate install: COMPANION_URL).
 *
 * The GM logs in with the companion's secret once per Foundry session. The secret is sent once and
 * never stored. What comes back is a short-lived session token, kept in this page's memory only: a
 * reload logs out, and the companion ends it on logout, expiry or restart.
 */
import { MODULE_ID } from "./constants.mjs";
import { SETTINGS, setting } from "./settings.mjs";

const CHECK_EVERY = 60_000;

/** The companion HTTP API versions this module speaks (the companion's /health `api`). */
export const COMPANION_API = [2];

/** Repository of the separately installed companion service. */
export const COMPANION_URL = "https://github.com/djachkov/dimancer-files-companion";

/** A health answer as a status: refuses a companion whose API this module doesn't know. */
function healthStatus(r) {
  if ( !COMPANION_API.includes(r?.api) ) {
    return { ok: false, at: Date.now(),
      error: game.i18n.format("DIMANCER_FILES.Companion.Incompatible", { url: COMPANION_URL }) };
  }
  return { ok: true, api: r.api, at: Date.now() };
}

class CompanionClient {
  /** Whether the service answers and speaks our API: {ok, api?, error?, at}. */
  status = null;

  /** The login, in memory only: {token, expiresAt, version, policy: {permanent, roots, trashDays}}. */
  #session = null;

  #checking = null;

  #expiryTimer = null;

  /** Where the service is (this browser only). Holds no secret. */
  get config() {
    return { url: setting(SETTINGS.companion)?.url ?? "" };
  }

  /** Remove a token an older version kept in this browser's storage. */
  async forgetStoredToken() {
    const stored = setting(SETTINGS.companion) ?? {};
    if ( "token" in stored ) await game.settings.set(MODULE_ID, SETTINGS.companion, { url: stored.url ?? "" });
  }

  /** The service's base URL: as configured, or /dimancer-files on Foundry's own origin. */
  get base() {
    return this.#baseOf(this.config);
  }

  #baseOf(config) {
    const url = (config.url ?? "").trim().replace(/\/+$/, "");
    return url || foundry.utils.getRoute("dimancer-files").replace(/\/+$/, "");
  }

  get loggedIn() {
    return !!this.#session && (this.#session.expiresAt > Date.now());
  }

  /** The login for the UI, without its token: {expiresAt, version, policy}, or null. */
  get session() {
    if ( !this.loggedIn ) return null;
    const { expiresAt, version, policy } = this.#session;
    return { expiresAt, version, policy };
  }

  /** What the server allows: {permanent, roots}. Nothing permanent until logged in. */
  get policy() {
    return { permanent: false, roots: [], trashDays: 0, ...(this.session?.policy ?? {}) };
  }

  /** Whether file changes can be offered: a GM, logged in, to a service that answered. */
  get available() {
    return !!(game.user.isGM && this.status?.ok && this.loggedIn);
  }

  async saveConfig({ url }) {
    await game.settings.set(MODULE_ID, SETTINGS.companion, { url: url ?? "" });
    this.status = null;
    return this.check({ force: true });
  }

  /** Ask a URL whether a compatible companion runs there, without saving it. */
  async probe(config) {
    try {
      return healthStatus(await this.request("health", null, { timeout: 4000, config, auth: false }));
    } catch (err) {
      return { ok: false, error: err.message, at: Date.now() };
    }
  }

  /**
   * Whether the service is there, at most once a minute unless forced. Needs no login.
   * @returns {Promise<CompanionClient["status"]>}
   */
  async check({ force = false } = {}) {
    if ( !game.user.isGM ) return this.status = { ok: false, error: "GM only", at: Date.now() };
    if ( !force && this.status && (Date.now() - this.status.at < CHECK_EVERY) ) return this.status;
    this.#checking ??= this.request("health", null, { timeout: 4000, auth: false })
      .then(healthStatus)
      .catch(err => ({ ok: false, error: err.message, at: Date.now() }))
      .finally(() => this.#checking = null);
    this.status = await this.#checking;
    return this.status;
  }

  /**
   * Log in with the companion's secret. The secret is sent once and not kept.
   * @param {string} secret
   * @param {{url?: string}} [config]  Where, if not the saved address.
   */
  async login(secret, config = this.config) {
    const r = await this.request("session", {}, { config, auth: secret, timeout: 8000 });
    if ( !COMPANION_API.includes(r.api) ) {
      throw new Error(game.i18n.format("DIMANCER_FILES.Companion.Incompatible", { url: COMPANION_URL }));
    }
    this.#session = { token: r.session, expiresAt: r.expiresAt, version: r.version, policy: r.policy ?? {} };
    this.status = { ok: true, api: r.api, at: Date.now() };
    // Show the logged-out state when it runs out, without waiting for a failed request.
    clearTimeout(this.#expiryTimer);
    this.#expiryTimer = setTimeout(() => this.#ended(), Math.min(r.expiresAt - Date.now(), 2 ** 31 - 1));
    this.#refreshBrowsers();
    return this.session;
  }

  /** End the session here and on the server. */
  async logout() {
    const token = this.#session?.token;
    this.#ended();
    if ( token ) await this.request("session/end", {}, { auth: token, timeout: 4000 }).catch(() => {});
  }

  #ended() {
    clearTimeout(this.#expiryTimer);
    const was = !!this.#session;
    this.#session = null;
    if ( was ) this.#refreshBrowsers();
  }

  /** Open file browsers show or hide the companion's actions. */
  #refreshBrowsers() {
    for ( const app of foundry.applications.instances.values() ) {
      if ( app.options?.classes?.includes("dimancer-files") && app.rendered ) app.render();
    }
  }

  /**
   * Call an endpoint. GET without a body, POST with one. Throws with the service's error message.
   * Uses the session unless `auth` gives a credential (or false for none).
   * @param {string} endpoint  e.g. "delete" or "trash/restore"
   * @param {object|null} body
   */
  async request(endpoint, body = {}, { timeout = 60_000, config = this.config, auth } = {}) {
    const base = this.#baseOf(config);
    if ( (auth === undefined) && !this.loggedIn ) {
      throw new Error(game.i18n.localize("DIMANCER_FILES.Companion.LoginNeeded"));
    }
    const credential = auth === undefined ? this.#session.token : auth;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetch(`${base}/${endpoint}`, {
        method: body ? "POST" : "GET",
        headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), "Content-Type": "application/json" },
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
    // The session ended on the server (expiry, logout elsewhere, restart).
    if ( (response.status === 401) && data?.login && (auth === undefined) ) {
      this.#ended();
      throw new Error(game.i18n.localize("DIMANCER_FILES.Companion.LoginNeeded"));
    }
    if ( !response.ok ) throw new Error(data?.error ?? `HTTP ${response.status}`);
    return data;
  }
}

export const companion = new CompanionClient();
