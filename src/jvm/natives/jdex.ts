// dalvik.system's class loaders run from libcore over the Wasm tier's loaders (wasm/host/boot.ts openDexes).
import { rt } from "../runtime.ts";

/** the app's own archives, whose dex the process loaded at boot: a loader over them (LoadedApk's) is
 *  the app's class loader, over the classes the process already holds */
export const appArchives = new Set<string>();

// libnativeloader's namespace for a class loader: native libraries load from the loader's own
// archives here (src/native/loader.ts), so there is nothing to set up and no error to report
rt.registerJni("com/android/internal/os/ClassLoaderFactory",
  "createClassloaderNamespace(Ljava/lang/ClassLoader;ILjava/lang/String;Ljava/lang/String;ZLjava/lang/String;Ljava/lang/String;)Ljava/lang/String;", () => null);
