// Read-only startup diagnosis. A single debugger pause obtains a WeakRef to the
// existing World; neither app bytecode nor the served source/AOT is replaced.
import { parseArgs } from "node:util";
const { values } = parseArgs({ options: { url: { type: "string" }, out: { type: "string" }, app: { type: "string" } } });
if (!values.url || !values.out || !values.app) throw new Error("Required: --url --out --app");
const url = new URL(values.url); url.searchParams.set("tier", "wasm"); url.searchParams.set("cold", "1");
process.env.WEBDROID_URL = url.href;
const [{ WebdroidDriver }, { FLOWS }, { actOf, loadManifest }, { executionFlow, screenOf }] = await Promise.all([
  import("../../tests/e2e/drivers/webdroid"), import("../../tests/e2e/flows"), import("../../tests/e2e/capture-webdroid"), import("../../tests/e2e/types"),
]);
const source = FLOWS.find(f => f.app === values.app);
if (!source) throw new Error("Unknown app");
const flow = executionFlow(source, "full"), manifest = await loadManifest(flow.app), screen = screenOf(manifest, flow.screen);
const result = { diagnosticOnly: true, source: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
  aot: await (await fetch(new URL("/aot/current.json", url))).json(), debuggerCaptured: false,
  samples: [] as unknown[], errors: [] as string[], console: [] as string[] };
const drv = await WebdroidDriver.launch({ screen, controlled: false });
const cdp = await drv.page.context().newCDPSession(drv.page);
const scripts: { scriptId: string; url: string }[] = [];
cdp.on("Debugger.scriptParsed", script => { if (script.url.startsWith(url.origin)) scripts.push(script); });
await cdp.send("Debugger.enable");
let breakpoint: string | undefined;
for (const script of scripts) {
  const { scriptSource } = await cdp.send("Debugger.getScriptSource", { scriptId: script.scriptId });
  const lines = scriptSource.split("\n"), line = lines.findIndex(l => l.includes("this.sched = new Sched(this, this.rt,"));
  if (line < 0) continue;
  breakpoint = (await cdp.send("Debugger.setBreakpoint", { location: { scriptId: script.scriptId, lineNumber: line + 1 } })).breakpointId;
  break;
}
if (!breakpoint) { await drv.close(); throw new Error("World constructor not loaded; no diagnostic capture installed"); }
cdp.on("Debugger.paused", async event => {
  try {
    await cdp.send("Debugger.evaluateOnCallFrame", { callFrameId: event.callFrames[0].callFrameId,
      expression: "globalThis.__wdColdDebug = new WeakRef(this)" });
    result.debuggerCaptured = true;
    await cdp.send("Debugger.removeBreakpoint", { breakpointId: breakpoint! });
  } finally { await cdp.send("Debugger.resume"); await cdp.send("Debugger.disable"); }
});
drv.page.on("console", m => result.console.push(m.text()));
const save = () => Bun.write(values.out!, JSON.stringify(result, null, 2));
const deadline = setTimeout(() => {
  result.errors.push("outside-browser deadline 100s");
  void save().finally(() => drv.close()).finally(() => process.exit(124));
}, 100000);
try {
  let done = false;
  const first = flow.steps[0], rec = manifest?.steps.find(s => s.id === first.id);
  const boot = drv.page.evaluate(([act, geometry]) => globalThis.__wd.act(act, geometry, 60000), [actOf(flow, first, rec), screen] as const)
    .then(() => { done = true; }, e => { result.errors.push(String(e)); });
  for (let i = 0; i < 45; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    result.samples.push(await drv.page.evaluate(() => {
      const w = (globalThis as any).__wdColdDebug?.deref();
      return { ms: performance.now(), ticks: globalThis.wd?.ticks, cold: window.__wdCold, perf: globalThis.wd?.perf,
        strands: w?.sched.strands.filter(Boolean).map((s: any) => ({ id: s.id, root: s.root, nested: s.nested,
          waitsOn: s.waitsOn?.id, blocked: s.thread.blocked, waiting: s.thread.waiting,
          frames: (w.cold?.active.get(s) ?? []).slice(-8).map((f: object) => {
            const state = w.cold.frames.get(f), m = state.context.method;
            return { method: m && `${m.cls}.${m.name}${m.desc}`, pc: w.cold.pc(f), busy: state.busy,
              monitors: state.context.monitors.length, pendingResult: state.context.result?.pc, pendingException: state.context.exception?.pc };
          }) })) };
    }));
    await save();
    if (done) { await boot; break; }
  }
} finally { clearTimeout(deadline); await save(); await drv.close(); }
