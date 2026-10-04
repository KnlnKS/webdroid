// Which natives wait, and how they are imported (plan section 4). A native that answers a Promise, is written as a generator that yields
// Java results (`driven`) or is an async function is a Suspending import: the Wasm stack that called it waits for the Promise and other strands run
// meanwhile. Every other native is a plain import, since a Suspending import suspends even when its function answers a value (about 50 ns against 4).
// The rule JSPI imposes is that no JS frame may sit between the `promising` entry of a strand and the import that suspends: a native on the
// Wasm side of an import must not call Java through a plain call and expect that Java to block.
import type { HostContext, HostFn } from "../link/hostapi";
import { count } from "./stats";

const AsyncFunction = (async () => {}).constructor;
type Native = HostFn & { $g?: (...a: unknown[]) => Generator<unknown, unknown, unknown> };

/** natives whose production implementation answers a Promise for some arguments without being written as a generator or an async function (the
 *  survey's flag C: `after(...)` and `awaited(...)` results returned as they are) */
const MAY_SUSPEND = new Set<string>([
  "com/android/org/conscrypt/NativeCrypto.EVP_DigestFinal_ex(Lcom/android/org/conscrypt/NativeRef$EVP_MD_CTX;[BI)I",
  "android/graphics/Typeface.nativeWarmUpCache(Ljava/lang/String;)V",
  "libcore/io/Linux.readBytes(Ljava/io/FileDescriptor;Ljava/lang/Object;II)I",
  "libcore/io/Linux.preadBytes(Ljava/io/FileDescriptor;Ljava/lang/Object;IIJ)I",
  "libcore/io/Linux.getpwuid(I)Landroid/system/StructPasswd;",
  "libcore/io/Linux.poll([Landroid/system/StructPollfd;I)I",
  "java/io/FileDescriptor.sync()V",
  "sun/nio/ch/FileDispatcherImpl.force0(Ljava/io/FileDescriptor;Z)I",
  "sun/nio/ch/FileChannelImpl.map0(IJJ)J",
  "java/net/HttpURLConnection$$host.getInputStream()Ljava/io/InputStream;",
  "libcore/io/Memory.peekIntNative(J)I",
  "android/graphics/BitmapFactory.nativeDecodeByteArray([BIILandroid/graphics/BitmapFactory$Options;JJ)Landroid/graphics/Bitmap;",
  "android/text/AndroidCharacter.getEastAsianWidth(C)I",
  "sun/nio/fs/UnixNativeDispatcher.init()I",
  "android/text/AndroidCharacter.getMirror(C)C",
  "android/text/AndroidCharacter.getDirectionalities([C[BI)V",
  "android/text/AndroidCharacter.getEastAsianWidths([CII[B)V",
  "java/net/SocketInputStream.socketRead0(Ljava/io/FileDescriptor;[BIII)I",
  "libcore/io/Linux.connect(Ljava/io/FileDescriptor;Ljava/net/InetAddress;I)V",
  "libcore/io/Linux.recvfromBytes(Ljava/io/FileDescriptor;Ljava/lang/Object;IIILjava/net/InetSocketAddress;)I",
]);
/** natives found answering a Promise from a plain import: the report in run.json (`nativeSuspended`), and imported as Suspending in modules built afterwards */
export const suspendedNatives = new Set<string>();

/** the context of the Suspending import being called, for the generator driver that starts inside it */
let calling: HostContext | null = null;

/** whether native `fn` answers a Promise on every call, which only a Suspending import can take */
export const waitsAlways = (fn: HostFn): boolean => fn.constructor === AsyncFunction;

/** the Wasm tier's form of a production native: a generator native runs under an async driver of its own (not Runtime.drive, whose strand bookkeeping is the JS tier's) */
export function hostForm(fn: HostFn): HostFn {
  const g = (fn as Native).$g;
  if (!g) return fn;
  return function (this: unknown, ...a: unknown[]) { return drive(g.apply(this, a), calling); };
}
/** runs a generator native: each value it yields is awaited, an exception of a rejected one is thrown into it; the strand is the running one again after each wait */
async function drive(it: Generator<unknown, unknown, unknown>, ctx: HostContext | null): Promise<unknown> {
  const strand = ctx?.sched.running ?? null;
  let step = it.next();
  while (!step.done) {
    let v = step.value, threw = false;
    if (v instanceof Promise) {
      try { v = await v; } catch (e) { v = e; threw = true; }
      if (ctx) ctx.sched.running = strand;
    }
    step = threw ? it.throw(v) : it.next(v);
  }
  return step.value;
}

/** whether native `id` is imported as Suspending */
export function suspends(id: string, fn: HostFn): boolean {
  return (fn as Native).$g !== undefined || fn.constructor === AsyncFunction || MAY_SUSPEND.has(id) || suspendedNatives.has(id);
}

/** a plain import answered a Promise: nothing can wait there. It is reported, and the next module that imports it gets it as Suspending */
export function reportSuspended(id: string): void {
  if (!suspendedNatives.has(id)) count("wasmNativeSuspended");
  suspendedNatives.add(id);
}

/** a call the engine refused to suspend because a JS frame sits between the strand's entry and the import: counted, and the error goes on */
export function reportSuspendError(e: unknown): void {
  if (e instanceof Error && e.name === "SuspendError") count("wasmSuspendErrors");
}

/** installs a native as a Wasm import: `build(false)` is the plain form, `build(true)` the one that may wait, wrapped for the engine so the strand that
 *  called it waits for the Promise it answers (the globals that name the strand are restored by the generated call, natives.ts) */
export function adaptImport(build: (suspending: boolean) => HostFn, ctx: HostContext, suspending: boolean): HostFn {
  if (!suspending) return build(false);
  const f = build(true);
  return ctx.sched.suspending((...a: unknown[]) => {
    calling = ctx;
    try { return f(...a); } finally { calling = null; }
  }) as HostFn;
}
