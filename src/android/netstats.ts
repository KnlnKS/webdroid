// INetworkStatsService, under AOSP's TrafficStats, NetworkStatsManager and android.app.usage.NetworkStats:
// no kernel accounting records traffic here, so every counter is UNSUPPORTED, every session's summary
// is empty and every history has no buckets.
import { JObj, rt, noops } from "../jvm/runtime.ts";
import { newObj } from "../jvm/natives/jentry.ts";
import { uptimeMillis } from "../guest-clock.ts";
import { hostService, newStub } from "./binder.ts";
import { strArray } from "../jvm/abi.ts";

const NS = "Landroid/net/NetworkStats;", NSH = "Landroid/net/NetworkStatsHistory;", T = "Landroid/net/NetworkTemplate;";
/** NetworkStatsService's default history bucket, Settings.Global netstats_uid_bucket_duration (2 h) */
const BUCKET_MS = 2n * 3600_000n;
const UNSUPPORTED = -1n;
const summary = () => newObj("android/net/NetworkStats", "(JI)V", BigInt(Math.floor(uptimeMillis())), 0);
const history = () => newObj("android/net/NetworkStatsHistory", "(J)V", BUCKET_MS);
rt.register({ name: "webdroid/NetworkStatsSession", ctor: class extends JObj {}, sup: "android/net/INetworkStatsSession$Stub", methods: {
  [`getSummaryForAllUid(${T}JJZ)${NS}`]: summary,
  [`getTaggedSummaryForAllUid(${T}JJ)${NS}`]: summary,
  [`getDeviceSummaryForNetwork(${T}JJ)${NS}`]: summary,
  [`getSummaryForNetwork(${T}JJ)${NS}`]: summary,
  [`getHistoryForNetwork(${T}I)${NSH}`]: history,
  [`getHistoryIntervalForNetwork(${T}IJJ)${NSH}`]: history,
  [`getHistoryForUid(${T}IIII)${NSH}`]: history,
  [`getHistoryIntervalForUid(${T}IIIIJJ)${NSH}`]: history,
  "getRelevantUids()[I": () => new Int32Array(0),
  ...noops("close()V"),
} });
const session = () => newStub("webdroid/NetworkStatsSession");
hostService("netstats", "webdroid/NetworkStatsService", "android/net/INetworkStatsService$Stub", {
  "openSession()Landroid/net/INetworkStatsSession;": session,
  "openSessionForUsageStats(ILjava/lang/String;)Landroid/net/INetworkStatsSession;": session,
  "getTotalStats(I)J": () => UNSUPPORTED,
  "getUidStats(II)J": () => UNSUPPORTED,
  "getIfaceStats(Ljava/lang/String;I)J": () => UNSUPPORTED,
  "getMobileIfaces()[Ljava/lang/String;": () => strArray([]),
  ...noops("forceUpdate()V", "incrementOperationCount(III)V", "clearTrafficStatsRateLimitCaches()V"),
});
// TrafficStats' socket tags reach libnetd_client's tagSocket, which with no fwmarkd to send them to
// reports success as FwmarkClient does when netd is not running; no accounting reads them
rt.claimNativeLib("framework-connectivity-tiramisu-jni");
rt.registerJnis("android/net/TrafficStats", {
  "native_tagSocketFd(Ljava/io/FileDescriptor;II)I": () => 0,
  "native_untagSocketFd(Ljava/io/FileDescriptor;)I": () => 0,
});
