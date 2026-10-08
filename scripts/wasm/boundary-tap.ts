// One ordinary flow action, with raw self-sample profiles from every owned target.
import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FLOWS } from '../../tests/e2e/flows';
import { executionFlow } from '../../tests/e2e/types';
import { launchFor, loadManifest, runStep } from '../../tests/e2e/capture-webdroid';
import { readProcesses } from '../../tests/e2e/lib/processes';
import { startBoundaryProfiles } from './boundary-capture';
import { AOT_ROOT, sourceKey } from './aot-key';
import { createHash } from 'node:crypto';

const { values } = parseArgs({ options: {
  flow: { type: 'string', default: 'fitnotes' },
  after: { type: 'string', default: '2-save' },
  tap: { type: 'string', default: 'tab-history' },
  out: { type: 'string' },
} });
if (!values.out) throw new Error('--out <isolated directory> required');
const source = FLOWS.find(f => f.app === values.flow);
if (!source) throw new Error('Unknown flow');
const flow = executionFlow(source, 'full');
const last = flow.steps.findIndex(s => s.id === values.after);
const tap = flow.steps.find(s => s.id === values.tap);
if (last < 0 || !tap || tap.action.type !== 'tapText') throw new Error('Expected setup step and ordinary tapText step');
await mkdir(values.out, { recursive: true });
const manifest = await loadManifest(flow.app);
const drv = await launchFor(flow, manifest);
const browser = drv.page.context().browser();
if (!browser) throw new Error("Owned browser unavailable");
const browserErrors: string[] = [];
drv.page.on('pageerror', e => browserErrors.push(e.stack ?? String(e)));
const setup: unknown[] = [];
type Capture = Awaited<ReturnType<Awaited<ReturnType<typeof startBoundaryProfiles>>>>;
let capture: Capture | undefined, result: unknown, failure: string | undefined;
const epoch = { sourceKey: sourceKey(), aot: await Bun.file(join(AOT_ROOT, "current.json")).json(),
  git: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
  harnessSHA256: createHash("sha256").update(await Bun.file(import.meta.path).text()).digest("hex"),
  profilerSHA256: createHash("sha256").update(await Bun.file(join(import.meta.dir,"boundary-capture.ts")).text()).digest("hex"),
  wireMapperSHA256: createHash("sha256").update(await Bun.file(join(import.meta.dir,"wire-map.ts")).text()).digest("hex") };
const saveResult = async (id: string, r: Awaited<ReturnType<typeof runStep>>) => {
  if (r.png) await Bun.write(join(values.out!, `${id}.png`), Buffer.from(r.png, 'base64'));
  const { png: _png, frames: _frames, ...record } = r;
  await Bun.write(join(values.out!, `${id}.json`), JSON.stringify(record, null, 2));
  if (r.error || r.hang || r.wedged || r.semanticHit === false || r.newErrors.length || r.newMissing.length ||
    r.settled.how === "timeout" || r.nativeRequired.length || r.newPlaceholders.length || r.perf.drawErrors || !r.png)
    throw new Error(`${id}: incomplete action or guest failure; inspect step JSON`);
  return record;
};
try {
  for (const step of flow.steps.slice(0, last + 1)) {
    const r = await runStep(drv, flow, step, manifest?.steps.find(s => s.id === step.id));
    setup.push({ id: step.id, ...await saveResult(step.id, r) });
    console.log(`setup ${step.id}`);
  }
  const stop = await startBoundaryProfiles(browser, () => readProcesses(drv.page), {window:true,sources:true});
  try {
    const r = await runStep(drv, flow, tap, manifest?.steps.find(s => s.id === tap.id));
    result = await saveResult(tap.id, r);
  } finally { capture = await stop(); }

} catch (e) { failure = String(e); }
finally {
  for (let i = 0; i < (capture?.profiles.length ?? 0); i++) {
    await Bun.write(join(values.out, `target-${i}.cpuprofile`), JSON.stringify(capture!.profiles[i].profile));
    for (const source of capture!.profiles[i].sources) {
      if (source.bytecode) {
        await Bun.write(join(values.out, `target-${i}-script-${source.scriptId}.wasm`), Buffer.from(source.bytecode, "base64"));
        await Bun.write(join(values.out, `target-${i}-script-${source.scriptId}-wire.json`), JSON.stringify({ sha256: source.sha256, metadata: source.metadata, ...source.wire }, null, 2));
      } else if (source.source !== undefined) await Bun.write(join(values.out, `target-${i}-script-${source.scriptId}.js`), source.source);
    }
  }
  const sourceStable = epoch.sourceKey === sourceKey() && epoch.aot.source === epoch.sourceKey;
  await Bun.write(join(values.out, 'capture.json'), JSON.stringify({ accepted: false,
    sharedLoad: true, sourceStable, ...epoch, chrome: browser.version(),
    clock: 'canonical full-flow date pin; real timers, no testClock override',
    window: 'one canonical full step, including action, settle, liveness, pixels and telemetry; not pure input dispatch',
    flow: flow.app, after: values.after, tap: values.tap, setup, result, capture, browserErrors, failure }, null, 2));
  await drv.close();
  if (!sourceStable) process.exitCode = 1;
}
if (failure || browserErrors.length || !capture?.completeCoverage || !capture.window?.valid) process.exitCode = 1;
