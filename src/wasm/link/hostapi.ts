// What the VM needs from the host layer, as interfaces, so that nothing below host/ imports it: the registered natives, the bridge that
// marshals Java objects for them, and the network resolver. host/ provides the implementations.
import type { Compiler, Intrinsic } from "../compiler/j2w";
import type { MethodInfo } from "../compiler/program";
import type { Code } from "../compiler/code";
import type { World } from "./world";
import type { DexFile } from "../../jvm/dex";
import type { Sched, Strand } from "./sched";

export type HostFn = (...a: any[]) => unknown;

/** a Java class a registered spec implements in the host (rt.register outside the VM's own classes): its Java objects have a host object of `ctor` beside them, which its natives take as `this` */
export interface HostSpec {
  name: string;
  sup: string | null;
  ifaces: string[];
  /** the methods the spec implements, by name+descriptor, with "static " for a static one */
  methods: string[];
  /** the Java-visible instance fields and the host properties that hold them */
  fields: [javaName: string, prop: string][];
  ctor: new () => object;
}
/** the class that holds, beside an existing class, the methods of its spec that a superclass declares (hostclass.ts); the natives are found under the class's own name */
export const HOSTED = "$$host";
export const specClass = (cls: string): string => (cls.endsWith(HOSTED) ? cls.slice(0, -HOSTED.length) : cls);

export interface NativeSource {
  /** the registered implementation of `cls`.`key` (name+descriptor); an instance method's `this` is its receiver. A String
   *  constructor's key is `<init>desc` and its implementation answers the String */
  find(cls: string, key: string, isStatic: boolean, hasBody: boolean): HostFn | undefined;
  /** a Java throwable raised by a native, by class and message */
  thrown(e: unknown): { cls: string; msg: string | null; obj?: object; java?: object } | undefined;
  /** the Java class name of an object the production runtime made, if `v` is one: a native result the Bridge copies into the Wasm heap */
  classOf?(v: unknown): string | undefined;
  /** runs `run`, a `static ()V` native of `cls` that fills in static fields (initConstants), and answers the values it stored by "name:descriptor" */
  stores?(cls: string, run: () => void): Record<string, unknown>;
  /** the classes the host implements */
  hostSpecs?(): HostSpec[];
}

/** how Java objects cross to a native and back */
export interface HostBridge {
  begin(): number;
  end(mark: number): void;
  initialize(cls: string, run: () => unknown): void;
  toHost(v: unknown, desc?: string, range?: [number, number]): unknown;
  offsetIn(host: unknown, offset: number): number;
  toJava(v: unknown, desc: string): unknown;
  copyFields(o: Record<string, unknown>, j: object, cls: string): void;
  /** sets the scope of the call in progress aside while its strand waits, and answers the function that takes it up again */
  hold(): () => void;
  /** Java method `m` (a static one, or on the Java object `recv`) with host arguments, answering a host value */
  invoke(m: MethodInfo, recv: object | null, args: unknown[]): unknown;
  /** `invoke` on strand `s`, whose stack can wait: a Promise of the host value when the call waited */
  invokeOn(s: Strand, m: MethodInfo, recv: object | null, args: unknown[]): unknown;
}

/** what the host side needs from the World */
export interface HostContext {
  mem: WebAssembly.Memory; sp: WebAssembly.Global;
  /** a Java throwable of a class with a message, and the exception that throws it through Wasm */
  throwable(cls: string, msg: string | null): object;
  raise(throwable: object): unknown;
  bridge: HostBridge;
  /** the strands: a Suspending import is made by `sched.suspending`, and `sched.running` is the strand a native that calls back into Java runs it as */
  sched: Sched;
  /** records that compiled code ran into something it cannot do (World.onGap) */
  gap(what: string): void;
}

/** the registered natives as the compiler and the World use them: bound to Wasm imports by descriptor */
export interface NativeBinder {
  readonly source: NativeSource | undefined;
  /** makes the host import of native `m` available (a precompiled module imports it by id); whether it has one */
  prepare(m: MethodInfo): boolean;
  /** why `m` has no host binding */
  reason(m: MethodInfo): string;
  /** adds the imports of the natives `methods` call (and of the methods themselves); before any function of the module is defined */
  declare(cx: Compiler, methods: Iterable<MethodInfo>): void;
  /** m's body is a call of its host import */
  stub(m: MethodInfo): Intrinsic | undefined;
  /** the function making a String the way constructor `m` does, over the production implementation */
  factory(cx: Compiler, m: MethodInfo): number | undefined;
  /** emits `m` over its own parameter locals: converts them to the import's types, calls it, converts the result */
  call(cx: Compiler, c: Code, m: MethodInfo): void;
  /** the "n" import module for `ids`: each native with its exception handling, and its arrays viewed in memory */
  imports(ctx: HostContext, ids: Iterable<string>): Record<string, HostFn>;
  bridge(w: World): HostBridge;
}

/** answers `host.net` for libcore's getaddrinfo (inet.ts): an address count or minus an EAI code for a lookup, a byte of a found address */
export type HostNet = (w: World, op: number, node: string, a: number, b: number) => number;

/** a second-tier compiler that runs elsewhere (a worker, host/compiler.ts). It is given the World's jobs and answers with `World.adoptUnit`; it may decline, and then the World compiles inline. */
export interface CompileService {
  /** takes the second-tier compile of the method in `slot` (`World.upgradeJob` describes it); false if it cannot */
  submit(w: World, slot: number): boolean;
  /** dex files were added to the Program's default namespace, or (null) something the service cannot follow was: it stops serving */
  added(dexes: DexFile[] | null): void;
}
