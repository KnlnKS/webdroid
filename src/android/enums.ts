// Java enums with nothing behind them but name()/ordinal()/values()/valueOf(): one factory registers them all.

import { rt, JObj } from "../jvm/runtime";

export class JSimpleEnum extends JObj { ename = ""; ord = 0; }
export function mkEnumSet(cls: string, names: string[]): JSimpleEnum[] {
  const vals = names.map((n, i) => { const e = new JSimpleEnum(); e.ename = n; e.ord = i; return e; });
  rt.register({
    name: cls, ctor: JSimpleEnum, sup: "java/lang/Enum",
    statics: Object.fromEntries(names.map((n, i) => [n, vals[i]])),
    methods: {
      "name()Ljava/lang/String;": function (this: JSimpleEnum) { return this.ename; },
      "ordinal()I": function (this: JSimpleEnum) { return this.ord; },
      [`static values()[L${cls};`]: () => { const a = vals.slice(); (a as any).$t = `L${cls};`; return a; },
      [`static valueOf(Ljava/lang/String;)L${cls};`]: (n: string) => vals.find((v) => v.ename === n) ?? null,
    },
  });
  return vals;
}
