import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

/** A static Java method call: statics live on the class constructor under their mangled names. */
export const scall = (cls: string, name: string, desc: string, ...args: unknown[]) => vcall(rt.link(cls).ctor, name, desc, ...args);
