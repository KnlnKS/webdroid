// dalvik.system's class loaders run from libcore over the Wasm tier's loaders (wasm/host/boot.ts openDexes).
import { rt } from "../runtime.ts";

// libnativeloader's namespace for a class loader: native libraries load from the loader's own
// archives here (src/native/loader.ts), so there is nothing to set up and no error to report
rt.registerJni("com/android/internal/os/ClassLoaderFactory",
  "createClassloaderNamespace(Ljava/lang/ClassLoader;ILjava/lang/String;Ljava/lang/String;ZLjava/lang/String;Ljava/lang/String;)Ljava/lang/String;", () => null);
