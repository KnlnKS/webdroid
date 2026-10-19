import { expect, test, vi } from 'vite-plus/test';
import { prepareApp } from '../src/wasm/host/appcode.ts';
import type { WorkerPort } from '../src/wasm/host/compiler.ts';
import type { World } from '../src/wasm/link/world.ts';
import { Persist, memoryBackend } from '../src/wasm/host/persist.ts';
import type { CompileRequest } from '../src/wasm/host/compile-serve.ts';

class CompilePort implements WorkerPort {
  onmessage: WorkerPort['onmessage'] = null;
  onerror: WorkerPort['onerror'] = null;
  posts = 0;
  messages: CompileRequest[] = [];
  terminated = 0;
  postMessage(message: CompileRequest): void { this.posts++; this.messages.push(message); }
  terminate(): void { this.terminated++; }
}

const world = {demand: {methods: new Set(), classes: [], infos: []}, prog: {root: {}}, ahead: {noteRuns() {}}} as unknown as World;
// without the Web Locks API a build's worker is spawned at once
Object.defineProperty(navigator, 'locks', {value: undefined, configurable: true});

test('app code death closes its builder, rejects its build and prevents late restart', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([]));
  const ports: CompilePort[] = [], signal = new AbortController();
  const code = await prepareApp({dexes: [], aot: {base: 'https://appcode-close.invalid/', key: 'platform', bytes: () => undefined},
    spawn: () => { const port = new CompilePort(); ports.push(port); return port; }, persist: new Persist(memoryBackend()), roots: {launch: []}, signal: signal.signal});
  expect(ports).toHaveLength(0);
  const timers: (() => void)[] = [];
  const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((f: () => void) => {
    timers.push(f); return timers.length;
  }) as typeof setTimeout);
  const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
  try {
    code.watch(world);
    code.watch(world);
    expect(ports).toHaveLength(1);
    expect(timers).toHaveLength(1);
    const builderReply = ports[0]!.onmessage!;
    signal.abort(); code.close();
    expect(clear).toHaveBeenCalledTimes(1);
    timers[0]!();
    expect(timers).toHaveLength(1);
    await expect(code.made!).rejects.toThrow('App code closed');
    expect(ports.map(port => port.terminated)).toEqual([1]);
    await builderReply({data: {type: 'loaded'}} as MessageEvent);
    code.start(world);
    expect(await code.refine(world)).toBeUndefined();
    expect(ports.map(port => port.posts)).toEqual([0]);
    expect(code.compiler.ready).toBe(false);
  } finally { timeout.mockRestore(); clear.mockRestore(); fetchMock.mockRestore(); code.close(); }
});

test('death reentering builder creation closes its newly returned port', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([]));
  const signal = new AbortController(), ports: CompilePort[] = [];
  try {
    const code = await prepareApp({dexes: [], aot: {base: 'https://appcode-reentrant.invalid/', key: 'platform', bytes: () => undefined},
      spawn: () => { const port = new CompilePort(); ports.push(port); if (ports.length === 1) signal.abort(); return port; },
      roots: {launch: []}, signal: signal.signal});
    code.watch(world);
    await expect(code.made!).rejects.toThrow('App code closed');
    expect(ports.map(port => port.terminated)).toEqual([1]);
    code.close();
  } finally { fetchMock.mockRestore(); }
});
