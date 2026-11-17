import { TEMPLATES } from "./constants.mjs";
import { companion } from "./companion-client.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Settings menu: where the companion runs and its token. Stored in this browser only. */
export default class CompanionConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "dimancer-files-companion",
    tag: "form",
    classes: ["dimancer-files-companion"],
    window: { title: "DIMANCER_FILES.Companion.Title", icon: "fa-solid fa-plug", contentClasses: ["standard-form"] },
    position: { width: 520 },
    form: { handler: CompanionConfig.#onSubmit, closeOnSubmit: false },
    actions: { test: CompanionConfig.#onTest, reveal: CompanionConfig.#onReveal }
  };

  static PARTS = {
    form: { template: TEMPLATES.companion },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const { url, token } = this.#typed ?? companion.config;
    return Object.assign(context, {
      url,
      token,
      placeholder: foundry.utils.getRoute("dimancer-files"),
      status: this.#tested ?? companion.status,
      buttons: [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "DIMANCER_FILES.Companion.Save" }]
    });
  }

  static async #onSubmit(_event, _form, formData) {
    const { url, token } = formData.object;
    const status = await companion.saveConfig({ url, token });
    this.#tested = this.#typed = null;
    if ( status.ok ) ui.notifications.info("DIMANCER_FILES.Companion.Connected", { format: { version: status.version } });
    this.render();
  }

  /** The result of the last Test, shown instead of the saved status. */
  #tested = null;

  static async #onTest() {
    const { url, token } = this.element.elements;
    this.#tested = await companion.probe({ url: url.value, token: token.value });
    this.#typed = { url: url.value, token: token.value };
    await this.render();
  }

  /** What was typed when testing, so the re-render keeps it. */
  #typed = null;

  static #onReveal(_event, button) {
    const input = this.element.elements.token;
    input.type = input.type === "password" ? "text" : "password";
    button.classList.toggle("fa-eye-slash", input.type === "text");
  }
}
