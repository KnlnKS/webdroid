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

/** `?bytecode=android/graphics/text/,android/graphics/fonts/` cuts those prefixes over for one
 *  page load. A cut is meant to be one line and a measurement, and a URL
 *  parameter is what lets the same bundle be A/B'd against itself — by the e2e driver, by a
 *  comparison script, or by hand — instead of needing an edit and a rebuild to try one. */
const fromUrl = typeof location !== "undefined" ? new URLSearchParams(location.search).get("bytecode") : null;

/** class-name prefixes served by AOSP bytecode instead of a native spec */
export const BYTECODE: string[] = fromUrl ? fromUrl.split(",").map((s) => s.trim()).filter(Boolean) : [];

export function isBytecode(name: string): boolean {
  for (const p of BYTECODE) if (name.startsWith(p)) return true;
  return false;
}

/** the framework jar is only worth fetching when something is actually cut over to it */
export const needsFramework = (): boolean => BYTECODE.length > 0;
