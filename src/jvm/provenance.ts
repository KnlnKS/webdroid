// Which classes a TS spec may stand in for: everywhere else AOSP's own bytecode answers and a spec implements natives only
// (docs/architecture.md). desccheck holds every registered spec to this.

/** The only classes whose AOSP bytecode bodies a TS spec may stand in for (anywhere else a spec
 *  implements natives only), by exact name or package prefix (ending in `/`), each with why AOSP's
 *  bytecode cannot answer for it. In libcore's namespaces a spec needs an entry even for natives. */
export const TS_SPECS: Record<string, string> = {
  "java/net/HttpURLConnection": "HTTP over the fetch proxy",
  "javax/net/ssl/": "TLS at the relay",
  "com/android/okhttp/HttpHandler": "HTTP over the fetch proxy",
  "com/android/okhttp/HttpsHandler": "HTTPS over the fetch proxy",
  "com/android/org/conscrypt/SSLParametersImpl": "TLS at the relay",
  "android/net/ssl/SSLSockets": "TLS at the relay, whose sockets are not Conscrypt's",
  "android/webkit/WebViewFactory": "the WebView provider over the browser",
};

/** the TS_SPECS key that allows `name`, if any */
export const tsSpecAllowance = (name: string): string | undefined =>
  name in TS_SPECS ? name : Object.keys(TS_SPECS).find((k) => k.endsWith("/") && name.startsWith(k));
/** libcore's namespaces, where AOSP's bytecode answers unless a spec is allowed there */
const LIBCORE = /^(java|javax|jdk|sun|libcore|dalvik|android\/icu|org\/(json|xml|w3c|xmlpull)|com\/android\/(okhttp|org))\//;
/** does a spec for `name` break the platform rules (docs/architecture.md): one that `reimplements` an AOSP bytecode body, or any in
 *  libcore's namespaces, needs TS_SPECS to allow its class */
export const tsSpecViolation = (name: string, reimplements: boolean): boolean =>
  (reimplements || LIBCORE.test(name)) && !tsSpecAllowance(name);

export { PLATFORM_JARS } from "./bootclasspath.ts";
