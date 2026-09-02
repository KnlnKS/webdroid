// Conscrypt ships its own TLS stack as JNI over BoringSSL. Nothing in this environment can
// use it — sockets are shimmed and okhttp never gets to negotiate — but conscrypt's classes
// still LOAD, and their static initialisers interrogate the native layer before anything
// else happens. NativeCrypto.<clinit> in particular calls get_cipher_names("ALL") and
// indexes the result in pairs; an UnsatisfiedLinkError there poisons every provider lookup
// downstream. So these are capability answers, not crypto.
//
// These are `native` methods of the APK's OWN classes, so they go through the JNI registry.
// Registering android-style native classes for them would shadow the dex classes and kill
// the compiled access$ bridges their inner classes depend on.

import { rt } from "../jvm/runtime";

const jni = (sig: string, fn: (...a: never[]) => unknown) =>
  rt.registerJni("org/conscrypt/NativeCrypto", sig, fn);
rt.claimNativeLib("conscrypt_jni");

// Pairs of (IANA standard name, OpenSSL name), the shape SSL_CIPHER_standard_name /
// SSL_CIPHER_get_name produce. The clinit splits them: even entries become the supported
// TLS 1.2 suite list, odd entries the legacy-name set. TLS 1.3 suites are not in a cipher
// list on BoringSSL and conscrypt hardcodes them, so they are absent here too.
const CIPHERS = [
  "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256", "ECDHE-ECDSA-AES128-GCM-SHA256",
  "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256", "ECDHE-RSA-AES128-GCM-SHA256",
  "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384", "ECDHE-ECDSA-AES256-GCM-SHA384",
  "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384", "ECDHE-RSA-AES256-GCM-SHA384",
  "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256", "ECDHE-ECDSA-CHACHA20-POLY1305",
  "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256", "ECDHE-RSA-CHACHA20-POLY1305",
  "TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256", "ECDHE-PSK-CHACHA20-POLY1305",
  "TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA", "ECDHE-ECDSA-AES128-SHA",
  "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA", "ECDHE-RSA-AES128-SHA",
  "TLS_ECDHE_PSK_WITH_AES_128_CBC_SHA", "ECDHE-PSK-AES128-CBC-SHA",
  "TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA", "ECDHE-ECDSA-AES256-SHA",
  "TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA", "ECDHE-RSA-AES256-SHA",
  "TLS_ECDHE_PSK_WITH_AES_256_CBC_SHA", "ECDHE-PSK-AES256-CBC-SHA",
  "TLS_RSA_WITH_AES_128_GCM_SHA256", "AES128-GCM-SHA256",
  "TLS_RSA_WITH_AES_256_GCM_SHA384", "AES256-GCM-SHA384",
  "TLS_RSA_WITH_AES_128_CBC_SHA", "AES128-SHA",
  "TLS_RSA_WITH_AES_256_CBC_SHA", "AES256-SHA",
  "TLS_PSK_WITH_AES_128_CBC_SHA", "PSK-AES128-CBC-SHA",
  "TLS_PSK_WITH_AES_256_CBC_SHA", "PSK-AES256-CBC-SHA",
];

jni("get_cipher_names(Ljava/lang/String;)[Ljava/lang/String;", () => {
  const a = rt.oa(CIPHERS.length, "Ljava/lang/String;");
  for (let i = 0; i < CIPHERS.length; i++) a[i] = CIPHERS[i];
  return a;
});
// Answered honestly: there is no AES-NI to report through a JS canvas VM.
jni("EVP_has_aes_hardware()I", () => 0);
