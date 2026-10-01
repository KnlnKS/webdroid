// INetworkStatsService, under AOSP's NetworkStatsManager and android.app.usage.NetworkStats: no
// kernel accounting records traffic here (TrafficStats answers UNSUPPORTED), so every session's
// summary is empty and every history has no buckets.
import { JObj, rt, noops } from "../jvm/runtime";
import { newObj } from "../jvm/natives/jlang";
import { uptimeMillis } from "../guest-clock";
import { hostStub, newStub } from "./binder";

const NS = "Landroid/net/NetworkStats;", NSH = "Landroid/net/NetworkStatsHistory;", T = "Landroid/net/NetworkTemplate;";
/** NetworkStatsService's default history bucket, Settings.Global netstats_uid_bucket_duration (2 h) */
const BUCKET_MS = 2n * 3600_000n;
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
rt.register({ name: "webdroid/NetworkStatsService", ctor: class extends JObj {}, sup: "android/net/INetworkStatsService$Stub", methods: {
  "openSession()Landroid/net/INetworkStatsSession;": session,
  "openSessionForUsageStats(ILjava/lang/String;)Landroid/net/INetworkStatsSession;": session,
  ...noops("forceUpdate()V"),
} });
hostStub("netstats", "webdroid/NetworkStatsService");
