import { JObj, rt } from "../jvm/runtime";

class JNetworkStats extends JObj { closed = false; }
class JNetworkStatsBucket extends JObj {
  uid = -1;
  rxBytes = 0n;
  txBytes = 0n;
}

rt.register({
  name: "android/app/usage/NetworkStats$Bucket", ctor: JNetworkStatsBucket,
  statics: { UID_ALL: -1, TAG_NONE: 0, STATE_ALL: -1, METERED_ALL: -1, ROAMING_ALL: -1 },
  methods: {
    "<init>()V": function () {},
    "getUid()I": function (this: JNetworkStatsBucket) { return this.uid; },
    "getRxBytes()J": function (this: JNetworkStatsBucket) { return this.rxBytes; },
    "getTxBytes()J": function (this: JNetworkStatsBucket) { return this.txBytes; },
  },
});
rt.register({
  name: "android/app/usage/NetworkStats", ctor: JNetworkStats, ifaces: ["java/lang/AutoCloseable"],
  methods: {
    "hasNextBucket()Z": function () { return 0; },
    "getNextBucket(Landroid/app/usage/NetworkStats$Bucket;)Z": function () { return 0; },
    "close()V": function (this: JNetworkStats) { this.closed = true; },
  },
});
rt.register({
  name: "android/app/usage/NetworkStatsManager", ctor: class extends JObj {},
  methods: {
    "querySummary(ILjava/lang/String;JJ)Landroid/app/usage/NetworkStats;": function () {
      return new JNetworkStats();
    },
  },
});
