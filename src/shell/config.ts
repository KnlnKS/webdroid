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
  /** the gesture/navigation bar: not painted (the activity spans the whole framebuffer), but it
   *  is what the device reports as the bottom window inset, so an edge-to-edge app pads for it */
  navBar: 48,
  density: 2,
  densityDpi: 320,
  sdk: 35,
  release: "15",
  lang: "en",
  /** what /proc/cpuinfo, /proc/meminfo and uname report to native code: an ARMv7 with VFPv3 and
   *  no NEON (the ARM32 tier implements VFP, not the SIMD extension) */
  cpu: { cores: 4, features: "swp half thumb fastmult vfp edsp thumbee vfpv3 tls", hardware: "webdroid", memKb: 2 * 1024 * 1024 },
  get widthDp(): number { return Math.round(this.width / this.density); },
  /** the activity's height in dp — the status bar is not part of it */
  get heightDp(): number { return Math.round((this.height - this.statusBar) / this.density); },
  /** full display height in dp, status bar included (resource qualifiers use this) */
  get screenHeightDp(): number { return Math.round(this.height / this.density); },
};
