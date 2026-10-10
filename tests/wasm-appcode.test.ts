import { expect, test, spyOn } from 'bun:test';
import { prepareApp } from '../src/wasm/host/appcode';
import type { WorkerPort } from '../src/wasm/host/compiler';
import type { FetchStore } from '../src/wasm/link/aotstore';
import type { World } from '../src/wasm/link/world';
import { Persist, appKey, buildFiles, memoryBackend } from '../src/wasm/host/persist';
import { APP_VERSION, type AppIndex, type Verdict } from '../src/wasm/link/aot';
import type { CompileRequest } from '../src/wasm/host/compile-serve';

class CompilePort implements WorkerPort {
  onmessage: WorkerPort['onmessage'] = null;
  onerror: WorkerPort['onerror'] = null;
  posts = 0;
  messages: CompileRequest[] = [];
  terminated = 0;
  postMessage(message: CompileRequest): void { this.posts++; this.messages.push(message); }
  terminate(): void { this.terminated++; }
}

test('app code death closes its builder, rejects its build and prevents late restart', async () => {
  const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([]));
  const ports: CompilePort[] = [], signal = new AbortController();
  const code = await prepareApp({dexes: [], aot: {base: 'https://appcode-close.invalid/', key: 'platform'} as FetchStore,
    spawn: () => { const port = new CompilePort(); ports.push(port); return port; }, persist: new Persist(memoryBackend()), roots: {launch: []}, signal: signal.signal});
  expect(ports).toHaveLength(1);
  const builderReply = ports[0]!.onmessage!;
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
    expect(ports.map(port => port.terminated)).toEqual([1]);
    await builderReply({data: {type: 'loaded'}} as MessageEvent);
    code.start({} as World);
    expect(await code.refine({} as World)).toBeUndefined();
    expect(ports.map(port => port.posts)).toEqual([0]);
    expect(code.compiler.ready).toBe(false);
  } finally { timeout.mockRestore(); clear.mockRestore(); fetchMock.mockRestore(); code.close(); }
});

test('quiet verdict-only changes persist once and obsolete verdicts are removed', async () => {
  const persist = new Persist(memoryBackend()), key = await appKey([], 'platform');
  const index: AppIndex = {version: APP_VERSION, deopt: 0, base: {names: 0, tail: 0, selectors: 0, gaps: 0, links: 0},
    dexes: [], classes: 0, numbering: {from: {names: 0, tail: 0, selectors: 0, gaps: 0, links: 0}, names: [], tail: [], selectors: [], gaps: [], links: []},
    cOf: [], patches: [], modules: 0, synths: [], dOf: [], dModules: 0, demand: {methods: [], classes: [], infos: []}};
  await persist.save(key, buildFiles({index, files: []}));
  const ports: CompilePort[] = [], timers: (() => void)[] = [];
  const code = await prepareApp({dexes: [], aot: {base: 'https://appcode-verdict.invalid/', key: 'platform'} as FetchStore,
    persist, roots: {launch: []}, spawn: () => { const port = new CompilePort(); ports.push(port); return port; }});
  let verdicts: Verdict[] = [['java/lang/Object.hashCode()I', 'java/lang/Object', 'hashCode()I', true]];
  const world = {demand: {methods: new Set(), classes: [], infos: []}, aot: {verdictList: () => verdicts}, prog: {root: {}}} as unknown as World;
  const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((f: () => void) => {
    timers.push(f); return timers.length;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
  const reply = async (port: CompilePort) => {
    await port.onmessage!({data: {type: 'loaded'}} as MessageEvent);
    const init = port.messages[0]!;
    if (init.type !== 'init') throw new Error('expected builder init');
    await port.onmessage!({data: {type: 'built', build: {index: {...index, demand: init.demand!}, files: []}, methods: 0, ms: 0}} as MessageEvent);
  };
  try {
    code.watch(world);
    timers.shift()!(); timers.shift()!();
    expect(ports).toHaveLength(1);
    await reply(ports[0]!);
    expect(code.builds).toHaveLength(1);
    expect(await code.settle(world)).toBeUndefined();
    verdicts = [];
    const removal = code.settle(world);
    await Promise.resolve();
    expect(ports).toHaveLength(2);
    await reply(ports[1]!);
    expect((await removal)?.kept).toBe(true);
    const files = await persist.load(key);
    expect(JSON.parse(new TextDecoder().decode(files!.get('index.json'))).demand.verdicts).toEqual([]);
    expect(await code.settle(world)).toBeUndefined();
  } finally { code.close(); timeout.mockRestore(); clear.mockRestore(); }
});

test('death reentering builder creation closes its newly returned port', async () => {
  const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([]));
  const signal = new AbortController(), ports: CompilePort[] = [];
  try {
    const code = await prepareApp({dexes: [], aot: {base: 'https://appcode-reentrant.invalid/', key: 'platform'} as FetchStore,
      spawn: () => { const port = new CompilePort(); ports.push(port); if (ports.length === 1) signal.abort(); return port; },
      roots: {launch: []}, signal: signal.signal});
    await expect(code.made!).rejects.toThrow('App code closed');
    expect(ports.map(port => port.terminated)).toEqual([1]);
    code.close();
  } finally { fetchMock.mockRestore(); }
});
