// java.util.concurrent.TimeUnit on one JS thread.

import { rt } from "../runtime";
import { JEnum, enumValueOf, curThread, park } from "./jlang";
import { jarray } from "../abi";

// ── TimeUnit (enum-like native)
export class JTimeUnit extends JEnum { ms = 1; ns = 1000000n; }
// enum constant, the to* method's suffix, one unit in nanoseconds
const TU_DEFS: [string, string, bigint][] = [
  ["NANOSECONDS", "Nanos", 1n], ["MICROSECONDS", "Micros", 1000n], ["MILLISECONDS", "Millis", 1000000n],
  ["SECONDS", "Seconds", 1000000000n], ["MINUTES", "Minutes", 60000000000n],
  ["HOURS", "Hours", 3600000000000n], ["DAYS", "Days", 86400000000000n],
];
const MAX_LONG = 9223372036854775807n, MIN_LONG = -9223372036854775808n;
/** Java truncates toward zero and saturates instead of overflowing */
const tuConvert = (v: bigint, from: bigint, to: bigint) => {
  const r = (v * from) / to;
  return r > MAX_LONG ? MAX_LONG : r < MIN_LONG ? MIN_LONG : r;
};
const TUS = Object.fromEntries(TU_DEFS.map(([name, , ns], ord) => {
  const t = new JTimeUnit();
  t.ename = name; t.ord = ord; t.ns = ns; t.ms = Number(ns) / 1e6;
  return [name, t];
})) as Record<string, JTimeUnit>;
const timeUnits = Object.values(TUS);
rt.register({
  name: "java/util/concurrent/TimeUnit", ctor: JTimeUnit, sup: "java/lang/Enum",
  statics: { ...TUS },
  methods: {
    "static values()[Ljava/util/concurrent/TimeUnit;": () => jarray(timeUnits.slice(), "Ljava/util/concurrent/TimeUnit;"),
    "static valueOf(Ljava/lang/String;)Ljava/util/concurrent/TimeUnit;": (name: string) => enumValueOf(timeUnits, name),
    ...Object.fromEntries(TU_DEFS.map(([, method, ns]) =>
      [`to${method}(J)J`, function (this: JTimeUnit, v: bigint) { return tuConvert(v, this.ns, ns); }])),
    "convert(JLjava/util/concurrent/TimeUnit;)J": function (this: JTimeUnit, v: bigint, src: JTimeUnit) {
      return tuConvert(v, src.ns, this.ns);
    },
    "sleep(J)V": function (this: JTimeUnit, v: bigint) { return park(curThread, () => () => {}, Number(v) * this.ms); },
  },
});
