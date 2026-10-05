// Which implementation of a framework class wins: ours, or AOSP's own bytecode.
//
// This is the ONLY place that decision is made, so it can be ranked, reported and A/B'd
// rather than implied by import order in src/natives.ts. HostStubGen drives the same
// decision for Ravenwood from a policy file, for the same reason.
//
// Adding a prefix moves that subtree onto
// vendor/aosp/framework.jar and withholds our native spec for it, which is what makes a cut
// one line and a measurement rather than a rewrite.
//
// A cut is a class AND its whole super chain. A native spec's fieldTable holds only what
// `fields:` declared — almost nothing — so bytecode that does `iget` on a native superclass
// misses, logs, and reads `undefined` with no throw. android/view/View is a clean cut for
// exactly this reason: its super is java/lang/Object, which has no fields.

/** `?bytecode=android/graphics/text/,android/graphics/fonts/` (headless: WEBDROID_BYTECODE) cuts
 *  those prefixes over too for one page load, so a further cut can be A/B'd against the same bundle
 *  — by the e2e driver, by a comparison script, or by hand — without an edit and a rebuild. */
const fromUrl = typeof location !== "undefined" ? new URLSearchParams(location.search).get("bytecode")
  : typeof process !== "undefined" ? process.env.WEBDROID_BYTECODE ?? null : null;

/** Stage D's coupled set: the application framework (ActivityThread, Activity, ContextImpl), the
 *  view stack, windows and the framework side of android.content, over TS system services.
 *  GLSurfaceView is a SurfaceView and GestureOverlayView a FrameLayout, so they go with the view
 *  stack; GLSurfaceView's GLThread drives EGL10. Services outside android/app (tiles, media
 *  browsers, route providers) are Services, so they go with it. */
const STAGE_D = ["android/app/", "android/view/", "android/widget/", "android/content/", "android/window/", "android/transition/",
  "android/preference/", "android/inputmethodservice/", "android/accessibilityservice/", "com/android/internal/policy/",
  "android/opengl/GLSurfaceView", "android/gesture/", "android/service/quicksettings/", "android/service/media/",
  "android/media/MediaRoute2ProviderService"];

/** class-name prefixes served by AOSP bytecode instead of a native spec; one ending in `$` names
 *  just that class and its inner classes (`java/io/File$` leaves FileInputStream alone). STAGE_D is
 *  always cut over. */
export const BYTECODE: string[] = [...STAGE_D, ...(fromUrl ?? "").split(",").map((s) => s.trim()).filter(Boolean)];


/** under Stage D's static cut, which withholds a TS spec in every load */
export const isStageD = (name: string): boolean => STAGE_D.some((p) => name.startsWith(p));

export function isBytecode(name: string): boolean {
  for (const p of BYTECODE) if (name.startsWith(p) || p.endsWith("$") && name === p.slice(0, -1)) return true;
  return false;
}

/** §2: the only classes whose AOSP bytecode bodies a TS spec may stand in for (anywhere else a spec
 *  implements natives only), by exact name or package prefix (ending in `/`), each with why AOSP's
 *  bytecode cannot answer for it. In libcore's namespaces a spec needs an entry even for natives. */
export const TS_SPECS: Record<string, `${"vm" | "boundary" | "intrinsic"}: ${string}`> = {
  "java/lang/Object": "vm: object model",
  "java/lang/Class": "vm: class objects over the JVM's link state",
  "java/lang/ClassLoader": "vm: defining loaders",
  "java/lang/String": "vm: Java strings are JS strings",
  "java/lang/Thread": "vm: threads over cooperative suspension",
  "java/lang/Throwable": "vm: stack capture from JS frames",
  "java/lang/System": "vm: arraycopy, clocks, identity hashes and caller-sensitive library loading over libcore's class",
  "java/lang/StringBuilder": "intrinsic: libcore's appends are 8-15x slower (§4.7, tests/intrinsics.test.ts)",
  "java/lang/StringBuffer": "intrinsic: as StringBuilder",
  "java/lang/reflect/": "vm: reflection over the JVM's link state",
  "java/lang/invoke/": "vm: method handles and var handles",
  "java/lang/ref/": "vm: references over JS weak references",
  "jdk/internal/misc/Unsafe": "vm: field and array access",
  "sun/misc/Unsafe": "vm: field and array access",
  "dalvik/system/": "vm: dex files, class loaders, VMRuntime and VMStack",
  "libcore/util/NativeAllocationRegistry": "vm: native allocations released with their owner",
  "java/net/HttpURLConnection": "boundary: HTTP over the fetch proxy",
  "android/icu/util/ULocale": "intrinsic: addLikelySubtags over a page-shared decode of langInfo's table, so no realm decodes LikelySubtags.Data (Typeface.<clinit> warm: first realm 88 -> 75 ms, a process realm 61-109 -> 17-21 ms; §4.7, tests/intrinsics.test.ts)",
  "javax/net/ssl/": "boundary: TLS at the relay",
  "com/android/okhttp/HttpHandler": "boundary: HTTP over the fetch proxy",
  "com/android/okhttp/HttpsHandler": "boundary: HTTPS over the fetch proxy",
  "com/android/org/conscrypt/SSLParametersImpl": "boundary: TLS at the relay",
  "javax/microedition/khronos/": "boundary: GL over the browser's WebGL",
  "android/net/ssl/SSLSockets": "boundary: TLS at the relay, whose sockets are not Conscrypt's",
  "android/webkit/WebViewFactory": "boundary: the WebView provider over the browser",
};

/** classes of the platform jars that the host implements whole: the JS tier does not load their bytecode, and neither does the Wasm tier run their initializers */
export const hostWhole = (name: string): boolean => name.startsWith("javax/microedition/khronos/");

/** the TS_SPECS key that allows `name`, if any */
export const tsSpecAllowance = (name: string): string | undefined =>
  name in TS_SPECS ? name : Object.keys(TS_SPECS).find((k) => k.endsWith("/") && name.startsWith(k));
/** libcore's namespaces, where AOSP's bytecode answers unless a spec is allowed there */
const LIBCORE = /^(java|javax|jdk|sun|libcore|dalvik|android\/icu|org\/(json|xml|w3c|xmlpull)|com\/android\/(okhttp|org))\//;
/** does a spec for `name` break §2: one that `reimplements` an AOSP bytecode body, or any in
 *  libcore's namespaces, needs TS_SPECS to allow its class */
export const tsSpecViolation = (name: string, reimplements: boolean): boolean =>
  (reimplements || LIBCORE.test(name)) && !tsSpecAllowance(name);

export { PLATFORM_JARS } from "./bootclasspath";
