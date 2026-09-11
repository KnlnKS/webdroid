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
rt.register({ name: "java/util/logging/Level", ctor: class extends JObj {},
  clinit: () => { const c = rt.link("java/util/logging/Level").ctor as any; for (const n of ["OFF","SEVERE","WARNING","INFO","CONFIG","FINE","FINER","FINEST","ALL"]) c["s$"+n] = new c(); } });
rt.markers("java/util/logging/Handler");
