// Class initialization (JLS 12.4.2): a class's <clinit> runs once, on the thread and call chain that
// first needs it; another chain waits for it, and a chain the initializer itself waits on proceeds
// with the statics as they are rather than deadlock. Runtime.initClass is the entry, with the fast
// path for a class already initialized.
import type { ClassInfo, Runtime } from "./runtime";
import { Strand, waitFor, waitsFor } from "./suspend";
import { dotName } from "./abi";
import { perf } from "../perf";

/** A class constructor holds the class's statics and static methods. V8 turns one into a dictionary
 *  as <clinit> first stores to them, after which `new C()` and static loads take a slow path (4x for
 *  BigInteger's constructor). An object made a prototype, as every superclass already is, gets
 *  fast properties back. */
function fastStatics(C: object) {
  function Holder() {}
  Holder.prototype = C;
  return new (Holder as unknown as new () => object)();
}

/** nesting of <clinit>s in this realm: perf.clinitMs counts the outermost */
let clinitDepth = 0;

/** initialize `info`, prepared and not yet initialized; a promise only if init work suspends */
export function initialize(R: Runtime, info: ClassInfo, from?: ClassInfo): Promise<void> | null {
  if (info.state === 1) {
    if (!info.initP || info === from) return null; // sync-prefix / self reentrancy
    // JLS 12.4.2 step 3: a request from the thread already initializing this class is
    // recursive and completes at once with the statics as they are. The `from` tag only
    // sees <clinit>-to-<clinit> edges; <clinit> → constructor → sget of its own class is the
    // common shape (kotlinx's ChannelSegment reads BufferedChannelKt.SEGMENT_SIZE while
    // BufferedChannelKt's <clinit> builds NULL_SEGMENT). Main-loop jobs and host turns share
    // their Java thread, so "the thread" is that thread as the chain that started the <clinit>,
    // across its suspensions: another job on it would not run on a device before init finished.
    const s = R.cur;
    if (info.initBy === s) return null;
    // a cycle: the <clinit>'s chain waits, through class initializations and locks, on this
    // one. Two threads' clinits waiting on each other deadlock a JVM; here the request proceeds
    // with partial statics, as a same-thread cycle would, rather than hang the page.
    if (waitsFor(info.initBy!, s)) return null;
    // JVM: only the initializing thread may proceed on a class mid-<clinit>; every other
    // thread, and here every other chain on its thread, blocks until it completes, however
    // long a heavy static initializer takes
    return waitFor(s, info.initBy!, info.initP);
  }
  if (info.state === 3) throw Object.assign(R.mkThrowable("java/lang/NoClassDefFoundError",
    `Rejecting re-init on previously-failed class java.lang.Class<${dotName(info.name)}>`), { cause: info.initError });
  info.state = 1;
  // a thread's root strand initializes as a chain of its own, which its suspensions keep
  const by = info.initBy = R.cur.root ? new Strand(R.cur.thread) : R.cur;

  // Initialize synchronously for as long as nothing actually suspends: only the step that
  // really yields gets a promise, and the rest of the sequence continues from there. An
  // always-async initializer would make every first touch of a class await, so no method
  // containing an sget, a new-instance or an invoke-static could run synchronously.
  const rest = (): Promise<void> | null => {
    const outer = clinitDepth++ === 0, started = outer ? performance.now() : 0;
    try { return runClinit(R, info); }
    finally { clinitDepth--; if (outer) perf.clinitMs += performance.now() - started; }
  };

  const settle = () => { info.state = 2; info.initP = null; info.initBy = null; fastStatics(info.ctor); };
  /** JLS 12.4.2: the class becomes erroneous; an Exception reaches the caller wrapped in an
   *  ExceptionInInitializerError, and every later initialization fails with NoClassDefFoundError */
  const failed = (e: unknown) => {
    settle();
    info.state = 3;
    const t = R.jx(e);
    const what = (x: unknown): string => { const o = x as { constructor?: { $i?: { name: string } }; msg?: unknown; cause?: unknown } | null;
      return o ? `${o.constructor?.$i?.name ?? "?"}: ${o.msg}${o.cause && o.cause !== o ? " <- " + what(o.cause) : ""}` : String(x); };
    console.warn("[webdroid clinit-failed]", info.name, what(t), (t as { jsErr?: Error }).jsErr?.stack?.split("\n").slice(1, 6).join(" | ") ?? "");
    return info.initError = R.iof(t, "java/lang/Error") ? t : Object.assign(R.mkThrowable("java/lang/ExceptionInInitializerError", null), { cause: t });
  };
  /** hand the remaining steps to the microtask queue, from the one that yielded */
  const later = (pending: Promise<unknown>, after: (() => Promise<void> | null) | null): Promise<void> => {
    info.initP = (async () => {
      try {
        await pending;
        // the <clinit> run here is its strand's, which it releases
        R.st(by);
        let more: Promise<void> | null | undefined;
        try { more = after?.(); } finally { R.su(); }
        if (more) await more;
      } catch (e) { throw failed(e); }
      settle();
    })();
    return info.initP;
  };

  // the super's initialization, then the class's own, as far as they run without suspending: what
  // suspended, and what is left to run after it
  const start = (): [Promise<unknown>, (() => Promise<void> | null) | null] | null => {
    const sup = info.superInfo && info.superInfo.state !== 2 ? R.initClass(info.superInfo, info) : null;
    if (sup) return [sup, rest];
    const pending = rest();
    return pending && [pending, null];
  };
  // the <clinit>'s suspensions and callbacks keep its strand
  let suspended: ReturnType<typeof start>;
  try { suspended = R.within(by, start); } catch (e) { throw failed(e); }
  if (suspended) return later(...suspended);
  settle();
  return null;
}

/** the class's own initialization: constant statics, then <clinit> or the native clinit hook */
function runClinit(R: Runtime, info: ClassInfo): Promise<void> | null {
  R.quiet.types = null;
  for (const i of info.interfaces) R.ensureCompiled(i);   // defaults copy down
  R.ensureCompiled(info);
  let r: unknown;
  if (info.native) {
    const spec = R.natives.get(info.name);
    if (spec?.clinit) r = spec.clinit();
    else if (spec?.platformClinit && Object.hasOwn(info.ctor, "$clinit")) { R.st(info.initBy!); r = info.ctor.$clinit.call(info.ctor); }
  } else if (info.def) {
    const dex = info.dex!;
    if (info.def.staticValuesOff) {
      const vals = dex.encodedArray(info.def.staticValuesOff);
      for (let i = 0; i < vals.length; i++) {
        const fr = dex.field(info.def.staticFields[i].fieldIdx);
        info.ctor[info.staticFieldTable.get(fr.name + ":" + dex.type(fr.type))!] = R.encToJs(dex, vals[i]);
      }
    }
    // own property only: JS constructors inherit statics, and a subclass without a
    // <clinit> must not re-run its super's (which would replace identity-compared
    // sentinels the super's callers already hold)
    const clinit = Object.hasOwn(info.ctor, "$clinit") ? info.ctor.$clinit : undefined;
    R.st(info.initBy!); // <clinit> runs as the initiating strand, whatever ran meanwhile
    if (clinit) r = clinit.call(info.ctor);
  }
  return r instanceof Promise ? r : null;
}
