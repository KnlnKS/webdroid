// The functions compiled code imports as "host" (compiler/j2w.ts HOST_IMPORTS): what it asks of the runtime outside Wasm.
import { MATH_IMPORTS, type HostImport } from "../compiler/j2w.ts";
import { javaName, mid } from "../compiler/program.ts";
import { SLOT, excMessage, type JavaFrame } from "../compiler/exc.ts";
import { unresolvedClass } from "../compiler/linkage.ts";
import type { InvokeMode } from "../compiler/handles.ts";
import { HEAP_LIMIT } from "../../jvm/abi.ts";
import { NO_INDEX } from "../../jvm/dex.ts";
import { className, findMember, hostInfo } from "./classes.ts";
import { hostMembers, hostText } from "./members.ts";
import { hostReflect } from "./reflect.ts";
import { hostUnsafe } from "./unsafe.ts";
import { MInfo, RInfo, UInfo } from "../compiler/info.ts";
import { hostObject } from "./annotations.ts";
import { ASYNC } from "./inet.ts";
import { generateProxy } from "./proxy.ts";
import { mhInvoke } from "./mhandles.ts";
import { classByName, dexOpen, dexOpenMemory, loaderObject, LOADER_OF_CLASS, Lookup } from "./loaders.ts";
import { resolveCatch, resolveForName } from "./resolution.ts";
import { validateSignatures } from "./signatures.ts";
import type { World } from "./world.ts";
import { chain } from "./maybe.ts";

export type HostImports = Record<HostImport, Function>;

/** the host imports of `w`, whose scheduler exists */
export function hostImports(w: World): HostImports {
  const { opts, sched } = w;
  // the heap holds the engine's own data too (the program model is hundreds of MB), which is not the Java heap ART's limit is about
  const heap = opts.heapUsed, heapBase = heap(), limit = opts.heapLimit ?? HEAP_LIMIT;
  const names = (id: number) => javaName(w.numbers.names[id]);
  /** the gap site that ran last, which the UnsatisfiedLinkError the code throws next names */
  let lastGap = 0;
  /** the String objects made of JS strings, which are the constants and what String.intern answers */
  const interned = new Map<string, object>();
  /** the native blocks of the direct buffers, freed when the object that owns each is collected, and their sizes by address */
  const blockSizes = new Map<number, number>();
  const blocks = new FinalizationRegistry<bigint>((address) => { blockSizes.delete(Number(address)); opts.guest!.free(address); });
  // a host call whose answer is pending parks the strand, which annotationWait settles with the answer
  const park = (value: unknown, none: null | 0): unknown => {
    if (!(value instanceof Promise)) return value;
    sched.parkNative(value); return none;
  };
  const catchBlock = (cls: number, index: number, pc: number, throwable: object) => {
    const method = w.prog.require(w.nameOf(cls)).methodAt(index);
    if (!method) throw new Error("Missing catch dispatcher method");
    return resolveCatch(w, method, pc, throwable, sched.current());
  };
  const signatures = (id: number) => validateSignatures(w, w.nameOf(id), sched.current());
  const [catchBlockPlain, catchBlockWait] = sched.importPair(catchBlock), [initSignatures, initSignaturesWait] = sched.importPair(signatures);
  const javaValue = (v: unknown) => w.javaValue(v);
  const math = {} as Record<keyof typeof MATH_IMPORTS, Function>;
  for (const f of Object.keys(MATH_IMPORTS) as (keyof typeof MATH_IMPORTS)[]) math[f] = Math[f];
  return {
    ...math,
    fmod: (a: number, b: number) => a % b,
    gap: (id: number) => { lastGap = id; w.onGap(w.numbers.gapList[id]); },
    sync: (op: number, obj: object | null, a: number) => sched.sync(op, obj, a),
    block: sched.suspending((op: number, obj: object | null, a: number, b: number) => sched.block(op, obj, a, b)),
    hot: (slot: number) => w.upgrades.upgrade(slot),
    long: (slot: number) => { const m = w.slots.methodAt(slot); if (m) w.longLoops.add(mid(m)); },
    imtMiss: (cls: number, sel: number) => w.dispatch.imtMiss(cls, sel),
    heapCheck: () => (heap() - heapBase > limit && (opts.collect?.(), heap() - heapBase > limit) ? 1 : 0),
    info: (kind: number, a: number, b: number) => kind >= MInfo.ExecCount ? hostMembers(w, kind, a, b) : kind >= RInfo.MethodCount ? hostReflect(w, kind, a, b)
      : kind >= UInfo.FieldGet ? hostUnsafe(w, kind, a, b) : hostInfo(w, kind, a, b),
    text: (kind: number, a: number, b: number) => hostText(w, kind, a, b),
    obj: (kind: number, a: number, b: number, filter: object | null) => (kind === LOADER_OF_CLASS ? loaderObject(w, a) : w.javaValue(hostObject(w, kind, a, b, filter))),
    annotation: (kind: number, a: number, b: number, filter: object | null) => park(hostObject(w, kind, a, b, filter), null),
    annotationWait: sched.settle(),
    proxy: (name: unknown, interfaces: object, loader: object | null, methods: object, exceptions: object) => w.javaValue(generateProxy(w, w.hostString(name) as string, interfaces, loader, methods, exceptions)),
    net: (node: unknown, family: number, flags: number) => opts.net ? opts.net(w, w.hostString(node) as string, family, flags) : ASYNC,
    netByte: (found: number[][], i: number, j: number) => j < 0 ? found[i].length : found[i][j],
    mhInvoke: (mh: object, args: object, site: string, mode: InvokeMode) => {
      return park(chain(mhInvoke(w, mh, args, site, mode), javaValue), null);
    },
    // a zeroed native block of `n` bytes that lives as long as `owner`, a MemoryRef (memory.ts); its address, or 0
    galloc: (owner: object, n: number) => {
      const guest = opts.guest;
      if (!guest) throw new Error("this World has no guest memory");
      const address = guest.alloc(n);
      if (address) { blocks.register(owner, address); blockSizes.set(Number(address), n); }
      return address;
    },
    gwrote: (address: number, length: number) => opts.guest!.wrote(address >>> 0, length >>> 0),
    gblock: (address: number) => blockSizes.get(address >>> 0) ?? 0,
    intern: (js: string, s: object) => { let o = interned.get(js); if (!o) interned.set(js, o = s); return o; },
    claim: (owner: object, handle: bigint) => opts.claim?.(owner, handle),
    watch: (referent: unknown, cleaner: object) => { if (typeof referent === "object" && referent !== null) w.helpers.cleaners.register(referent, cleaner); },
    classByName: (name: string, scope: unknown, mode: number) => {
      const text = w.hostString(name) as string;
      return park(mode === Lookup.ForName ? resolveForName(w, text, scope as object | null, sched.current()) : classByName(w, text, scope, mode), 0);
    },
    findMember: (cid: number, name: unknown, kind: number, n: number, from: number) => findMember(w, cid, w.hostString(name) as string | null, kind, n, from),
    dexOpen: (path: unknown, loader: object | null) => park(dexOpen(w, path, loader), null),
    dexOpenMemory: (buffers: object, arrays: object, starts: object, ends: object, loader: object | null) => park(dexOpenMemory(w, buffers, arrays, starts, ends, loader), null),
    // the class `n` frames out from the caller of the native; 0 when the stack is not that deep
    stackClass: (n: number) => {
      const frames = w.stacks.callerFrames(n + 2), f = frames[n + 1];
      return f ? w.idOf(f.cls) : 0;
    },
    excMessage: (kind: number, a: number, b: number, c: number, d: number, e: number) => {
      const message = w.lastMessage = excMessage(kind, a, b, c, d, e, names, (id) => id < 0 ? w.numbers.gapList[lastGap] : w.numbers.links.message(id)!);
      if (message !== null && (kind === SLOT.ncdfr || kind === SLOT.nsme || kind === SLOT.nsfer)) w.onUnresolved(message, kind === SLOT.ncdfr ? unresolvedClass(message) : undefined);
      return message;
    },
    capture: (exn: object) => w.stacks.capture(exn),
    stFrames: (state: object | null) => state ? w.stacks.stackTrace(state) : [],
    // a frame's class, method and the source file its class def names (null without one)
    stString: (frames: JavaFrame[], i: number, which: number) => {
      const f = frames[i], c = which === 2 ? w.prog.get(f.cls) : undefined;
      return which === 0 ? className(f.cls) : which === 1 ? f.method : c?.def && c.def.sourceFileIdx !== NO_INDEX ? c.dex!.string(c.def.sourceFileIdx) : null;
    },
    stLine: (frames: JavaFrame[], i: number) => frames[i].line,
    // the length of an answer the code holds (stFrames, net), or the code a lookup answered instead
    len: (answer: unknown[] | number) => typeof answer === "number" ? answer : answer.length,
    catchSync: () => w.symbolic.symbolicSync(),
    catchBlock: catchBlockPlain, catchBlockWait, initSignatures, initSignaturesWait,
  } satisfies HostImports;
}
