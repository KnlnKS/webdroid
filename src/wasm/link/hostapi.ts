// What the VM needs from the host layer, as interfaces, so that nothing below host/ imports it: the registered natives, the bridge that
// marshals Java objects for them, and the network resolver. host/ provides the implementations.
import type { Compiler, Intrinsic } from "../compiler/j2w";
import type { MethodInfo } from "../compiler/program";
import type { Code } from "../compiler/code";
import type { World } from "./world";

export type HostFn = (...a: any[]) => unknown;

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
  /** Java method `m` (a static one, or on the Java object `recv`) with host arguments, answering a host value */
  invoke(m: MethodInfo, recv: object | null, args: unknown[]): unknown;
}

/** what the host side needs from the World */
export interface HostContext {
  mem: WebAssembly.Memory; sp: WebAssembly.Global;
  /** a Java throwable of a class with a message, and the exception that throws it through Wasm */
  throwable(cls: string, msg: string | null): object;
  raise(throwable: object): unknown;
  bridge: HostBridge;
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
