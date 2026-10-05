import { expect, test, spyOn } from 'bun:test';
import { prepareApp } from '../src/wasm/host/appcode';
import type { WorkerPort } from '../src/wasm/host/compiler';
import type { FetchStore } from '../src/wasm/link/aotstore';
import type { World } from '../src/wasm/link/world';
import { Persist, memoryBackend } from '../src/wasm/host/persist';

class CompilePort implements WorkerPort {
  onmessage: WorkerPort['onmessage'] = null;
  onerror: WorkerPort['onerror'] = null;
  posts = 0;
  terminated = 0;
  postMessage(): void { this.posts++; }
  terminate(): void { this.terminated++; }
}

test('app code death closes both workers, rejects its build and prevents late restart', async () => {
  const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([]));
  const ports: CompilePort[] = [], signal = new AbortController();
  const code = await prepareApp({dexes: [], aot: {base: 'https://appcode-close.invalid/', key: 'platform'} as FetchStore,
    spawn: () => { const port = new CompilePort(); ports.push(port); return port; }, persist: new Persist(memoryBackend()), roots: {launch: []}, signal: signal.signal});
  const compilerReply = ports[0]!.onmessage!, builderReply = ports[1]!.onmessage!;
  const timers: (() => void)[] = [];
  const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((f: () => void) => {
    timers.push(f); return timers.length;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
  try {
    code.watch({} as World);
    code.watch({} as World);
    expect(timers).toHaveLength(1);
    signal.abort(); code.close();
    expect(clear).toHaveBeenCalledTimes(1);
    timers[0]!();
    expect(timers).toHaveLength(1);
    await expect(code.made!).rejects.toThrow('App code closed');
    expect(ports.map(port => port.terminated)).toEqual([1, 1]);
    await compilerReply({data: {type: 'loaded'}} as MessageEvent);
    await builderReply({data: {type: 'loaded'}} as MessageEvent);
    code.start({} as World);
    expect(await code.refine({} as World)).toBeUndefined();
    expect(ports.map(port => port.posts)).toEqual([0, 0]);
    expect(code.compiler.ready).toBe(false);
  } finally { timeout.mockRestore(); clear.mockRestore(); fetchMock.mockRestore(); code.close(); }
});

test('death reentering builder creation closes its newly returned port', async () => {
  const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([]));
  const signal = new AbortController(), ports: CompilePort[] = [];
  try {
    const code = await prepareApp({dexes: [], aot: {base: 'https://appcode-reentrant.invalid/', key: 'platform'} as FetchStore,
      spawn: () => { const port = new CompilePort(); ports.push(port); if (ports.length === 2) signal.abort(); return port; },
      roots: {launch: []}, signal: signal.signal});
    await expect(code.made!).rejects.toThrow('App code closed');
    expect(ports.map(port => port.terminated)).toEqual([1, 1]);
    code.close();
  } finally { fetchMock.mockRestore(); }
});
