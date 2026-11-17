export const MODULE_ID = "dimancer_files";

export const TEMPLATES = Object.freeze({
  sidebar: `modules/${MODULE_ID}/templates/sidebar.hbs`,
  toolbar: `modules/${MODULE_ID}/templates/toolbar.hbs`,
  files: `modules/${MODULE_ID}/templates/files.hbs`,
  details: `modules/${MODULE_ID}/templates/details.hbs`,
  footer: `modules/${MODULE_ID}/templates/footer.hbs`,
  companion: `modules/${MODULE_ID}/templates/companion-config.hbs`
});

/** How many entries a folder shows before "Show more", so huge folders open fast. */
export const PAGE_SIZE = 400;
