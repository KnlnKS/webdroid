// Which natives wait, and how they are imported. A native that answers a Promise, is written as a generator that yields
// Java results (`driven`) or is an async function is a Suspending import: the Wasm stack that called it waits for the Promise and other strands run
// meanwhile. Every other native is a plain import, since a Suspending import suspends even when its function answers a value (about 50 ns against 4).
// The rule JSPI imposes is that no JS frame may sit between the `promising` entry of a strand and the import that suspends: a native on the
// Wasm side of an import must not call Java through a plain call and expect that Java to block.
import type { HostContext, HostFn } from "../link/hostapi";
import { count } from "./stats";

const AsyncFunction = (async () => {}).constructor;
type Native = HostFn & { $g?: (...a: unknown[]) => Generator<unknown, unknown, unknown> };

/** natives whose production implementation answers a Promise for some arguments without being written as a generator or an async function
 *  (`after(...)` and `awaited(...)` results returned as they are) */
export const MAY_SUSPEND = new Set<string>([
  "webdroid/FnRunnable.run()V",
  "com/android/org/conscrypt/NativeCrypto.EVP_DigestFinal_ex(Lcom/android/org/conscrypt/NativeRef$EVP_MD_CTX;[BI)I",
  "android/graphics/Typeface.nativeWarmUpCache(Ljava/lang/String;)V",
  "android/graphics/Typeface.nativeReadTypefaces(Ljava/nio/ByteBuffer;I)[J",
  "android/graphics/Typeface.nativeWriteTypefaces(Ljava/nio/ByteBuffer;I[J)I",
  "android/graphics/fonts/Font$Builder.nBuild(JLjava/nio/ByteBuffer;Ljava/lang/String;Ljava/lang/String;IZI)J",
  "android/graphics/fonts/FontFileUtil.nGetFontRevision(Ljava/nio/ByteBuffer;I)J",
  "android/graphics/fonts/FontFileUtil.nGetFontPostScriptName(Ljava/nio/ByteBuffer;I)Ljava/lang/String;",
  "android/graphics/fonts/FontFileUtil.nIsPostScriptType1Font(Ljava/nio/ByteBuffer;I)I",
  "libcore/io/Linux.readBytes(Ljava/io/FileDescriptor;Ljava/lang/Object;II)I",
  "libcore/io/Linux.preadBytes(Ljava/io/FileDescriptor;Ljava/lang/Object;IIJ)I",
  "libcore/io/Linux.getpwuid(I)Landroid/system/StructPasswd;",
  "libcore/io/Linux.poll([Landroid/system/StructPollfd;I)I",
  "java/io/FileDescriptor.sync()V",
  "libcore/icu/ICU.getIcuVersion()Ljava/lang/String;",
  "com/android/icu/charset/NativeConverter.charsetForName(Ljava/lang/String;)Ljava/nio/charset/Charset;",
  "sun/nio/ch/FileDispatcherImpl.force0(Ljava/io/FileDescriptor;Z)I",
  "sun/nio/ch/FileChannelImpl.map0(IJJ)J",
  "java/net/HttpURLConnection$$host.getInputStream()Ljava/io/InputStream;",
  "android/graphics/BitmapFactory.nativeDecodeByteArray([BIILandroid/graphics/BitmapFactory$Options;JJ)Landroid/graphics/Bitmap;",
  "android/text/AndroidCharacter.getEastAsianWidth(C)I",
  "sun/nio/fs/UnixNativeDispatcher.init()I",
  "android/text/AndroidCharacter.getMirror(C)C",
  "android/text/AndroidCharacter.getDirectionalities([C[BI)V",
  "android/text/AndroidCharacter.getEastAsianWidths([CII[B)V",
  "java/net/SocketInputStream.socketRead0(Ljava/io/FileDescriptor;[BIII)I",
  "libcore/io/Linux.connect(Ljava/io/FileDescriptor;Ljava/net/InetAddress;I)V",
  "libcore/io/Linux.recvfromBytes(Ljava/io/FileDescriptor;Ljava/lang/Object;IIILjava/net/InetSocketAddress;)I",
  "android/graphics/ImageDecoder.nCreate(Ljava/nio/ByteBuffer;IIZLandroid/graphics/ImageDecoder$Source;)Landroid/graphics/ImageDecoder;",
  "android/media/AudioTrack.native_write_native_bytes(Ljava/nio/ByteBuffer;IIIZ)I",
  "android/media/MediaExtractor.readSampleData(Ljava/nio/ByteBuffer;I)I",
  "android/opengl/GLES20.glUniformMatrix4fv(IIZLjava/nio/FloatBuffer;)V",
  "android/opengl/GLES20.glGenBuffers(ILjava/nio/IntBuffer;)V",
  "android/opengl/GLES20.glGenTextures(ILjava/nio/IntBuffer;)V",
  "android/opengl/GLES20.glBufferData(IILjava/nio/Buffer;I)V",
  "android/opengl/GLES20.glBufferSubData(IIILjava/nio/Buffer;)V",
  "android/opengl/GLES20.glTexImage2D(IIIIIIIILjava/nio/Buffer;)V",
  "android/opengl/GLES20.glTexSubImage2D(IIIIIIIILjava/nio/Buffer;)V",
  "android/opengl/GLES20.glReadPixels(IIIIIILjava/nio/Buffer;)V",
  "android/opengl/GLES20.glDrawArrays(III)V",
  "android/opengl/GLES20.glDrawElements(IIII)V",
  "android/opengl/GLES20.glDrawElements(IIILjava/nio/Buffer;)V",
  "android/opengl/GLES20.glGetIntegerv(ILjava/nio/IntBuffer;)V",
  "android/media/MediaCodec.native_configure([Ljava/lang/String;[Ljava/lang/Object;Landroid/view/Surface;Landroid/media/MediaCrypto;Landroid/os/IHwBinder;I)V",
  "android/graphics/Bitmap.nativeCopyPixelsToBuffer(JLjava/nio/Buffer;)V",
  "android/graphics/Bitmap.nativeCopyPixelsFromBuffer(JLjava/nio/Buffer;)V",
  "dalvik/system/InMemoryDexClassLoader.<init>(Ljava/nio/ByteBuffer;Ljava/lang/ClassLoader;)V",
  "dalvik/system/InMemoryDexClassLoader.<init>([Ljava/nio/ByteBuffer;Ljava/lang/ClassLoader;)V",
  "dalvik/system/InMemoryDexClassLoader.<init>([Ljava/nio/ByteBuffer;Ljava/lang/String;Ljava/lang/ClassLoader;)V",
  "com/android/org/conscrypt/NativeCrypto.EVP_AEAD_CTX_seal_buf(J[BILjava/nio/ByteBuffer;[BLjava/nio/ByteBuffer;[B)I",
  "com/android/org/conscrypt/NativeCrypto.EVP_AEAD_CTX_open_buf(J[BILjava/nio/ByteBuffer;[BLjava/nio/ByteBuffer;[B)I",
]);
// Owner-backed Java mappings retain the local synchronous fast path but may await RPC.
for (const owner of ["libcore/io/Memory","com/android/i18n/timezone/internal/Memory"])
  for (const [peek,poke] of [["peekByte(J)B","pokeByte(JB)V"],["peekShortNative(J)S","pokeShortNative(JS)V"],
    ["peekIntNative(J)I","pokeIntNative(JI)V"],["peekLongNative(J)J","pokeLongNative(JJ)V"]])
    for (const method of [peek,poke]) MAY_SUSPEND.add(`${owner}.${method}`);
for (const owner of ["sun/misc/Unsafe","jdk/internal/misc/Unsafe"])
  for (const [type,desc] of [["Boolean","Z"],["Byte","B"],["Char","C"],["Short","S"],["Int","I"],["Long","J"],["Float","F"],["Double","D"]]) {
    const jdk = owner === "jdk/internal/misc/Unsafe", wide = type === "Int" || type === "Long";
    const gets = wide ? jdk ? ["","Volatile","Acquire","Opaque"] : ["","Volatile"] : [""];
    const puts = wide ? jdk ? ["","Volatile","Release","Opaque"] : ["","Volatile"] : [""];
    for (const suffix of gets)
      MAY_SUSPEND.add(`${owner}.get${type}${suffix}(Ljava/lang/Object;J)${desc}`);
    for (const suffix of puts)
      MAY_SUSPEND.add(`${owner}.put${type}${suffix}(Ljava/lang/Object;J${desc})V`);
    if (type === "Long" || jdk && type === "Int") MAY_SUSPEND.add(`${owner}.putOrdered${type}(Ljava/lang/Object;J${desc})V`);
    if (jdk ? type === "Byte" : type !== "Boolean") {
      MAY_SUSPEND.add(`${owner}.get${type}(J)${desc}`);
      MAY_SUSPEND.add(`${owner}.put${type}(J${desc})V`);
    }
  }
for (const id of ["sun/misc/Unsafe.setMemory(JJB)V","android/os/SharedMemory.nCreate(Ljava/lang/String;I)Ljava/io/FileDescriptor;",
  "android/os/SharedMemory.nGetSize(Ljava/io/FileDescriptor;)I","android/os/SharedMemory.nSetProt(Ljava/io/FileDescriptor;I)I",
  "java/io/FileDescriptor.getAppend(I)Z","libcore/io/Linux.dup(Ljava/io/FileDescriptor;)Ljava/io/FileDescriptor;",
  "sun/nio/ch/FileDispatcherImpl.size0(Ljava/io/FileDescriptor;)J","sun/nio/ch/FileDispatcherImpl.truncate0(Ljava/io/FileDescriptor;J)I",
  "sun/nio/ch/FileDispatcherImpl.close0(Ljava/io/FileDescriptor;)V","sun/nio/ch/FileDispatcherImpl.closeIntFD(I)V",
  "sun/nio/ch/FileChannelImpl.position0(Ljava/io/FileDescriptor;J)J","libcore/io/Linux.close(Ljava/io/FileDescriptor;)V",
  "libcore/io/Linux.munmap(JJ)V","libcore/io/Linux.writeBytes(Ljava/io/FileDescriptor;Ljava/lang/Object;II)I",
  "libcore/io/Linux.pwriteBytes(Ljava/io/FileDescriptor;Ljava/lang/Object;IIJ)I",
  "libcore/io/Memory.memmove(Ljava/lang/Object;ILjava/lang/Object;IJ)V",
  "sun/nio/ch/FileDispatcherImpl.read0(Ljava/io/FileDescriptor;JI)I","sun/nio/ch/FileDispatcherImpl.pread0(Ljava/io/FileDescriptor;JIJ)I",
  "sun/nio/ch/FileDispatcherImpl.write0(Ljava/io/FileDescriptor;JI)I","sun/nio/ch/FileDispatcherImpl.pwrite0(Ljava/io/FileDescriptor;JIJ)I",
  "sun/nio/ch/FileChannelImpl.unmap0(JJ)I","java/nio/MappedByteBuffer.force0(Ljava/io/FileDescriptor;JJ)V"])
  MAY_SUSPEND.add(id);
/** what a native that can answer a Promise has in its body: it waits for something (`await`, a Promise, `after`, `awaited`), reads memory that pages in (`external`, `pagesIn`, `memoryAt`,
 *  `guestAddress`), or hands on the result of a call into Java, which is a Promise when that call waits. The build lists the natives this holds for (`waitingNatives`), as the page
 *  cannot read it from minified code. A native with arrays needs it: it cannot be settled where it was called (natives.ts `parkable`). */
const WAITS = /\b(after|awaited|pagesIn|external|externalRead|externalWrite|writeAt|memoryAt|guestAddress|Promise|await)\b|\breturn\s+(vcall|scall|newObj|callOn)\b|=>\s*(vcall|scall|newObj|callOn)\(/;
/** a generator native (`driven`) or an async function, which always runs as Suspending */
const declaredAsync = (fn: HostFn): boolean => (fn as Native).$g !== undefined || fn.constructor === AsyncFunction;
export const mayWait = (fn: HostFn): boolean => declaredAsync(fn) || WAITS.test(Function.prototype.toString.call(fn));
/** the natives the platform build was made for as Suspending, when the page has it */
let declared: Set<string> | null = null;
export const declareWaiting = (ids: string[]): void => { declared = new Set(ids); };
/** natives found answering a Promise from a plain import: the report in run.json (`nativeSuspended`), and imported as Suspending in modules built afterwards */
export const suspendedNatives = new Set<string>();

/** the context of the Suspending import being called, for the generator driver that starts inside it */
let calling: HostContext | null = null;

/** whether native `fn` answers a Promise on every call, which only a Suspending import can take */
export const waitsAlways = (fn: HostFn): boolean => fn.constructor === AsyncFunction;

/** the Wasm tier's form of a registered native: a generator native runs under an async driver of its own, not Runtime.drive */
export function hostForm(fn: HostFn): HostFn {
  const g = (fn as Native).$g;
  if (!g) return fn;
  return function (this: unknown, ...a: unknown[]) { return drive(g.apply(this, a), calling); };
}
/** runs a generator native: each value it yields is awaited, an exception of a rejected one is thrown into it; the strand is the running one again after each wait,
 *  until the native waits again (other turns run at the top level then) */
async function drive(it: Generator<unknown, unknown, unknown>, ctx: HostContext | null): Promise<unknown> {
  const strand = ctx?.sched.running ?? null;
  let step = it.next();
  while (!step.done) {
    let v = step.value, threw = false, waited = false;
    if (v instanceof Promise) {
      try { v = await v; } catch (e) { v = e; threw = true; }
      if (ctx) { ctx.sched.running = strand; waited = true; }
    }
    try { step = threw ? it.throw(v) : it.next(v); } finally { if (waited) ctx!.sched.running = null; }
  }
  return step.value;
}

/** the services the host implements behind binder: what they call may wait, and they take arrays (out parameters) */
export const SERVICES = "webdroid/";
/** whether native `id` is imported as Suspending */
export function suspends(id: string, fn: HostFn, arrays: boolean): boolean {
  return declaredAsync(fn) || MAY_SUSPEND.has(id) || suspendedNatives.has(id) || (arrays && (id.startsWith(SERVICES) || (declared ? declared.has(id) : mayWait(fn))));
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
