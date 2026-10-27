// What the tier that runs Java gives the runtime and the natives, installed in one step (`useJavaHost`) and read as `java.x` at each use: the calls
// into Java, JNI, the Java objects host code makes and what the host asks of the tier's threads. Until a tier installs one, Java is unreachable and a
// throwable is a plain Error.
import type { JavaClass } from "./tier.ts";
import type { JThread } from "./natives/jentry.ts";
import type { BoxDesc } from "./natives/jbox.ts";
import type { NativeSpec } from "./runtime.ts";
import type { JniVm } from "../native/jnivm.ts";

/** How host code enters Java: the World's (src/wasm/host/entry.ts), which src/jvm/natives/jentry.ts's functions call */
export interface Entry {
  /** Dynamic virtual call from native code: the result, or a Promise when the callee suspends. */
  vcall(obj: any, name: string, desc: string, ...args: unknown[]): any;
  /** A static Java call from native code, once the class has initialized, on the calling thread */
  scall(cls: string, name: string, desc: string, ...args: unknown[]): any;
  /** `new cls(args)` from native code: initialize the class, then run the Java constructor `desc`; synchronous unless initialization or the constructor suspends */
  newObj(cls: string, desc?: string, ...args: unknown[]): any;
  /** a static field's value, once the class has initialized */
  staticField<T = unknown>(cls: string, field: string): PromiseOrVal<T>;
  /** link + run <clinit>: the class is ready to be instantiated or have its statics read */
  linkInit(cls: string): PromiseOrVal<JavaClass>;
  /** the class named `cls`, linked only: its fields and methods exist, `<clinit>` has not run */
  linkClass(cls: string): JavaClass;
  /** run `cls`'s <clinit> if it has not, linking it first; null when it was ready */
  initClass(cls: string): Promise<void> | null;
  /** is `o` an instance of the class named `cls` */
  iof(o: unknown, cls: string): boolean;
  /** the name of the class of the Java object `o` */
  classNameOf(o: unknown): string | undefined;
  /** `call` on `thread`, which owns the turn while it runs, as a chain of its own */
  callOn<T>(thread: JThread, call: () => T): T;
  /** `f` of `r`, now or once it settles, as the thread and call chain that call `after`. A native that waits enters Java again through it
   *  or as a generator native: code after an `await` or in a `.then` runs as the host's current thread */
  after<R, T>(r: PromiseOrVal<R>, f: (v: R) => PromiseOrVal<T>): PromiseOrVal<T>;
}

export interface JavaHost extends Entry {
  jni: JniVm;
  /** a Java throwable of class `cls` with message `msg` */
  throwable(cls: string, msg: string | null): unknown;
  /** an instance of `cls`, its constructor not run */
  make(cls: string): unknown;
  /** the java.lang.Class of `cls` */
  classFor(cls: string): unknown;
  /** Java's own box of `v`, as `valueOf` makes it */
  box(desc: BoxDesc, v: number | bigint): unknown;
  /** the property a facade holds `cls`'s instance field `name` under */
  fieldName(cls: string, name: string): string | undefined;
  /** the Java frames calling into the runtime here, innermost first */
  javaFrames(): string[];
  /** the loader of the innermost Java frame whose class is not the platform's */
  userClassLoader(): object | null;
  /** the host form of `o`, a Java object a handle holds (android/handles.ts deref) */
  toHost(o: object): unknown;
  /** a spec registered after the World was made (a module a split bundle loads later) */
  registered(spec: NativeSpec): void;
  /** whether another thread is blocked on a lock or class initialization `t` holds */
  contended(t: JThread): boolean;
  /** the process's live threads by tid and their native names, what /proc/self/task lists (shell/procfs.ts) */
  tasks?: { tids(): number[]; name(tid: number): string | null; rename(tid: number, name: string): boolean };
}

const unset = (): never => { throw new Error("no World runs Java yet: useWorld installs one"); };
const none: JavaHost = {
  vcall: unset, scall: unset, newObj: unset, staticField: unset, linkInit: unset, linkClass: unset, initClass: unset, iof: unset, classNameOf: unset, callOn: unset, after: unset,
  get jni(): JniVm { return unset(); },
  throwable: (cls, msg) => Object.assign(new Error(`${cls}: ${msg}`), { $javaClass: cls, msg }),
  make: (cls) => { throw new Error(`no World makes ${cls}`); },
  classFor: (cls) => { throw new Error(`no World has the Class of ${cls}`); },
  box: unset, fieldName: () => undefined, javaFrames: () => [], userClassLoader: () => null, toHost: (o) => o, registered() {}, contended: () => false,
};
/** the tier's host, which `useJavaHost` installs */
export let java: JavaHost = none;
/** whether a tier runs Java in this realm yet */
export const javaRuns = (): boolean => java !== none;
/** from here host code reaches Java through `host` */
export function useJavaHost(host: JavaHost): void { java = host; }
