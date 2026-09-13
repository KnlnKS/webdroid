import { defineException } from "../jvm/natives/jlang";
import { JObj, noops, rt } from "../jvm/runtime";

defineException("android/media/MediaDrmException", "java/lang/Exception", ["(Ljava/lang/String;)V"]);
defineException("android/media/UnsupportedSchemeException", "android/media/MediaDrmException", ["(Ljava/lang/String;)V"]);
defineException("android/media/MediaDrm$MediaDrmStateException", "java/lang/IllegalStateException", ["(Ljava/lang/String;)V"]);

rt.register({
  name: "android/media/MediaDrm", ctor: class extends JObj {}, ifaces: ["java/lang/AutoCloseable"],
  methods: {
    "<init>(Ljava/util/UUID;)V": function (uuid: unknown) {
      if (!uuid) return rt.npe();
      throw rt.mkThrowable("android/media/UnsupportedSchemeException", "No DRM schemes are available");
    },
    "static isCryptoSchemeSupported(Ljava/util/UUID;)Z": () => 0,
    "getPropertyString(Ljava/lang/String;)Ljava/lang/String;": () => {
      throw rt.mkThrowable("java/lang/IllegalStateException", "MediaDrm is not initialized");
    },
    ...noops("close()V", "release()V"),
  },
});
