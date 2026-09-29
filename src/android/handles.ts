// The handle table framework Java holds a `long` into — layoutlib's DelegateManager.
//
// It lives on its own rather than inside delegates.ts because it has two sides. A delegate
// takes a handle and gives back the object; but AOSP bytecode also asks OUR objects for their
// native pointer (`Paint.getNativeInstance()`, and every class that hands one to a builder),
// and graphics.ts cannot import delegates.ts — delegates.ts imports it.
//
// Handle 0 is null, so a field that was never initialised dereferences to nothing rather than
// to slot 0. A handle is stable per object: asking twice gives the same long, which matters
// because getNativeInstance() is called per text run and a fresh slot per call would grow this
// table without bound.

import { rt } from "../jvm/runtime";

const objs: (object | undefined)[] = [undefined];
const byObj = new WeakMap<object, bigint>();
/** released slots, reused so a native object recreated every frame does not grow the table */
const free: number[] = [];

/** hand framework Java a long for this object */
export function handle(o: object): bigint {
  let h = byObj.get(o);
  if (h === undefined) {
    const n = free.pop() ?? objs.push(undefined) - 1;
    objs[n] = o;
    byObj.set(o, (h = BigInt(n)));
  }
  return h;
}

const collected = new FinalizationRegistry<number>((n) => { objs[n] = undefined; free.push(n); });
/** A long for an object no Java finalizer releases (a TS-spec Canvas asked for its native
 *  wrapper): the slot holds a WeakRef, which its reader unwraps, and frees itself once the
 *  object is collected. Such a handle is never released or replaced by hand. */
export function weakHandle(o: object): bigint {
  let h = byObj.get(o);
  if (h === undefined) {
    const n = free.pop() ?? objs.push(undefined) - 1;
    objs[n] = new WeakRef(o);
    byObj.set(o, (h = BigInt(n)));
    collected.register(o, n);
  }
  return h;
}

/** the object behind a long, or undefined for the null handle */
export function deref<T>(h: bigint): T {
  return objs[Number(h)] as T;
}

/** put a different object behind an existing handle — reset/set-from-source, where the
 *  framework keeps its long and we swap what it points at */
export function replace(h: bigint, o: object): void {
  const n = Number(h);
  const old = objs[n];
  if (old) byObj.delete(old);
  objs[n] = o;
  byObj.set(o, h);
}

export function release(h: bigint): void {
  const n = Number(h);
  const old = objs[n];
  if (!old) return;
  byObj.delete(old);
  objs[n] = undefined;
  free.push(n);
}

// A platform class that frees its native state in finalize() (Region, Picture, PathMeasure, ...)
// would leak its handle here, where finalizers never run: a JS finalizer cannot see the object it
// finalizes. What it frees is the handle in a long field, so the handle's native state lives as
// long as the first Java object to store it (Runtime.link routes those classes' long fields here).
const owned = new WeakSet<object>();
const owners = new FinalizationRegistry<{ h: bigint; o: object }>(({ h, o }) => { if (objs[Number(h)] === o) release(h); });
/** a handle whose native state belongs to the Java object that stores it */
export function ownedHandle(o: object): bigint {
  owned.add(o);
  return handle(o);
}
rt.claimHandle = (owner: object, h: bigint) => {
  const o = h ? objs[Number(h)] : undefined;
  if (o && owned.delete(o)) owners.register(owner, { h, o });
};

/** A finalizer is a function pointer the class hands to NativeAllocationRegistry, which only
 *  ever passes it back to us. One shared handle to the release function is enough. */
export const FINALIZER = handle((h: bigint) => release(h));
