// Which methods can suspend, so the rest can compile without `async`.
//
// Every compiled method is an async function today because any call might return a promise.
// In the shape the compiler emits that costs ~24x over the same body called synchronously —
// 490M calls/s against 20M — and widening the syntactic rule buys nothing: 12.4% of
// sampled bodies are sync today and only 13.4% contain no invoke at all. So the answer
// has to come from the call graph.
//
// It is a backward closure over that graph. A method suspends if it can reach one that does.
// The leaves are our own TS natives, declared async or marked for conditional suspension.
// Touching a class runs its
// <clinit>, which is a method in the graph like any other. Anything unresolvable is assumed
// to suspend, so being wrong makes a method slow, never wrong.
//
// A virtual call site is one node, not one node per possible receiver: fanning out per site
// costs millions of edges on a large app.

import { type Program, sigOf, INVOKE, splitKey, walkInsns } from "./reach";
import { descToName } from "./abi";

/** answers for a method no dex defines: true suspends, false does not, null unknown */
type NativeOracle = (cls: string, sig: string) => boolean | null;

const CLINIT = "<clinit>()V";
const SUSPENDS = "\0suspends";   // the node every unresolvable target reports to

/**
 * @param methods  the bodies to consider — the reachable set, not the whole apk
 * @param subtypes declared type -> concrete types a site on it may dispatch to
 */
interface Suspension {
  /** the method keys that can suspend */
  suspends: Set<string>;
  /** call sites as the compiler names them ("@owner.sig" virtual, "owner.sig" exact) whose every target cannot suspend */
  syncSites: Set<string>;
  /** classes whose whole initialization chain cannot suspend */
  syncInits: Set<string>;
}
export function analyseSuspend(
  p: Program, methods: Iterable<string>, subtypes: Map<string, string[]>, nativeSuspends: NativeOracle,
): Suspension {
  const suspends = new Set<string>([SUSPENDS]);
  const callers = new Map<string, string[]>();   // node -> nodes that depend on it
  const queue: string[] = [SUSPENDS];
  const virtualSites = new Set<string>();        // "declared/Type.sig", expanded once at the end
  const inits = new Set<string>();               // every class whose initialization some body triggers

  const mark = (k: string) => { if (!suspends.has(k)) { suspends.add(k); queue.push(k); } };
  const edge = (from: string, to: string) => {
    let l = callers.get(from);
    if (!l) callers.set(from, (l = []));
    l.push(to);
  };

  // the same (declared type, sig) is asked once per call site; it always answers the same.
  // A body outside the reachable set is never scanned, so nothing is known about it: it
  // suspends, as far as any site that reaches it after all is concerned.
  const scanned = new Set<string>();
  for (const key of methods) {
    const [cls, sig] = splitKey(key), hit = p.resolve(cls, sig);
    if (hit?.m.codeOff) scanned.add(hit.cls + "." + sig);
  }
  const resolved = new Map<string, string>();
  function definitionOf(cls: string, sig: string): string {
    const q = cls + "." + sig;
    let d = resolved.get(q);
    if (d === undefined) {
      const hit = p.resolve(cls, sig);
      d = hit?.m.codeOff ? (scanned.has(hit.cls + "." + sig) ? hit.cls + "." + sig : SUSPENDS)
        : nativeSuspends(hit?.cls ?? cls, sig) === false ? "" : SUSPENDS;
      resolved.set(q, d);
    }
    return d;
  }

  /** `caller` depends on whatever a call on `cls` with `sig` actually runs */
  function exact(cls: string, sig: string, caller: string) {
    const d = definitionOf(cls, sig);
    if (!d) return;                       // resolves to something that cannot suspend
    edge(d, caller);
    if (suspends.has(d)) mark(caller);
  }

  /** Touching a class initializes its whole super chain, each class's OWN <clinit>. Resolving
   *  <clinit> the way a call resolves is wrong twice over: it would attribute a superclass's
   *  initializer to a subclass that has none, and miss the supers of one that does. */
  function initOf(cls: string, caller: string) {
    inits.add(cls);
    initOne(cls, caller);
    for (const c of p.supers(cls)) initOne(c, caller);
  }
  function initOne(c: string, caller: string) {
    if (p.declares(c, CLINIT)) exact(c, CLINIT, caller);
    else if (!p.has(c)) exact(c, CLINIT, caller);   // a native's clinit hook: ask the oracle
  }

  for (const key of methods) {
    const [cls, sig] = splitKey(key);
    const hit = p.resolve(cls, sig);
    if (!hit?.m.codeOff) continue;
    const self = hit.cls + "." + sig;
    const dex = p.dexOf(hit.cls)!;
    const insns = dex.code(hit.m.codeOff).insns;
    walkInsns(insns, (op, pc) => {
      if (op === 0x1d) mark(self); // monitor-enter can contend across cooperative threads
      if (INVOKE[op] === 0) {
        const mIdx = insns[pc + 1];
        const owner = descToName(dex.type(dex.method(mIdx).cls));
        if (owner[0] !== "[") {
          if (op === 0x71 || op === 0x77) initOf(owner, self);   // invoke-static inits
          exact(owner, sigOf(dex, mIdx), self);
        }
      } else if (INVOKE[op] === 1) {
        const mIdx = insns[pc + 1];
        const owner = descToName(dex.type(dex.method(mIdx).cls));
        if (owner[0] !== "[") {
          const site = owner + "." + sigOf(dex, mIdx);
          virtualSites.add(site);
          edge("@" + site, self);
        }
      } else if (op === 0x22 || op === 0x24 || op === 0x25) {    // new-instance, filled-new-array{,/range}
        initOf(descToName(dex.type(insns[pc + 1])), self);
      } else if (op >= 0x60 && op <= 0x6d) {                     // sget/sput
        initOf(descToName(dex.type(dex.field(insns[pc + 1]).cls)), self);
      }
    });
  }

  // one fan-out per distinct site, after the scan, so a hot signature costs once
  for (const site of virtualSites) {
    const [owner, sig] = splitKey(site), node = "@" + site;
    exact(owner, sig, node);
    for (const t of subtypes.get(owner) ?? []) exact(t, sig, node);
  }

  while (queue.length) {
    const k = queue.pop()!;
    for (const c of callers.get(k) ?? []) mark(c);
  }
  const syncSites = new Set<string>();
  for (const [q, d] of resolved) if (d !== SUSPENDS && (!d || !suspends.has(d))) syncSites.add(q);
  for (const site of virtualSites) if (!suspends.has("@" + site)) syncSites.add("@" + site);
  const initSync = (c: string) => p.declares(c, CLINIT) ? !suspends.has(c + "." + CLINIT) : p.has(c) || nativeSuspends(c, CLINIT) === false;
  const syncInits = new Set<string>();
  for (const cls of inits) if (initSync(cls) && p.supers(cls).every(initSync)) syncInits.add(cls);
  suspends.delete(SUSPENDS);
  return { suspends, syncSites, syncInits };
}

/** declared type -> the concrete types a virtual site on it may reach, from RTA's instantiated set */
export function subtypeIndex(p: Program, instantiated: Iterable<string>): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const t of instantiated) {
    for (const s of p.supers(t)) {
      let l = m.get(s);
      if (!l) m.set(s, (l = []));
      l.push(t);
    }
  }
  return m;
}
