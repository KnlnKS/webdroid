import { rt } from "../jvm/runtime.ts";

// No DRM plugin is installed: no scheme is supported, and creating a MediaDrm or MediaCrypto
// fails as the JNI does when the plugin factory has none.
rt.registerJnis("android/media/MediaDrm", {
  "native_init()V": () => {},
  "isCryptoSchemeSupportedNative([BLjava/lang/String;I)Z": () => 0,
  "getSupportedCryptoSchemesNative()[B": () => new Int8Array(0),
  "native_setup(Ljava/lang/Object;[BLjava/lang/String;)V": () => {
    throw rt.mkThrowable("android/media/UnsupportedSchemeException", "Failed to instantiate drm object.");
  },
});
rt.registerJnis("android/media/MediaCrypto", {
  "native_init()V": () => {},
  "isCryptoSchemeSupportedNative([B)Z": () => 0,
  "native_setup([B[B)V": () => { throw rt.mkThrowable("android/media/MediaCryptoException", "Failed to instantiate crypto object."); },
});
