// libstats_jni: StatsLog's native write. This device runs no statsd, so libstatssocket's write
// finds no socket and the atom is dropped, as AOSP drops it when statsd is down.
import { rt } from "../jvm/runtime";

rt.claimNativeLib("stats_jni");
rt.registerJnis("android/util/StatsLog", { "writeImpl([BII)V": () => {} });
