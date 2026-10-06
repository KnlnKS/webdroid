// The Java side of JNI, as the tier that runs Java provides it. jni.ts keeps the tables of references and the marshalling between guest words and Java
// values; every question it asks of a class, an object, a field, a method or an array goes through this interface, so that a reference in a JNI table
// is whatever the tier holds a Java object as (a JS value on the JS tier, a Wasm reference on the Wasm tier, src/wasm/host/jni.ts) and is never read
// through the JS tier's object model.
import type { Runtime } from "../jvm/runtime";
import { jsVm } from "./jnijs";

/** a class JNI has found; its jclass is `mirror` */
export interface JniClass { readonly name: string }
/** a field JNI has found: `key` names it within `cls`, the class that declares it */
export interface JniField { readonly cls: JniClass; readonly key: string; readonly type: string; readonly isStatic: boolean }
/** a method a reflected Method or Constructor stands for */
export interface JniMethod { cls: JniClass; name: string; desc: string; isStatic: boolean }

export interface JniVm {
  // ---------- classes
  /** FindClass: the class `name` of the library's loader (`owner`), or of the loader of `from`, the class of the native method that asks, linked but not initialized; null when there is none */
  find(name: string, owner: Runtime | null, from?: JniClass | null): JniClass | null;
  /** the runtime a class was loaded by, when it is not the default one */
  owner(c: JniClass): Runtime | null;
  /** the binary name of the class `name` stands for, which its natives' JNI short names spell */
  binaryName(name: string): string;
  /** the java.lang.Class of a class */
  mirror(c: JniClass, owner?: Runtime | null): unknown;
  /** the class a java.lang.Class stands for */
  classOf(mirror: unknown): JniClass | null;
  /** the java.lang.Class of an object's class */
  objectClass(o: unknown): unknown;
  /** the java.lang.Class of a class's superclass, or null */
  superClass(c: JniClass): unknown;
  assignable(from: JniClass, to: JniClass): boolean;
  isInstance(o: unknown, c: JniClass): boolean;
  /** runs the class's initializer: a Promise while it waits, null once done */
  init(c: JniClass): Promise<void> | null;

  // ---------- members
  /** whether `name``sig` is a method of `c` (declared, inherited or abstract) that a call can name */
  hasMethod(c: JniClass, name: string, sig: string, isStatic: boolean): boolean;
  field(c: JniClass, name: string, sig: string, isStatic: boolean): JniField | null;
  /** a field's value (an object field's is a reference, a float's a number); `o` is the receiver of an instance field */
  get(f: JniField, o: unknown): unknown;
  set(f: JniField, o: unknown, v: unknown): void;
  /** calls the method on `self` (null for a static one), virtually unless `nonvirtual`; the result, or a Promise while the callee waits. A Java exception is thrown. */
  invoke(c: JniClass, name: string, sig: string, isStatic: boolean, self: unknown, args: unknown[], nonvirtual: boolean): unknown;
  /** a new instance of `c` its constructor `sig` has run on; a Promise while the constructor waits */
  construct(c: JniClass, sig: string, args: unknown[]): unknown;
  /** an instance of `c` no constructor has run on; the class is initialized first */
  allocate(c: JniClass): unknown;
  /** the Method or Constructor object for a method of a class */
  reflect(c: JniClass, name: string, desc: string, isStatic: boolean): unknown;
  /** the method a Method or Constructor object stands for, or the field a Field stands for */
  unreflectMethod(o: unknown): JniMethod | null;
  unreflectField(o: unknown): JniField | null;
  /** whether a method declared `native` is static, and whether it is a @CriticalNative */
  nativeKind(c: JniClass, name: string, sig: string): { isStatic: boolean; critical: boolean };
  /** a native method is bound to `entry`: code compiled before the binding calls it from now on */
  bind(c: JniClass, name: string, sig: string, isStatic: boolean, entry: (...a: never[]) => unknown, params: number): void;

  // ---------- strings, arrays
  /** a Java String of a JS string, and the JS string of a Java String */
  string(js: string): unknown;
  chars(s: unknown): string;
  length(array: unknown): number;
  /** the element type letter of a primitive array */
  elementType(array: unknown): string;
  newPrimitiveArray(type: string, n: number): unknown;
  /** an array of n references of class `c` (null: Object) all `init` */
  newObjectArray(n: number, c: JniClass | null, init: unknown): unknown;
  element(array: unknown, i: number): unknown;
  setElement(array: unknown, i: number, v: unknown): void;
  /** n elements of a primitive array from `start` to guest memory at `p`, and from guest memory into the array */
  toGuest(array: unknown, type: string, start: number, n: number, p: number): void;
  fromGuest(array: unknown, type: string, start: number, n: number, p: number): void;

  // ---------- exceptions, monitors, buffers
  throwable(cls: string, msg: string): unknown;
  /** the NoClassDefFoundError for a class FindClass could not find */
  noClass(name: string): unknown;
  /** the Java throwable an exception that left a call is */
  caught(e: unknown): unknown;
  /** what to throw so that Java sees throwable `t` raised by a native */
  raise(t: unknown): unknown;
  describe(t: unknown): Promise<string> | string;
  monitor(o: unknown, enter: boolean): Promise<void> | void;
  /** a direct buffer over native memory, its address and capacity; the address is a native address, 0 for a buffer that has none */
  newBuffer(address: number | bigint, capacity: number): unknown;
  bufferAddress(o: unknown): bigint | null;
  bufferCapacity(o: unknown): number;
  /** a Java object as native code written against the production runtime (libandroid, bitmap) reads it */
  host(o: unknown): unknown;
}

/** the tier that runs Java: the JS tier's until the Wasm tier installs its own */
export let vm: JniVm = jsVm;
export function useJniVm(next: JniVm): void { vm = next; }
