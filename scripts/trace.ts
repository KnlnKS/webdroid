// TRACE=<class-regex> [METH=<regex>] [WAIT=ms] [MAX=lines] bun scripts/trace.ts <apk>
// Logs every entry/exit of the matching methods on the matching classes during boot.
import { WebdroidDriver } from "../tests/e2e/drivers/webdroid";
import { sleep } from "../tests/e2e/lib/util";
import { need } from "./args";
const [apk] = need("TRACE=<class-regex> bun run trace <apk>");
const drv = await WebdroidDriver.launch();
await drv.reset();
await drv.page.evaluate(([clsRe, methRe]) => {
  const rt = (globalThis as any).wd.rt;
  const CR = new RegExp(clsRe), MR = new RegExp(methRe);
  const tr: string[] = ((globalThis as any).__trace = []);
  const orig = rt.ensureCompiled.bind(rt);
  rt.ensureCompiled = (info: any) => {
    const first = !info.compiled;
    orig(info);
    if (!first || !CR.test(info.name)) return;
    const p = info.ctor.prototype;
    for (const k of Object.getOwnPropertyNames(p)) {
      if (!/^m\$/.test(k) || !MR.test(k)) continue;
      const f = p[k]; if (typeof f !== "function") continue;
      p[k] = function (...a: any[]) {
        const tag = info.name + "." + k;
        tr.push("→ " + tag);
        const ok = (v:any)=>{tr.push("← "+tag);return v;};
        const bad = (e:any)=>{tr.push("✗ "+tag+" :: "+(e?.msg??e?.message??e));throw e;};
        try { const r = f.apply(this, a); return r instanceof Promise ? r.then(ok,bad) : ok(r); }
        catch (e) { return bad(e); }
      };
    }
  };
}, [process.env.TRACE ?? "MainActivity$", process.env.METH ?? "."] as const);
await drv.boot(apk);
await sleep(Number(process.env.WAIT ?? 15000));
console.log((await drv.page.evaluate(() => (globalThis as any).__trace)).slice(0, Number(process.env.MAX ?? 400)).join("\n"));
await drv.close();
