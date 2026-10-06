// Diagnostic by default. An idle run is a candidate until engine traces and every result are reviewed.
import { chromium } from "playwright";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, loadavg } from "node:os";
import { join } from "node:path";
import { Pool, u2, u4 } from "./classfile";
import { shellIn } from "./tools";
import { ROOT, AOSP } from "./paths";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import type { GateConfig } from "./gate-page";
import { sourceKey } from "./aot-key";

const flag=(name:string,fallback:string)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const output=flag("--out",join(ROOT,"tests/e2e/actual/y1-recovery/idle-gates"));mkdirSync(output,{recursive:true});
const work=mkdtempSync(join(tmpdir(),"wasm-gates-")), sh=shellIn(work);
// Two entries into the A/B SCC; each path advances the same finite iteration count.
function irreducible(){
  const p=new Pool(),b:number[]=[],labels=new Map<string,number>(),fix:{at:number;name:string}[]=[];
  const op=(...v:number[])=>b.push(...v),label=(name:string)=>labels.set(name,b.length);
  const jump=(code:number,name:string)=>{fix.push({at:b.length,name});op(code,0,0);};
  const mark=p.member(10,"Gate","mark","(I)V");
  op(3,60,4,61,3,0xb8,...u2(mark),26,4,0x7e);jump(0x99,"A");jump(0xa7,"B");
  label("A");op(28,0x10,7,0x68,0x10,3,0x60,61);jump(0xa7,"tick");
  label("B");op(28,0x10,11,0x82,61);
  label("tick");op(0x84,1,1,27,0x13,...u2(p.int(32767)),0x7e);jump(0x9a,"next");op(27,0xb8,...u2(mark));
  label("next");op(27,26);jump(0xa2,"exit");op(27,4,0x7e);jump(0x99,"A");jump(0xa7,"B");
  label("exit");op(27,0xb8,...u2(mark),28,0xac);
  for(const f of fix){const d=labels.get(f.name)!-f.at;b[f.at+1]=(d>>8)&255;b[f.at+2]=d&255;}
  const body=[...u2(4),...u2(3),...u4(b.length),...b,0,0,0,0];
  const method=[0,9,...u2(p.utf8("run")),...u2(p.utf8("(I)I")),0,1,...u2(p.utf8("Code")),...u4(body.length),...body];
  const cls=p.cls("GateIr"),sup=p.cls("java/lang/Object");
  return Uint8Array.from([0xca,0xfe,0xba,0xbe,0,0,0,50,...u2(p.count),...p.bytes,0,0x21,...u2(cls),...u2(sup),0,0,0,0,0,1,...method,0,0]);
}
writeFileSync(join(work,"GateIr.class"),irreducible());
writeFileSync(join(work,"Gate.java"),`public class Gate {
  public static native void mark(int i);
  static native int scalar(int v); static native int text(String v); static native int array(int[] v); static native int field(Box b);
  public static class Box { public int value=7; }
  static final Object lock=new Object(); static final IllegalArgumentException error=new IllegalArgumentException();
  public static int reducible(int n){int x=1;mark(0);for(int i=1;i<=n;i++){x=x*7+3;if((i&32767)==0)mark(i);}mark(n);return x;}
  public static int irreducible(int n){return GateIr.run(n);}
  public static int exceptionCycle(int n){int i=0,x=1;mark(0);synchronized(lock){while(i<n)try{while(i<n){x=x*7+3;i++;if((i&32767)==0){mark(i);throw error;}}}catch(IllegalArgumentException e){if(e!=error)return -1;}}mark(n);return x;}
  public static int scalarCalls(int n){int x=0;for(int i=0;i<n;i++)x+=scalar(i);return x;}
  public static int textCalls(int n){int x=0;String s="bridge-😀";for(int i=0;i<n;i++)x+=text(s);return x;}
  public static int arrayCalls(int n){int x=0;int[] a=new int[4096];for(int i=0;i<n;i++)x+=array(a);return x;}
  public static int emptyArrayCalls(int n){int x=0;int[] a=new int[0];for(int i=0;i<n;i++)x+=array(a);return x;}
  public static int fieldCalls(int n){int x=0;Box b=new Box();for(int i=0;i<n;i++)x+=field(b);return x;}
}`);
sh(["javac","--release","8","-cp",work,"-d",work,"Gate.java"]);
sh(["d8","--release","--output",work,...readdirSync(work).filter(x=>x.endsWith(".class")).map(x=>join(work,x))]);
const files=[...PLATFORM_JARS.map(x=>join(AOSP,x)),join(work,"classes.dex")];
const harness=createHash("sha256").update(readFileSync(import.meta.path)).update(readFileSync(join(import.meta.dir,"gate-page.ts"))).digest("hex");
const dexSha256=createHash("sha256").update(readFileSync(join(work,"classes.dex"))).digest("hex");
const bundle=await Bun.build({entrypoints:[join(import.meta.dir,"gate-page.ts")],target:"browser",outdir:work,
  plugins:[{name:"preload",setup(b){b.onResolve({filter:/^node:fs$/},()=>({path:join(import.meta.dir,"g1fs.ts")}));}}]});
if(!bundle.success)throw new Error(bundle.logs.join("\n"));
const iso={"cross-origin-opener-policy":"same-origin","cross-origin-embedder-policy":"require-corp"};
const server=Bun.serve({port:0,fetch(req){const u=new URL(req.url);
  if(u.pathname==="/")return new Response(`<script type=module>globalThis.G1_FILES={};await Promise.all(${JSON.stringify(files)}.map(async p=>G1_FILES[p]=new Uint8Array(await(await fetch('/file?p='+encodeURIComponent(p))).arrayBuffer())));await import('/gate.js');globalThis.ready=true;</script>`,{headers:{...iso,"content-type":"text/html"}});
  if(u.pathname==="/gate.js")return new Response(Bun.file(bundle.outputs[0].path),{headers:{...iso,"content-type":"text/javascript"}});
  const path=u.searchParams.get("p");return path&&files.includes(path)?new Response(Bun.file(path),{headers:iso}):new Response("",{status:404});
}});
const methods=flag("--methods","reducible,irreducible,exceptionCycle,scalarCalls,textCalls,emptyArrayCalls,arrayCalls,fieldCalls").split(",");
const results=[];
try{for(const method of methods){
  // A new browser keeps the first activation free of prior native-module tier/cache state.
  const browser=await chromium.launch({channel:"chrome",headless:true,args:process.argv.includes("--trace")?["--js-flags=--trace-wasm-compilation-times"]:[]});
  try{
    const page=await browser.newPage(),errors:string[]=[];page.on("pageerror",e=>errors.push(String(e)));
    await page.goto(`http://localhost:${server.port}`);await page.waitForFunction(()=>!!(globalThis as {ready?:boolean}).ready);
    const cfg:GateConfig={files,method,n:Number(flag("--n",method.endsWith("Calls")?"20000":"8000000")),repeats:Number(flag("--repeats","5")),cold:process.argv.includes("--cold"),trace:process.argv.includes("--trace")};
    if(!Number.isInteger(cfg.n)||cfg.n<1||cfg.n>100000000||!Number.isInteger(cfg.repeats)||cfg.repeats<1)throw new Error("invalid bounded workload");
    const trace=process.argv.includes("--trace")?await browser.newBrowserCDPSession():undefined;
    const events:unknown[]=[];
    const done=trace?new Promise<void>(resolve=>trace.once("Tracing.tracingComplete",()=>resolve())):undefined;
    if(trace){trace.on("Tracing.dataCollected",data=>events.push(...data.value));await trace.send("Tracing.start",{transferMode:"ReportEvents",traceConfig:{includedCategories:["v8","v8.wasm","disabled-by-default-v8.wasm","disabled-by-default-v8.compile","blink.user_timing"]}});}
    const loadBefore=loadavg(),r=await page.evaluate(c=>(globalThis as unknown as {gateRun:(c:GateConfig)=>Promise<unknown>}).gateRun(c),cfg);
    if(trace){await trace.send("Tracing.end");await done;writeFileSync(join(output,method+".trace.json"),JSON.stringify({traceEvents:events}));}
    results.push({method,browser:browser.version(),loadBefore,loadAfter:loadavg(),errors,result:r});
    if(errors.length||(r as {errors:string[];visibility:string}).errors.length||(r as {visibility:string}).visibility!=="visible")process.exitCode=1;
    writeFileSync(join(output,"mechanism.json"),JSON.stringify({source:sourceKey(),harness,dexSha256,head:Bun.spawnSync(["git","rev-parse","HEAD"],{cwd:ROOT}).stdout.toString().trim(),idleCandidate:process.argv.includes("--idle-confirmed"),accepted:false,results},null,2));
  }finally{await browser.close();}
}}finally{server.stop();}
console.log(`Saved ${results.length} diagnostic rows to ${output}; acceptance requires idle, correctness and correlated engine evidence.`);
