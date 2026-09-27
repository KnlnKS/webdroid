import { JObj, noops, rt } from "../runtime";
import { JThrowable, vcall } from "./jlang";
import { jarray } from "../abi";

class JLogger extends JObj { lname = ""; level: JLevel | null = null; parent: JLogger | null = null; }
const loggers = new Map<string, JLogger>();
const enabled = (logger: JLogger, level: JLevel) => level.value >= (logger.level?.value ?? 800) && logger.level?.value !== 2147483647;
function log(this: JLogger, level: JLevel, message: string, error?: JThrowable | null) {
  if (!enabled(this, level)) return;
  const frames = error && "jframes" in error && Array.isArray(error.jframes) ? error.jframes : [];
  const detail = error ? `\n${error.msg}${frames.length ? "\n  at " + frames.join("\n  at ") : ""}` : "";
  const method = level.value >= 1000 ? "error" : level.value >= 900 ? "warn" : "info";
  console[method](`[java.util.logging/${this.lname}] ${message}${detail}`);
}
async function logParameters(this: JLogger, level: JLevel, message: string, parameters: unknown[] | null): Promise<void> {
  if (!enabled(this, level)) return;
  if (parameters?.length && /\{[0-9]/.test(message)) {
    const text = await Promise.all(parameters.map(p => p === null ? "null" : typeof p === "object" ? vcall(p, "toString", "()Ljava/lang/String;") : String(p)));
    message = message.replace(/\{(\d+)\}/g, (match, index: string) => text[Number(index)] ?? match);
  }
  log.call(this, level, message);
}
async function logSupplied(this: JLogger, level: JLevel, supplier: JObj, error?: JThrowable) {
  if (enabled(this, level)) log.call(this, level, await vcall(supplier, "get", "()Ljava/lang/Object;") as string, error);
}
function getLogger(name: string): JLogger {
  let logger = loggers.get(name);
  if (!logger) loggers.set(name, logger = Object.assign(new JLogger(), { lname: name, parent: name ? getLogger("") : null }));
  return logger;
}
const L = "Ljava/util/logging/Level;", S = "Ljava/lang/String;";
rt.register({
  name: "java/util/logging/Logger", ctor: JLogger,
  statics: { GLOBAL_LOGGER_NAME: "global" },
  methods: {
    "static getLogger(Ljava/lang/String;)Ljava/util/logging/Logger;": getLogger,
    "static getLogger(Ljava/lang/String;Ljava/lang/String;)Ljava/util/logging/Logger;": getLogger,
    "static getGlobal()Ljava/util/logging/Logger;": () => getLogger("global"),
    "static getAnonymousLogger()Ljava/util/logging/Logger;": () => Object.assign(new JLogger(), { parent: getLogger("") }),
    "getName()Ljava/lang/String;": function (this: JLogger) { return this.lname; },
    "getLevel()Ljava/util/logging/Level;": function (this: JLogger) { return this.level; },
    "setLevel(Ljava/util/logging/Level;)V": function (this: JLogger, level: JLevel | null) { this.level = level; },
    "getParent()Ljava/util/logging/Logger;": function (this: JLogger) { return this.parent; },
    "setParent(Ljava/util/logging/Logger;)V": function (this: JLogger, parent: JLogger) { this.parent = parent; },
    "isLoggable(Ljava/util/logging/Level;)Z": function (this: JLogger, level: JLevel) { return +enabled(this, level); },
    [`log(${L}${S})V`]: log,
    [`log(${L}${S}Ljava/lang/Throwable;)V`]: log,
    [`log(${L}${S}Ljava/lang/Object;)V`]: function (this: JLogger, level: JLevel, message: string, value: unknown) { return logParameters.call(this, level, message, [value]); },
    [`log(${L}${S}[Ljava/lang/Object;)V`]: logParameters,
    [`log(${L}Ljava/util/function/Supplier;)V`]: logSupplied,
    [`log(${L}Ljava/lang/Throwable;Ljava/util/function/Supplier;)V`]: function (this: JLogger, level: JLevel, error: JThrowable, supplier: JObj) { return logSupplied.call(this, level, supplier, error); },
    [`logp(${L}${S}${S}${S})V`]: function (this: JLogger, level: JLevel, _class: string, _method: string, message: string) { log.call(this, level, message); },
    [`logp(${L}${S}${S}${S}Ljava/lang/Throwable;)V`]: function (this: JLogger, level: JLevel, _class: string, _method: string, message: string, error: JThrowable) { log.call(this, level, message, error); },
    [`logp(${L}${S}${S}${S}Ljava/lang/Object;)V`]: function (this: JLogger, level: JLevel, _class: string, _method: string, message: string, value: unknown) { return logParameters.call(this, level, message, [value]); },
    [`logp(${L}${S}${S}${S}[Ljava/lang/Object;)V`]: function (this: JLogger, level: JLevel, _class: string, _method: string, message: string, values: unknown[] | null) { return logParameters.call(this, level, message, values); },
    // severe(String) … finest(String) and their Supplier forms
    ...Object.fromEntries(["SEVERE", "WARNING", "INFO", "CONFIG", "FINE", "FINER", "FINEST"].flatMap((name) => [
      [`${name.toLowerCase()}(${S})V`, function (this: JLogger, message: string) { log.call(this, levels[name], message); }],
      [`${name.toLowerCase()}(Ljava/util/function/Supplier;)V`, function (this: JLogger, supplier: JObj) { return logSupplied.call(this, levels[name], supplier); }],
    ])),
    "getHandlers()[Ljava/util/logging/Handler;": () => jarray([], "Ljava/util/logging/Handler;"),
    "getUseParentHandlers()Z": () => 1,
    ...noops("addHandler(Ljava/util/logging/Handler;)V", "removeHandler(Ljava/util/logging/Handler;)V", "setUseParentHandlers(Z)V",
      `entering(${S}${S})V`, `entering(${S}${S}Ljava/lang/Object;)V`, `entering(${S}${S}[Ljava/lang/Object;)V`,
      `exiting(${S}${S})V`, `exiting(${S}${S}Ljava/lang/Object;)V`, `throwing(${S}${S}Ljava/lang/Throwable;)V`),
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
