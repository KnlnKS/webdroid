// What oracle.ts's `tests/platform` import does in the probe page: the boot class path the way a tab indexes it, and the /apex data.
import { fetchPlatformJars, loadPlatformJar } from "../../src/android/framework";
import { mountPlatformData } from "../../src/shell/apex";

(await fetchPlatformJars()).forEach((jar, i) => loadPlatformJar(jar, i));
mountPlatformData();
