// The handle table framework Java holds a `long` into — layoutlib's DelegateManager. Every
// module implementing natives hands its objects out and resolves them here.
//
// Handle 0 is null, so a field that was never initialised dereferences to nothing rather than
// to slot 0. A handle is stable per object: asking twice gives the same long, so an object handed
// out again and again (a font's identity pointer, a shared native instance) does not grow this
// table.

import { rt } from "../jvm/runtime";

const objs: (object | undefined)[] = [undefined];
const disposers = new WeakMap<object, () => void>();
/** Engines that reject Wasm GC weak keys use the strong table. */
const weak = new WeakMap<object, bigint>(), strong = new Map<object, bigint>();
const byObj = {
  get: (o: object): bigint | undefined => weak.get(o) ?? strong.get(o),
  set: (o: object, h: bigint): void => { try { weak.set(o, h); } catch { strong.set(o, h); } },
  delete: (o: object): void => { weak.delete(o); strong.delete(o); },
};
/** Released slots, reused so a native object recreated every frame does not grow the table —
 *  oldest first, and only once QUARANTINE later releases have queued behind them. Framework Java
 *  tells a replaced native instance by its long (Paint.getNativeInstance re-sends a shader, and
 *  ComposeShader rebuilds, only when the handle differs), so the long a release frees must not
 *  come straight back for the object that replaces it. */
const QUARANTINE = 1024;
let free: number[] = [], head = 0;
function slot(): number {
  if (free.length - head <= QUARANTINE) return objs.push(undefined) - 1;
  const n = free[head++];
  if (head * 2 > free.length) { free = free.slice(head); head = 0; }
  return n;
}

/** hand framework Java a long for this object */
export function handle(o: object): bigint {
  let h = byObj.get(o);
  if (h === undefined) {
    const n = slot();
    objs[n] = o;
    byObj.set(o, (h = BigInt(n)));
  }
  return h;
}

/** a weak slot: `objs` holds this marker and `refs` the object's WeakRef */
const WEAK = {};
const refs: (WeakRef<object> | undefined)[] = [];
const collected = new FinalizationRegistry<{ n: number; ref: WeakRef<object> }>(({ n, ref }) => {
  if (refs[n] !== ref) return;
  objs[n] = refs[n] = undefined;
  free.push(n);
});
/** A long for an object no Java finalizer releases, such as a font's identity pointer or a vector
 *  drawable's node: the slot does not keep the object alive, and frees itself once the object is
 *  collected. */
export function weakHandle(o: object): bigint {
  let h = byObj.get(o);
  if (h === undefined) {
    const n = slot(), ref = new WeakRef(o);
    objs[n] = WEAK; refs[n] = ref;
    byObj.set(o, (h = BigInt(n)));
    collected.register(o, { n, ref });
  }
  return h;
}

/** how the Wasm tier, which holds Java arrays apart from the host's, gives natives the arrays whose handles it handed out: a view the native's writes are stored back from */
export const handleViews = { of: null as ((o: object) => unknown) | null };

/** the object behind a long, or undefined for the null handle */
export function deref<T>(h: bigint): T {
  const n = Number(h), o = objs[n], v = o === WEAK ? refs[n]!.deref() : o;
  return (handleViews.of !== null && typeof v === "object" && v !== null && Object.getPrototypeOf(v) === null ? handleViews.of(v) : v) as T;
}

export function release(h: bigint): void {
  const n = Number(h);
  if (!objs[n]) return;
  const old = objs[n] === WEAK ? refs[n]!.deref() : objs[n];
  const dispose = old && disposers.get(old);
  if (old) { byObj.delete(old); disposers.delete(old); }
  objs[n] = refs[n] = undefined;
  free.push(n);
  dispose?.();
}
/** the object behind a handle its receiver takes over, as a JNI unique_ptr's release does: the
 *  handle is freed */
export function take<T>(h: bigint): T {
  const o = deref<T>(h);
  if (o && typeof o === "object") disposers.delete(o);
  release(h);
  return o;
}

// A platform class that frees its native state in finalize() (Region, Picture, PathMeasure, ...)
// would leak its handle here, where finalizers never run: a JS finalizer cannot see the object it
// finalizes. What it frees is the handle in a long field, so the handle's native state lives as
// long as the first Java object to store it (World.claims marks those classes' long fields).
const owned = new WeakSet<object>();
const owners = new FinalizationRegistry<{ h: bigint; o: object }>(({ h, o }) => { if (objs[Number(h)] === o) release(h); });
/** Native state follows its Java owner; release disposes it, while take transfers it. */
export function ownedHandle(o: object, dispose?: () => void): bigint {
  owned.add(o);
  if (dispose) disposers.set(o, dispose);
  return handle(o);
}
rt.claimHandle = (owner: object, h: bigint) => {
  const o = h ? objs[Number(h)] : undefined;
  if (o && owned.delete(o)) owners.register(owner, { h, o });
};

/** A finalizer is a function pointer the class hands to NativeAllocationRegistry, which only
 *  ever passes it back to us. One shared handle to the release function is enough. */
export const FINALIZER = handle((h: bigint) => release(h));

// RefBase natives opt in with the reference already acquired by their JNI creator.
// Other handle kinds retain their existing ownership/finalizer contracts.
const strongRefs = new WeakMap<object, number>();
export function refBaseHandle(o: object, initial: number): bigint {
  strongRefs.set(o, initial);
  return handle(o);
}
export function incStrong(h: bigint): void {
  const o = deref<object>(h);
  if (o && strongRefs.has(o)) strongRefs.set(o, strongRefs.get(o)! + 1);
}
export function decStrong(h: bigint): void {
  const o = deref<object>(h), count = o && strongRefs.get(o);
  if (count === undefined) { release(h); return; }
  if (count > 1) strongRefs.set(o, count - 1);
  else { strongRefs.delete(o); release(h); }
}
export const REFBASE_FINALIZER = handle(decStrong);
