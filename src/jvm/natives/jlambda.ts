import { JObj, rt } from "../runtime.ts";

class JLambda extends JObj { f!: (...a: unknown[]) => unknown; }
const hosts = new Set<string>();
/** a host function handed to Java as an instance of functional interface `iface`, whose single
 *  abstract method is `sam` (name and descriptor) */
export function lambda(iface: string, sam: string, f: (...a: any[]) => unknown): JObj {
  const name = "webdroid/fn/" + iface.slice(iface.lastIndexOf("/") + 1);
  if (!hosts.has(name)) {
    hosts.add(name);
    rt.register({ name, ctor: class extends JLambda {}, ifaces: [iface], methods: { [sam]: function (this: JLambda, ...a: unknown[]) { return this.f(...a); } } });
  }
  const l = rt.make(name) as JLambda;
  l.f = f;
  return l;
}
