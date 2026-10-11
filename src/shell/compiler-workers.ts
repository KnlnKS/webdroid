import { compilerReceipt, compilerReceiptsEnabled } from "../jvm/compiler-observer";

type Owner = { instance: string; role: string; url: string; owner: string; bornAt: number };
type CompilerOwner = { owner: Owner; worker: Worker; latest: unknown; receivedAt: number | null; retiredAt: number | null; error: string | null; requests: { sequence: number; type: string; id: number | null; at: number }[]; pending: Map<string, (value: unknown) => void> };
const records: CompilerOwner[] = [];
const clock = performance, clockUrl = typeof location === "undefined" ? "" : location.href;
const now = () => clock.timeOrigin + clock.now();
let dropped = 0;
const MESSAGE = "webdroid:compiler-receipt", SNAPSHOT = "webdroid:compiler-snapshot";
export function compilerWorkerReceipts() {
  if (!compilerReceiptsEnabled) return null;
  return { schema: 1, source: import.meta.url, clockUrl, at: now(), dropped,
    rows: records.map(r => ({ owner: { ...r.owner }, latest: structuredClone(r.latest), receivedAt: r.receivedAt, retiredAt: r.retiredAt, error: r.error, requests: r.requests.map(request => ({ ...request })) })) };
}
export async function compilerWorkerBarrier() {
  if (!compilerReceiptsEnabled) return null;
  await Promise.all(records.filter(r => r.retiredAt === null).map(r => new Promise<void>(resolve => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { r.pending.delete(id); r.error = "compiler snapshot barrier timed out"; resolve(); }, 4000);
    r.pending.set(id, () => { clearTimeout(timer); resolve(); });
    try { r.worker.postMessage({ type: SNAPSHOT, id }); } catch (e) { clearTimeout(timer); r.pending.delete(id); r.error = String(e).slice(0, 2048); resolve(); }
  })));
  return compilerWorkerReceipts();
}
export function spawnCompilerWorker(url: string | URL, role: string): Worker {
  if (!compilerReceiptsEnabled) return new Worker(url, { type: "module" });
  const owner = location.href, target = new URL(url, owner), instance = crypto.randomUUID();
  target.searchParams.set("compileProbe", "1"); target.searchParams.set("compilerInstance", instance);
  target.searchParams.set("compilerRole", role); target.searchParams.set("owner", owner);
  const bornAt = now(), worker = new Worker(target, { type: "module" });
  if (records.length === 128) { dropped++; return worker; }
  const record: CompilerOwner = { owner: { instance, role, url: target.href, owner, bornAt }, worker,
    latest: null, receivedAt: null, retiredAt: null, error: null, requests: [], pending: new Map() };
  records.push(record);
  const post = worker.postMessage.bind(worker) as (message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => void;
  worker.postMessage = ((message: any, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
    if (message?.type !== SNAPSHOT) {
      if (record.requests.length === 4096) { record.error = "compiler request journal overflow"; dropped++; }
      else record.requests.push({ sequence: record.requests.length + 1, type: message?.type ?? "compileAhead", id: message?.id ?? null, at: now() });
    }
    post(message, transferOrOptions);
  }) as Worker["postMessage"];
  worker.addEventListener("message", e => {
    if (e.data?.type !== MESSAGE) return;
    e.stopImmediatePropagation();
    if (e.data.instance !== instance || e.data.role !== role || e.data.url !== target.href || e.data.owner !== owner) {
      record.error = "compiler receipt ownership mismatch"; return;
    }
    record.latest = e.data; record.receivedAt = now();
    if (e.data.terminal && role === "js-ahead") worker.terminate();
    if (e.data.id) { record.pending.get(e.data.id)?.(e.data); record.pending.delete(e.data.id); }
  });
  worker.addEventListener("error", e => { record.error = String(e.message ?? "compiler worker failed to load").slice(0, 2048); });
  const terminate = worker.terminate.bind(worker);
  worker.terminate = () => {
    record.retiredAt ??= now();
    if (!(record.latest as any)?.terminal) record.error ??= "compiler terminated without terminal receipt";
    for (const resolve of record.pending.values()) resolve(null);
    record.pending.clear(); terminate();
  };
  return worker;
}
const jobs: { sequence: number; type: string; id: number | null; at: number; ordinal: number; state: "begin" | "end" | "failed" | "inputs"; inputs?: unknown }[] = [];
let jobSequence = 0, jobDropped = 0, jobOrdinal = 0;
export function compilerJob(type: string, id: number | undefined, state: "begin" | "end" | "failed" | "inputs", inputs?: unknown, ordinal = 0): number {
  if (!compilerReceiptsEnabled) return 0;
  if (state === "begin") ordinal = ++jobOrdinal;
  const sequence = ++jobSequence;
  if (jobs.length === 4096) { jobDropped++; return ordinal; }
  jobs.push({ sequence, ordinal, type, id: id ?? null, at: performance.timeOrigin + performance.now(), state, ...inputs === undefined ? {} : { inputs } });
  return ordinal;
}
export function invalidateCompilerReceipt(): void { if (compilerReceiptsEnabled) jobDropped++; }
export async function compilerInput(dexes: [string, Uint8Array][]) {
  if (!compilerReceiptsEnabled) return undefined;
  if (dexes.length > 128 || dexes.some(([name]) => name.length > 2048)) { jobDropped++; return null; }
  try {
    return await Promise.all(dexes.map(async ([name, bytes]) => ({ name, bytes: bytes.length,
      sha256: new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)).toHex() })));
  } catch { invalidateCompilerReceipt(); return null; }
}
export function postCompilerReceipt(id?: string, terminal = false): void {
  if (!compilerReceiptsEnabled || typeof window !== "undefined") return;
  const params = new URLSearchParams(location.search), send = globalThis as unknown as { postMessage(data: unknown): void };
  send.postMessage({ type: MESSAGE, instance: params.get("compilerInstance"), role: params.get("compilerRole"), owner: params.get("owner"), url: location.href,
    at: performance.timeOrigin + performance.now(), id, terminal, compiler: compilerReceipt(), jobs: jobs.map(j => ({ ...j })), sequence: jobSequence, dropped: jobDropped });
}
export function installCompilerWorkerProbe(): void {
  if (!compilerReceiptsEnabled || typeof window !== "undefined") return;
  addEventListener("message", event => {
    const e = event as MessageEvent;
    if (e.data?.type === SNAPSHOT) { e.stopImmediatePropagation(); postCompilerReceipt(e.data.id); }
  });
}

if (compilerReceiptsEnabled && typeof window !== "undefined") {
  Object.defineProperties(window, { __wdCompilerReceipts: { value: () => ({ main: compilerReceipt(), workers: compilerWorkerReceipts() }) },
    __wdCompilerBarrier: { value: compilerWorkerBarrier } });
}
