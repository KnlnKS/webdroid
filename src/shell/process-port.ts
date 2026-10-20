import { note, Ev } from "../timeline.ts";
import type { ProcessEndpoint } from "./processes.ts";

type Contract = Record<string, (...args: never[]) => unknown>;
type Message = { kind: "call" | "notify"; id: number; method: string; args: unknown[] }
  | { kind: "result"; id: number; value: unknown }
  | { kind: "error"; id: number; error: ProcessFailure } | { kind: "close"; error?: ProcessFailure };
/** `names`, which must list every method of C; a proxy can only call the methods it names */
export const methodsOf = <C extends Contract>() => <const L extends readonly (keyof C & string)[]>(
  names: L & ([Exclude<keyof C, L[number]>] extends [never] ? unknown : { missing: Exclude<keyof C, L[number]> })): L => names;
const methods = methodsOf<ProcessEndpoint>()(["processDied", "activity", "transact", "service", "serviceConnected", "contentProvider", "broadcast", "cookiesChanged", "storageChanged", "packageRemoved", "kill"]);

export type ProcessFailure = { javaClass: string | null; name: string; message: string | null; stack?: string };

/** Java exceptions cross as class/message data, never as objects belonging to another VM. */
export function processFailure(error: unknown): ProcessFailure {
  if (error && typeof error === "object") {
    const explicit: unknown = Reflect.get(error, "$javaClass");
    const ctor: unknown = Reflect.get(error, "constructor"), info: unknown = typeof ctor === "function" ? Reflect.get(ctor, "$i") : null;
    const javaClass: unknown = typeof explicit === "string" ? explicit : info && typeof info === "object" ? Reflect.get(info, "name") : undefined;
    const name: unknown = Reflect.get(error, "name"), message: unknown =
      (typeof javaClass === "string" ? Reflect.get(error, "msg") : undefined) ?? Reflect.get(error, "message");
    const stack = typeof javaClass === "string" ? undefined : Reflect.get(error, "stack");
    return { javaClass: typeof javaClass === "string" ? javaClass : null,
      name: typeof name === "string" ? name : "Error", message: typeof message === "string" ? message : null, ...(typeof stack === "string" ? { stack } : {}) };
  }
  return { javaClass: null, name: "Error", message: String(error) };
}
export function processError(error: ProcessFailure): Error {
  const result = new Error(error.message ?? ""); result.name = error.javaClass ?? error.name;
  if (!error.javaClass && typeof error.stack === "string") result.stack = error.stack;
  return result;
}
const closedFailure: ProcessFailure = { javaClass: "android/os/DeadObjectException", name: "Error", message: "Process endpoint closed" };
/** closes `port` once its peer is told, with `error` as the reason; a port a failed transfer
 *  detached is only closed */
export function closePort(port: MessagePort, error?: ProcessFailure): void {
  try { port.postMessage({ kind: "close", error } satisfies Message); } catch { /* detached */ }
  port.close();
}

/** per method, what acts on a call's result */
type ByResult<C extends Contract, R> = { [K in keyof C]?: (value: Awaited<ReturnType<C[K]>>) => R };
/** per method, what acts on a call's arguments */
type ByArgs<C extends Contract, R> = { [K in keyof C]?: (...args: Parameters<C[K]>) => R };
const NONE: Transferable[] = [];
/** One process's endpoint. Calls are dispatched independently: a Binder callback may reenter
 *  this endpoint while the request that caused it is suspended. `undelivered` releases a result that never reached its caller;
 *  `transfer` names what a result gives away. A proxy may call over the same port (duplex). */
export function serveCalls<C extends Contract>(port: MessagePort, endpoint: C, onClose: () => void = () => {},
  undelivered: ByResult<C, unknown> = {}, transfer: ByResult<C, Transferable[]> = {}): () => void {
  const allowed = new Set(Object.keys(endpoint)), index = new Map(Object.keys(endpoint).map((name, i) => [name, i]));
  let closed = false;
  const close = (error?: ProcessFailure) => {
    if (closed) return;
    closed = true;
    closePort(port, error); onClose();
  };
  port.addEventListener("messageerror", () => close(closedFailure));
  port.addEventListener("message", async ({ data }: MessageEvent<Message>) => {
    if (closed) return;
    if (data.kind === "close") { close(); return; }
    if (data.kind !== "call" && data.kind !== "notify") return;
    try {
      if (!allowed.has(data.method) || !Array.isArray(data.args)) throw new Error("Unknown process endpoint method");
      const invoke = endpoint[data.method] as (...args: unknown[]) => unknown, at = index.get(data.method)!;
      // a notification has no caller waiting on it: only calls are timed
      const call = data.kind === "call";
      if (call) note(Ev.Serve, at);
      const value = await invoke.apply(endpoint, data.args);
      if (!call) return;
      note(Ev.Served, at);
      const release = undelivered[data.method] as ((value: unknown) => unknown) | undefined;
      const given = transfer[data.method] as ((value: unknown) => Transferable[]) | undefined;
      if (closed) await release?.(value);
      else try { port.postMessage({ kind: "result", id: data.id, value } satisfies Message, given?.(value) ?? NONE); }
      catch (error) { await release?.(value); throw error; }
    } catch (error) {
      if (data.kind === "notify") close(processFailure(error));
      else if (!closed) port.postMessage({ kind: "error", id: data.id, error: processFailure(error) } satisfies Message);
    }
  });
  port.start();
  return close;
}

/** The broker's proxy. The caller supplies its own VM's exception constructor; `transfer` names what a call's
 *  arguments give away. */
export function callProxy<C extends Contract>(port: MessagePort, names: readonly (keyof C & string)[],
  notifications: readonly (keyof C & string)[] = [], makeError: (error: ProcessFailure) => unknown = processError,
  onClose: (error: ProcessFailure) => void = () => {}, transfer: ByArgs<C, Transferable[]> = {}): { endpoint: C; close(): void } {
  let closed = false, nextId = 1;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; method: number }>();
  const index = new Map(names.map((name, i) => [name as string, i]));
  const finish = (error = closedFailure) => {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) request.reject(makeError(error));
    pending.clear(); port.close(); onClose(error);
  };
  const close = () => { if (!closed) port.postMessage({ kind: "close" } satisfies Message); finish(); };
  port.addEventListener("messageerror", close);
  port.addEventListener("message", ({ data }: MessageEvent<Message>) => {
    if (data.kind === "close") { finish(data.error); return; }
    if (data.kind !== "result" && data.kind !== "error") return;
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    note(Ev.Answer, request.method);
    if (data.kind === "result") request.resolve(data.value);
    else request.reject(makeError(data.error));
  });
  port.start();
  const given = (method: string, args: unknown[]) => (transfer[method] as ((...args: unknown[]) => Transferable[]) | undefined)?.(...args) ?? NONE;
  const call = (method: string, args: unknown[]): Promise<unknown> => {
    if (closed) return Promise.reject(makeError(closedFailure));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const at = index.get(method) ?? -1;
      pending.set(id, { resolve, reject, method: at });
      note(Ev.Call, at);
      try { port.postMessage({ kind: "call", id, method, args } satisfies Message, given(method, args)); }
      catch (error) { pending.delete(id); reject(error); }
    });
  };
  const notify = new Set<string>(notifications);
  const endpoint = Object.fromEntries(names.map(method => [method, (...args: unknown[]) => {
    if (!notify.has(method)) return call(method, args);
    if (closed) throw makeError(closedFailure);
    port.postMessage({ kind: "notify", id: 0, method, args } satisfies Message, given(method, args));
  }])) as unknown as C;
  return { close, endpoint };
}

/** `endpoint` served and `names` called over one port, so that messages keep one order both ways; either
 *  side's close closes both */
export function duplex<S extends Contract, C extends Contract>(port: MessagePort, endpoint: S, names: readonly (keyof C & string)[],
  notifications: readonly (keyof C & string)[], onClose: () => void, transfer: ByArgs<C, Transferable[]> = {}): { endpoint: C; close(): void } {
  let closed = false;
  const close = () => { if (closed) return; closed = true; stop(); proxy.close(); onClose(); };
  const stop = serveCalls(port, endpoint, close), proxy = callProxy<C>(port, names, notifications, processError, close, transfer);
  return { endpoint: proxy.endpoint, close };
}

export const serveProcess = (port: MessagePort, endpoint: ProcessEndpoint): (() => void) => serveCalls(port, endpoint);
export function processProxy(port: MessagePort, makeError: (error: ProcessFailure) => unknown = processError,
  onClose: (error: ProcessFailure) => void = () => {}): { endpoint: ProcessEndpoint; close(): void } {
  return callProxy<ProcessEndpoint>(port, methods, ["kill"], makeError, onClose);
}
