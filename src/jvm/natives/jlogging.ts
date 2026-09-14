import { JObj, rt } from "../runtime";

class JLogger extends JObj { lname = ""; }
class JLevel extends JObj { lname = ""; value = 0; }
rt.register({
  name: "java/util/logging/Logger", ctor: JLogger,
  methods: {
    "static getLogger(Ljava/lang/String;)Ljava/util/logging/Logger;": (n: string) => { const l = new JLogger(); l.lname = n; return l; },
    "log(Ljava/util/logging/Level;Ljava/lang/String;)V": () => {},
    "log(Ljava/util/logging/Level;Ljava/lang/String;Ljava/lang/Throwable;)V": () => {},
    "logp(Ljava/util/logging/Level;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V": () => {},
    "logp(Ljava/util/logging/Level;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/Throwable;)V": () => {},
    "logp(Ljava/util/logging/Level;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/Object;)V": () => {},
    "info(Ljava/lang/String;)V": () => {},
    "warning(Ljava/lang/String;)V": () => {},
    "fine(Ljava/lang/String;)V": () => {},
    "isLoggable(Ljava/util/logging/Level;)Z": () => 0,
    "setLevel(Ljava/util/logging/Level;)V": () => {},
    "addHandler(Ljava/util/logging/Handler;)V": () => {},
    "setUseParentHandlers(Z)V": () => {},
  },
});
rt.register({
  name: "java/util/logging/Level", ctor: JLevel,
  clinit: () => {
    for (const [name, value] of Object.entries({
      OFF: 0x7fffffff, SEVERE: 1000, WARNING: 900, INFO: 800, CONFIG: 700,
      FINE: 500, FINER: 400, FINEST: 300, ALL: -0x80000000,
    })) {
      const level = new JLevel(); level.lname = name; level.value = value;
      Reflect.set(JLevel, "s$" + name, level);
    }
  },
  methods: {
    "intValue()I": function (this: JLevel) { return this.value; },
    "getName()Ljava/lang/String;": function (this: JLevel) { return this.lname; },
    "toString()Ljava/lang/String;": function (this: JLevel) { return this.lname; },
  },
});
rt.markers("java/util/logging/Handler");
