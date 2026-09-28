// Which implementation of a framework class wins: ours, or AOSP's own bytecode.
//
// This is the ONLY place that decision is made, so it can be ranked, reported and A/B'd
// rather than implied by import order in src/natives.ts. HostStubGen drives the same
// decision for Ravenwood from a policy file, for the same reason.
//
// Empty keeps every native spec. Adding a prefix moves that subtree onto
// vendor/aosp/framework.jar and withholds our native spec for it, which is what makes a cut
// one line and a measurement rather than a rewrite.
//
// A cut is a class AND its whole super chain. A native spec's fieldTable holds only what
// `fields:` declared — almost nothing — so bytecode that does `iget` on a native superclass
// misses, logs, and reads `undefined` with no throw. android/view/View is a clean cut for
// exactly this reason: its super is java/lang/Object, which has no fields.

/** `?bytecode=android/graphics/text/,android/graphics/fonts/` (headless: WEBDROID_BYTECODE) cuts
 *  those prefixes over for one page load, so the same bundle can be A/B'd against itself — by the
 *  e2e driver, by a comparison script, or by hand — without an edit and a rebuild. */
const fromUrl = typeof location !== "undefined" ? new URLSearchParams(location.search).get("bytecode")
  : typeof process !== "undefined" ? process.env.WEBDROID_BYTECODE ?? null : null;

/** class-name prefixes served by AOSP bytecode instead of a native spec */
export const BYTECODE: string[] = fromUrl ? fromUrl.split(",").map((s) => s.trim()).filter(Boolean) : [];

export function isBytecode(name: string): boolean {
  for (const p of BYTECODE) if (name.startsWith(p)) return true;
  return false;
}

export { PLATFORM_JARS } from "./bootclasspath";
