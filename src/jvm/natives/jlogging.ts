import { JObj, rt } from "../runtime";

class JLogger extends JObj { lname = ""; }
rt.register({
  name: "java/util/logging/Logger", ctor: JLogger,
  methods: {
    "static getLogger(Ljava/lang/String;)Ljava/util/logging/Logger;": (n: string) => { const l = new JLogger(); l.lname = n; return l; },
    "log(Ljava/util/logging/Level;Ljava/lang/String;)V": () => {},
    "log(Ljava/util/logging/Level;Ljava/lang/String;Ljava/lang/Throwable;)V": () => {},
    "info(Ljava/lang/String;)V": () => {},
    "warning(Ljava/lang/String;)V": () => {},
    "fine(Ljava/lang/String;)V": () => {},
    "isLoggable(Ljava/util/logging/Level;)Z": () => 0,
    "setLevel(Ljava/util/logging/Level;)V": () => {},
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
