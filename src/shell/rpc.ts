// Typed calls across a MessagePort: one side serves a contract's methods, the other calls them by name.
import { note, Ev } from "../timeline.ts";

type Contract = Record<string, (...args: never[]) => unknown>;
/** a contract's method names by domain, "" naming its own: a domain's are called as `domain.method` */
export type MethodTree = { readonly [domain: string]: readonly string[] };
/** each method of `methods` by the name it is called by, in the order a timeline indexes calls */
export const qualified = (methods: MethodTree): string[] =>
  Object.entries(methods).flatMap(([domain, names]) => domain ? names.map((name) => `${domain}.${name}`) : names);
type Message = { kind: "call" | "notify"; id: number; method: string; args: unknown[] }
  | { kind: "result"; id: number; value: unknown }
  | { kind: "error"; id: number; error: CallFailure } | { kind: "close"; error?: CallFailure };
/** the methods of C that are not in a domain */
export type Own<C> = { [K in keyof C as C[K] extends (...args: never[]) => unknown ? K : never]: C[K] };
/** `names`, which must list every method of C; a proxy can only call the methods it names */
export const methodsOf = <C extends Contract>() => <const L extends readonly (keyof C & string)[]>(
  names: L & ([Exclude<keyof C, L[number]>] extends [never] ? unknown : { missing: Exclude<keyof C, L[number]> })): L => names;

export type CallFailure = { javaClass: string | null; name: string; message: string | null; stack?: string };

/** Java exceptions cross as class/message data, never as objects belonging to another VM. */
export function callFailure(error: unknown): CallFailure {
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
export function callError(error: CallFailure): Error {
  const result = new Error(error.message ?? ""); result.name = error.javaClass ?? error.name;
  if (!error.javaClass && typeof error.stack === "string") result.stack = error.stack;
  return result;
}
const closedFailure: CallFailure = { javaClass: "android/os/DeadObjectException", name: "Error", message: "Process endpoint closed" };
/** closes `port` once its peer is told, with `error` as the reason; a port a failed transfer
 *  detached is only closed */
export function closePort(port: MessagePort, error?: CallFailure): void {
  try { port.postMessage({ kind: "close", error } satisfies Message); } catch { /* detached */ }
  port.close();
}

/** each method of a contract by the name a call gives it, a domain's as `domain.method` */
type Named<C> = { [K in keyof C & string]: C[K] extends (...args: never[]) => unknown ? [K, C[K]] : { [M in keyof C[K] & string]: [`${K}.${M}`, C[K][M]] }[keyof C[K] & string] }[keyof C & string];
/** per method, what acts on a call's result */
export type ByResult<C, R> = { [E in Named<C> as E[0]]?: E[1] extends (...args: never[]) => infer V ? (value: Awaited<V>) => R : never };
/** per method, what acts on a call's arguments */
export type ByArgs<C, R> = { [E in Named<C> as E[0]]?: E[1] extends (...args: infer A) => unknown ? (...args: A) => R : never };
const NONE: Transferable[] = [];
/** One process's endpoint, whose object members are domains of methods. Calls are dispatched independently: a Binder
 *  callback may reenter this endpoint while the request that caused it is suspended. `undelivered` releases a result that
 *  never reached its caller; `transfer` names what a result gives away. A proxy may call over the same port (duplex). */
export function serveCalls<C extends object>(port: MessagePort, endpoint: C, onClose: () => void = () => {},
  undelivered: NoInfer<ByResult<C, unknown>> = {}, transfer: NoInfer<ByResult<C, Transferable[]>> = {}): () => void {
  // by the name each is called by, a method's object and its timeline index
  const served = new Map<string, { self: Record<string, unknown>; name: string; at: number }>();
  const serve = (self: Record<string, unknown>, prefix: string) => {
    for (const name of Object.keys(self)) {
      const value = self[name];
      if (!prefix && value !== null && typeof value === "object") serve(value as Record<string, unknown>, name + ".");
      else served.set(prefix + name, { self, name, at: served.size });
    }
  };
  serve(endpoint as Record<string, unknown>, "");
  let closed = false;
  const close = (error?: CallFailure) => {
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
      const method = served.get(data.method);
      if (!method || !Array.isArray(data.args)) throw new Error("Unknown process endpoint method");
      // a notification has no caller waiting on it: only calls are timed
      const call = data.kind === "call";
      if (call) note(Ev.Serve, method.at);
      const value = await (method.self[method.name] as (...args: unknown[]) => unknown).apply(method.self, data.args);
      if (!call) return;
      note(Ev.Served, method.at);
      const release = (undelivered as Record<string, ((value: unknown) => unknown) | undefined>)[data.method];
      const given = (transfer as Record<string, ((value: unknown) => Transferable[]) | undefined>)[data.method];
      if (closed) await release?.(value);
      else try { port.postMessage({ kind: "result", id: data.id, value } satisfies Message, given?.(value) ?? NONE); }
      catch (error) { await release?.(value); throw error; }
    } catch (error) {
      if (data.kind === "notify") close(callFailure(error));
      else if (!closed) port.postMessage({ kind: "error", id: data.id, error: callFailure(error) } satisfies Message);
    }
  });
  port.start();
  return close;
}

export type ProxyOptions<C> = {
  /** the methods sent without a reply */
  notifications?: readonly (keyof C & string)[];
  /** the caller's own VM's exception for a failure */
  makeError?: (error: CallFailure) => unknown;
  onClose?: (error: CallFailure) => void;
  /** what a call's arguments give away */
  transfer?: NoInfer<ByArgs<C, Transferable[]>>;
};
/** The proxy of an endpoint with the methods `names` lists, or with each domain of methods a tree lists. */
export function callProxy<C extends object>(port: MessagePort, names: readonly (keyof C & string)[] | MethodTree,
  { notifications = [], makeError = callError, onClose = () => {}, transfer = {} }: ProxyOptions<C> = {}): { endpoint: C; close(): void } {
  let closed = false, nextId = 1;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; method: number }>();
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
  const given = (method: string, args: unknown[]) =>
    (transfer as Record<string, ((...args: unknown[]) => Transferable[]) | undefined>)[method]?.(...args) ?? NONE;
  const call = (method: string, at: number, args: unknown[]): Promise<unknown> => {
    if (closed) return Promise.reject(makeError(closedFailure));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method: at });
      note(Ev.Call, at);
      try { port.postMessage({ kind: "call", id, method, args } satisfies Message, given(method, args)); }
      catch (error) { pending.delete(id); reject(error); }
    });
  };
  const notify = new Set<string>(notifications);
  const proxy = (method: string, at: number) => !notify.has(method) ? (...args: unknown[]) => call(method, at, args) : (...args: unknown[]) => {
    if (closed) throw makeError(closedFailure);
    port.postMessage({ kind: "notify", id: 0, method, args } satisfies Message, given(method, args));
  };
  // each domain's methods are made once, into one object
  const endpoint: Record<string, unknown> = {}, tree = (Array.isArray(names) ? { "": names } : names) as MethodTree;
  let at = 0;
  for (const domain of Object.keys(tree)) {
    const methods: Record<string, unknown> = domain ? endpoint[domain] = {} : endpoint;
    for (const name of tree[domain]) methods[name] = proxy(domain ? `${domain}.${name}` : name, at++);
  }
  return { close, endpoint: endpoint as C };
}

/** p, or late()'s result once `ms` pass first: a call's answer within a deadline */
export function within<T>(p: Promise<T>, ms: number, late: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }).then(late)]).finally(() => clearTimeout(timer));
}

/** `endpoint` served and `names` called over one port, so that messages keep one order both ways; either
 *  side's close closes both */
export function duplex<S extends Contract, C extends Contract>(port: MessagePort, endpoint: S, names: readonly (keyof C & string)[],
  { onClose = () => {}, ...options }: Omit<ProxyOptions<C>, "makeError" | "onClose"> & { onClose?: () => void } = {}): { endpoint: C; close(): void } {
  let closed = false;
  const close = () => { if (closed) return; closed = true; stop(); proxy.close(); onClose(); };
  const stop = serveCalls(port, endpoint, close), proxy = callProxy<C>(port, names, { ...options, onClose: close });
  return { endpoint: proxy.endpoint, close };
}
