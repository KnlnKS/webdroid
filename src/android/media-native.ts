// What the media classes' native halves share: the peer a JNI keeps for a Java object, events
// posted back through postEventFromNative, and the sources a native half reads.
import { rt, setDeclared, type JObj } from "../jvm/runtime.ts";
import { after, callOn, scall, vcall } from "../jvm/natives/jentry.ts";
import { binderThread } from "./binder.ts";
import { javaFdSource } from "../native/fs.ts";
import { SliceFile, type FileSource } from "../shell/lazyfile.ts";
import { postMain } from "./mainloop.ts";

/** The native halves of a Java class's objects: attached by setup and closed once, by release or
 *  finalize. Given `cls`, an attached object's mNativeContext is non-zero, which is all its Java
 *  reads of it. A call without a peer is an IllegalStateException with `missing`. */
export function nativePeer<T>(cls: string | null, missing: string | null, close: (peer: T) => void = () => {}) {
  const peers = new WeakMap<JObj, T>();
  const get = (obj: JObj): T => {
    const peer = peers.get(obj);
    if (peer === undefined) throw rt.mkThrowable("java/lang/IllegalStateException", missing);
    return peer;
  };
  return {
    get,
    find: (obj: JObj): T | undefined => peers.get(obj),
    attach(obj: JObj, peer: T): void {
      peers.set(obj, peer);
      if (cls) setDeclared(obj, cls, { mNativeContext: 1n });
    },
    detach: function (this: JObj): void {
      const peer = peers.get(this);
      if (peer === undefined) return;
      peers.delete(this); close(peer);
      if (cls) setDeclared(this, cls, { mNativeContext: 0n });
    },
    /** a JNI method over the receiver's peer */
    on: <A extends unknown[], R>(f: (peer: T, ...a: A) => R) => function (this: JObj, ...a: A): R { return f(get(this), ...a); },
  };
}

/** An event to `to`'s postEventFromNative on the main thread, as the JNI's listener posts one; a
 *  [class, WeakReference] target is the static form. It is dropped unless `live` holds when it
 *  runs, and `obj` builds its payload then. */
export function postNativeEvent(to: JObj | [string, JObj], live: (() => boolean) | null, what: number, arg1 = 0, arg2 = 0, obj: () => unknown = () => null): void {
  postMain(() => !live || live() ? after(obj(), (o) => Array.isArray(to)
    ? scall(to[0], "postEventFromNative", "(Ljava/lang/Object;IIILjava/lang/Object;)V", to[1], what, arg1, arg2, o)
    : vcall(to, "postEventFromNative", "(IIILjava/lang/Object;)V", what, arg1, arg2, o)) : undefined);
}

/** At most `length` bytes of a descriptor from `offset`, or null when it is not a readable file or
 *  the range is empty or starts outside it */
export function fdSlice(fd: number, offset: bigint, length: bigint): FileSource | null {
  const file = javaFdSource(fd);
  if (!file || offset < 0n || length <= 0n || offset >= BigInt(file.size)) return null;
  const start = Number(offset);
  return new SliceFile(file, start, Math.min(Number(length), file.size - start));
}

/** A Java MediaDataSource as a source. The player and the retriever read it from the media server
 *  through IDataSource, so each read reaches readAt on one of this process's binder threads. */
export function dataSourceFile(ds: JObj): FileSource | Promise<FileSource> {
  return after(vcall(ds, "getSize", "()J"), (size: bigint): FileSource => ({ size: Math.max(0, Number(size)), read: async (offset, length) => {
    const out = new Int8Array(length);
    const count: number = await callOn(binderThread(), () => vcall(ds, "readAt", "(J[BII)I", BigInt(offset), out, 0, length));
    return count <= 0 ? new Uint8Array(0) : new Uint8Array(out.buffer, 0, Math.min(count, length));
  } }));
}
