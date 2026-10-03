// Per-DEX resolution caches used by compiled methods; each defining runtime owns its links.
import type { ClassInfo, Runtime } from "./runtime";
import type { DexFile } from "./dex";
import { descToName, directName, mangleMethod, mangleStaticField } from "./abi";
import { addCell, type Cells } from "./tiering";

function siteCache(c: unknown[], k: number, fn: Cells): unknown {
  addCell(fn, c, k);
  return (c[k] = fn);
}

export class DexLink {
  readonly cl: any[];                  // typeIdx → linked ctor
  readonly ic: any[];                  // typeIdx → initialized ctor
  readonly s: readonly (string | undefined)[];
  readonly dp: any[] = [];             // methodIdx → direct-invoke prototype fn
  readonly fs: any[] = [];             // fieldIdx → initialized declaring ctor
  readonly cs: any[] = [];             // callSiteIdx → linked invoke-custom target
  readonly info: ClassInfo[];

  constructor(private readonly runtime: Runtime, readonly dex: DexFile) {
    this.cl = new Array(dex.typeCount);
    this.ic = new Array(dex.typeCount);
    this.info = new Array(dex.typeCount);
    this.s = dex.cachedStrings;
  }

  gs(i: number): string { return this.dex.string(i); }
  linfo(i: number): ClassInfo { return this.info[i] ?? (this.info[i] = this.runtime.link(descToName(this.dex.type(i)))); }
  link(i: number): any { return (this.cl[i] = this.linfo(i).ctor); }

  init(i: number, from?: number): any {
    const info = this.linfo(i), R = this.runtime;
    // Resolution failures must be thrown at every call site, never cached.
    if (info.stub) throw R.ncdfe(info.name);
    if (info.state === 2) return (this.ic[i] = info.ctor);
    const done = () => (info.state === 2 ? (this.ic[i] = info.ctor) : info.ctor);
    const p = R.initClass(info, from === undefined ? undefined : this.linfo(from));
    return p ? p.then(done) : done();
  }

  rdp(i: number, from?: number): any {
    const info = this.linfo(this.dex.method(i).cls);
    if (info.state === 2) return this.rdp0(i);
    const p = this.runtime.initClass(info, from === undefined ? undefined : this.linfo(from));
    return p ? p.then(() => this.rdp0(i)) : this.rdp0(i);
  }

  rdp0(i: number): any {
    const dex = this.dex, R = this.runtime, m = dex.method(i), info = this.linfo(m.cls);
    if (info.stub) throw R.ncdfe(info.name);
    R.ensureCompiled(info);
    const proto = info.ctor.prototype, mangled = mangleMethod(m.name, dex.methodDesc(i));
    const fn: Cells | undefined = proto[mangled];
    if (!fn) throw R.unimplemented(`${info.name}.${m.name}${dex.methodDesc(i)} (direct)`);
    addCell(fn, this.dp, i);
    const direct = directName(info.name, mangled);
    if (!Object.hasOwn(proto, direct)) { proto[direct] = fn; addCell(fn, proto, direct); }
    return (this.dp[i] = fn);
  }

  // dp is sparse, so V8 keeps it in dictionary mode; a hot site reads its own dense slot.
  rdc(c: unknown[], k: number, i: number, from?: number): unknown {
    const fn = this.dp[i] ?? this.rdp(i, from);
    return fn instanceof Promise ? fn : siteCache(c, k, fn);
  }
  rdc0(c: unknown[], k: number, i: number): unknown { return siteCache(c, k, this.dp[i] ?? this.rdp0(i)); }

  rsf(i: number, from?: number): any {
    const dex = this.dex, R = this.runtime, fr = dex.field(i), start = this.linfo(fr.cls);
    if (start.stub) throw R.ncdfe(start.name);
    const owner = findStaticOwner(start, fr.name, dex.type(fr.type))?.info ?? start;
    if (owner.state === 2) return (this.fs[i] = owner.ctor);
    const set = () => (owner.state === 2 ? (this.fs[i] = owner.ctor) : owner.ctor);
    const p = R.initClass(owner, from === undefined ? undefined : this.linfo(from));
    return p ? p.then(set) : set();
  }

  ics(i: number): any { return (this.cs[i] = this.runtime.linkCallSite(this.runtime, this.dex, i)); }
}

export function instanceFieldOf(start: ClassInfo, name: string): string | undefined {
  for (let info: ClassInfo | null = start; info; info = info.superInfo) {
    const prop = info.fieldTable.get(name);
    if (prop) return prop;
  }
  return undefined;
}

export function findStaticOwner(start: ClassInfo, name: string, desc: string): { info: ClassInfo; prop: string } | null {
  let info: ClassInfo | null = start;
  while (info) {
    const prop = info.staticFieldTable.get(name + ":" + desc) ?? (info.native ? mangleStaticField(name) : null);
    if (prop && Object.hasOwn(info.ctor, prop)) return { info, prop };
    for (const iface of info.interfaces) {
      const r = findStaticOwner(iface, name, desc);
      if (r) return r;
    }
    info = info.superInfo;
  }
  return null;
}

