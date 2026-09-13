import { JObj, rt } from "../runtime";
import { JThrowable, vcall } from "./jlang";

class JLogger extends JObj { lname = ""; level: JLevel | null = null; }
const loggers = new Map<string, JLogger>();
function log(this: JLogger, level: JLevel, message: string, error?: JThrowable | null) {
  if (level.value < (this.level?.value ?? 800) || this.level?.value === 2147483647) return;
  const frames = error && "jframes" in error && Array.isArray(error.jframes) ? error.jframes : [];
  const detail = error ? `\n${error.msg}${frames.length ? "\n  at " + frames.join("\n  at ") : ""}` : "";
  const method = level.value >= 1000 ? "error" : level.value >= 900 ? "warn" : "info";
  console[method](`[java.util.logging/${this.lname}] ${message}${detail}`);
}
async function logParameters(this: JLogger, level: JLevel, message: string, parameters: unknown[] | null): Promise<void> {
  if (level.value < (this.level?.value ?? 800) || this.level?.value === 2147483647) return;
  if (parameters?.length && /\{[0-3]/.test(message)) {
    const text = await Promise.all(parameters.map(p => p === null ? "null" : typeof p === "object" ? vcall(p, "toString", "()Ljava/lang/String;") : String(p)));
    message = message.replace(/\{(\d+)\}/g, (match, index: string) => text[Number(index)] ?? match);
  }
  log.call(this, level, message);
}
rt.register({
  name: "java/util/logging/Logger", ctor: JLogger,
  methods: {
    "static getLogger(Ljava/lang/String;)Ljava/util/logging/Logger;": (n: string) => { let l = loggers.get(n); if (!l) { l = new JLogger(); l.lname = n; loggers.set(n, l); } return l; },
    "getName()Ljava/lang/String;": function (this: JLogger) { return this.lname; },
    "getLevel()Ljava/util/logging/Level;": function (this: JLogger) { return this.level; },
    "log(Ljava/util/logging/Level;Ljava/lang/String;)V": log,
    "log(Ljava/util/logging/Level;Ljava/lang/String;Ljava/lang/Throwable;)V": log,
    "logp(Ljava/util/logging/Level;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V": function (this: JLogger, level: JLevel, _class: string, _method: string, message: string) { log.call(this, level, message); },
    "logp(Ljava/util/logging/Level;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/Throwable;)V": function (this: JLogger, level: JLevel, _class: string, _method: string, message: string, error: JThrowable) { log.call(this, level, message, error); },
    "logp(Ljava/util/logging/Level;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/Object;)V": function (this: JLogger, level: JLevel, _class: string, _method: string, message: string, value: unknown) { return logParameters.call(this, level, message, [value]); },
    "logp(Ljava/util/logging/Level;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;[Ljava/lang/Object;)V": function (this: JLogger, level: JLevel, _class: string, _method: string, message: string, values: unknown[] | null) { return logParameters.call(this, level, message, values); },
    "info(Ljava/lang/String;)V": function (this: JLogger, message: string) { log.call(this, levels.INFO, message); },
    "warning(Ljava/lang/String;)V": function (this: JLogger, message: string) { log.call(this, levels.WARNING, message); },
    "fine(Ljava/lang/String;)V": function (this: JLogger, message: string) { log.call(this, levels.FINE, message); },
    "isLoggable(Ljava/util/logging/Level;)Z": function (this: JLogger, level: JLevel) { return +(level.value >= (this.level?.value ?? 800) && this.level?.value !== 2147483647); },
    "setLevel(Ljava/util/logging/Level;)V": function (this: JLogger, level: JLevel | null) { this.level = level; },
    "addHandler(Ljava/util/logging/Handler;)V": () => {},
    "setUseParentHandlers(Z)V": () => {},
  },
});
class JLevel extends JObj { name = ""; value = 0; }
const levels = Object.fromEntries(Object.entries({ OFF: 2147483647, SEVERE: 1000, WARNING: 900, INFO: 800,
  CONFIG: 700, FINE: 500, FINER: 400, FINEST: 300, ALL: -2147483648 })
  .map(([name, value]) => [name, Object.assign(new JLevel(), { name, value })]));
rt.register({ name: "java/util/logging/Level", ctor: JLevel, statics: levels, methods: {
  "<init>(Ljava/lang/String;I)V": function (this: JLevel, name: string, value: number) {
    if (name == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
    this.name = name; this.value = value;
  },
  "getName()Ljava/lang/String;": function (this: JLevel) { return this.name; },
  "intValue()I": function (this: JLevel) { return this.value; },
  "toString()Ljava/lang/String;": function (this: JLevel) { return this.name; },
  "hashCode()I": function (this: JLevel) { return this.value; },
  "equals(Ljava/lang/Object;)Z": function (this: JLevel, other: unknown) { return other instanceof JLevel && other.value === this.value ? 1 : 0; },
} });
rt.markers("java/util/logging/Handler");
