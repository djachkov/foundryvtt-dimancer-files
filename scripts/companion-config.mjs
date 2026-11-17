import { TEMPLATES } from "./constants.mjs";
import { COMPANION_URL, companion } from "./companion-client.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The companion: where it runs (saved in this browser), and logging in to it for this session.
 * The secret typed here is sent once and never saved; the session lives in memory only.
 */
export default class CompanionConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "dimancer-files-companion",
    tag: "form",
    classes: ["dimancer-files-companion"],
    window: { title: "DIMANCER_FILES.Companion.Title", icon: "fa-solid fa-plug", contentClasses: ["standard-form"] },
    position: { width: 540 },
    form: { handler: CompanionConfig.#onSubmit, closeOnSubmit: false },
    actions: { test: CompanionConfig.#onTest, login: CompanionConfig.#onLogin, logout: CompanionConfig.#onLogout }
  };

  static PARTS = {
    form: { template: TEMPLATES.companion },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** The result of the last Test, shown instead of the saved status. */
  #tested = null;

  /** The address typed but not saved yet, so re-renders keep it. */
  #typedUrl = null;

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const session = companion.session;
    return Object.assign(context, {
      url: this.#typedUrl ?? companion.config.url,
      placeholder: foundry.utils.getRoute("dimancer-files"),
      status: this.#tested ?? companion.status,
      session: session && {
        ...session,
        until: new Date(session.expiresAt).toLocaleTimeString(game.i18n.lang, { hour: "2-digit", minute: "2-digit" }),
        roots: session.policy.roots?.join(", ")
      },
      repo: COMPANION_URL,
      buttons: [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "DIMANCER_FILES.Companion.Save" }]
    });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    // Enter in the secret field logs in rather than submitting (saving) the form.
    this.element.querySelector("input[name=secret]")?.addEventListener("keydown", event => {
      if ( event.key !== "Enter" ) return;
      event.preventDefault();
      CompanionConfig.#onLogin.call(this);
    });
  }

  static async #onSubmit(_event, _form, formData) {
    await companion.saveConfig({ url: formData.object.url });
    this.#tested = this.#typedUrl = null;
    this.render();
  }

  static async #onTest() {
    const url = this.element.elements.url.value;
    this.#tested = await companion.probe({ url });
    this.#typedUrl = url;
    await this.render();
  }

  static async #onLogin() {
    const { url, secret } = this.element.elements;
    if ( !secret?.value ) return;
    try {
      // Logging in to an address also saves it.
      if ( url.value !== companion.config.url ) await companion.saveConfig({ url: url.value });
      const session = await companion.login(secret.value);
      ui.notifications.info("DIMANCER_FILES.Companion.LoggedInNote", { format: { version: session.version } });
      this.#tested = this.#typedUrl = null;
    } catch (err) {
      this.#tested = { ok: false, error: err.message };
    } finally {
      secret.value = "";
    }
    await this.render();
  }

  static async #onLogout() {
    await companion.logout();
    await this.render();
  }
}
