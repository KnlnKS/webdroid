/**
 * The one device profile. Screen size, density and API level were spelled out as bare
 * literals in nine files, so "run this apk on a different device" meant a grep. Everything
 * that needs one of these numbers reads it from here instead.
 *
 * The framebuffer is `width x height` px; `statusBar` px of it are the system bar, so the
 * activity gets `height - statusBar`. Resource selection and Configuration use the dp sizes
 * derived from `density`.
 */
export const device = {
  width: 720,
  height: 1280,
  statusBar: 48,
  density: 2,
  densityDpi: 320,
  sdk: 33,
  release: "13",
  lang: "en",
  get widthDp(): number { return Math.round(this.width / this.density); },
  /** the activity's height in dp — the status bar is not part of it */
  get heightDp(): number { return Math.round((this.height - this.statusBar) / this.density); },
  /** full display height in dp, status bar included (resource qualifiers use this) */
  get screenHeightDp(): number { return Math.round(this.height / this.density); },
};
