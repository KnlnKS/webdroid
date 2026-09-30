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

/** class-name prefixes served by AOSP bytecode instead of a native spec; one ending in `$` names
 *  just that class and its inner classes (`java/io/File$` leaves FileInputStream alone) */
export const BYTECODE: string[] = fromUrl ? fromUrl.split(",").map((s) => s.trim()).filter(Boolean) : [];

export function isBytecode(name: string): boolean {
  for (const p of BYTECODE) if (name.startsWith(p) || p.endsWith("$") && name === p.slice(0, -1)) return true;
  return false;
}

/** §2: the only classes in libcore's namespaces a TS spec may implement, by exact name or package
 *  prefix (ending in `/`), each with why AOSP's bytecode cannot answer for it */
export const TS_SPECS: Record<string, `${"vm" | "boundary" | "intrinsic"}: ${string}`> = {
  "java/lang/Object": "vm: object model",
  "java/lang/Class": "vm: class objects over the JVM's link state",
  "java/lang/ClassLoader": "vm: defining loaders",
  "java/lang/String": "vm: Java strings are JS strings",
  "java/lang/Thread": "vm: threads over cooperative suspension",
  "java/lang/Throwable": "vm: stack capture from JS frames",
  "java/lang/System": "vm: arraycopy, clocks, identity hashes, properties",
  "java/lang/Runtime": "vm: memory limits, library loading",
  "java/lang/StringBuilder": "intrinsic: libcore's appends are 8-15x slower (§4.7, tests/intrinsics.test.ts)",
  "java/lang/StringBuffer": "intrinsic: as StringBuilder",
  "java/lang/reflect/": "vm: reflection over the JVM's link state",
  "java/lang/invoke/": "vm: method handles and var handles",
  "java/lang/ref/": "vm: references over JS weak references",
  "jdk/internal/misc/Unsafe": "vm: field and array access",
  "sun/misc/Unsafe": "vm: field and array access",
  "dalvik/system/": "vm: dex files, class loaders, VMRuntime and VMStack",
  "dalvik/annotation/Signature": "vm: generic signatures",
  "libcore/util/NativeAllocationRegistry": "vm: native allocations released with their owner",
  "libcore/io/ClassPathURLStreamHandler": "vm: class-path resources",
  "java/net/HttpURLConnection": "boundary: HTTP over the fetch proxy",
  "javax/net/ssl/": "boundary: TLS at the relay",
  "com/android/okhttp/HttpHandler": "boundary: HTTP over the fetch proxy",
  "com/android/okhttp/HttpsHandler": "boundary: HTTPS over the fetch proxy",
  "com/android/org/conscrypt/SSLParametersImpl": "boundary: TLS at the relay",
  "javax/microedition/khronos/": "boundary: GL over the browser's WebGL",
};

/** the TS_SPECS key that allows `name`, if any */
export const tsSpecAllowance = (name: string): string | undefined =>
  name in TS_SPECS ? name : Object.keys(TS_SPECS).find((k) => k.endsWith("/") && name.startsWith(k));

export { PLATFORM_JARS } from "./bootclasspath";
