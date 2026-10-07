import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { UnitCompiler } from "../../src/wasm/link/unit";
import { heapUsed } from "../../src/wasm/host/stats";
import { nativeSource } from "../../src/wasm/host/nativesource";
import { Natives } from "../../src/wasm/host/natives";
import { loadDexes, world } from "./lib";
import { DEOPT_ABI, type AotIndex } from "../../src/wasm/link/aot";
import { ROOT, AOSP } from "./paths";
import { shellIn } from "./tools";

const out = mkdtempSync(join(tmpdir(), "cold-osr-")), sh = shellIn(out);
writeFileSync(join(out, "Osr.java"), `public class Osr {
  public interface I { int f(); }
  public static class Base implements I { public int f(){return 1;} }
  static int effects; static Class<?> resolved; static final Object lock=new Object();
  static native I late(I before); static native int await(int value, boolean fail); static native void invalidate();
  public static int effects(){return effects;}
  public static Object lock(){return lock;}
  public static int run(int n){effects++; resolved=I.class; I r=new Base(); if(n<0)return 0; int x=0; for(int i=0;i<n;i++)x+=i; return late(r).f()+x;}
  public static int nested(int n){effects++; synchronized(lock){int x=0; for(int i=0;i<n;i++)for(int j=0;j<3;j++){x++; if(i==n/2 && j==0)invalidate();} return x;}}
  public static long raw(long j,float f,double d,Object r){effects++; invalidate(); return j ^ Float.floatToRawIntBits(f) ^ Double.doubleToRawLongBits(d) ^ (r==null?0:9);}
  public static int wide(${Array.from({length:65},(_,i)=>`int a${i}`).join(',')}){effects++;invalidate();if(a0<0)return 0;return ${Array.from({length:65},(_,i)=>`a${i}`).join('+')};}
  static char[] stringChars(){invalidate();return new char[]{'a','b'};}
  public static int stringAliases(){String s=new String(stringChars());return s.length();}
  public static int edge(boolean b){effects++;invalidate();if(b)return effects+3;return effects+5;}
  public static int captureFail(){synchronized(lock){effects++;try{invalidate();if(effects()<0)return 3;return 7;}catch(IllegalStateException e){return 11;}}}
  public static int state(int n,boolean fail){synchronized(lock){effects++; int x=0; for(int i=0;i<n;i++)x+=i; try{return await(x,fail)+7;}catch(IllegalArgumentException e){return x+9;}}}
}`);
writeFileSync(join(out, "Late.java"), `public class Late extends Osr.Base {public int f(){return 2;} public static Osr.I make(){return new Late();}}`);
sh(["javac", "--release", "8", "-d", out, "Osr.java", "Late.java"]);
sh(["d8", "--release", "--output", out, ...readdirSync(out).filter(n=>/^Osr.*\.class$/.test(n)).map(n=>join(out,n))]);
sh(["mkdir", "-p", "late"]);
sh(["d8", "--release", "--output", join(out,"late"), "--classpath", out, join(out,"Late.class")]);
let checks=0, loaded=false, waits=0;
const check=(name:string,got:unknown,want:unknown)=>{if(got!==want)throw new Error(`${name}: ${got} != ${want}`);checks++;};
const late=Object.assign(async()=>{
  check("transfer precedes native class loading",w.stats.coldResumes,1);
  const invalidated=w.stats.invalidated;
  w.addDexes(loadDexes(join(out,"late/classes.dex"))); loaded=true;
  check("interface assumption invalidates its slot",w.stats.invalidated>invalidated,true);
  return await w.entryAsync("Late","make","()LOsr$I;")();
},{javaValues:true});
const w=world([join(out,"classes.dex"),...PLATFORM_JARS.slice(0,2).map(j=>join(AOSP,j))],{cold:true,holdUpgrades:()=>true,natives:new Natives({
  find:(cls,key)=>cls!=="Osr"?undefined:key==="late(LOsr$I;)LOsr$I;"?late:key==="invalidate()V"?()=>{w.invalidate(w.slotOf(w.prog.resolve("Osr","nested","(I)I")!));}:key==="await(IZ)I"?async(value:number,fail:number)=>{
    waits++; await Promise.resolve();
    if(fail)throw w.exception(w.makeThrowable("java/lang/IllegalArgumentException","OSR native throw"));
    return value+1;
  }:undefined,
  thrown:e=>{const t=w.throwable(e);return t?{cls:w.classNameOf(t),msg:null,obj:t}:undefined;},
})});
const enterCold=w.enterColdDeopt.bind(w);
let duplicateRejects=0;
w.enterColdDeopt=(state,cold)=>{
  const frame=enterCold(state,cold), calls=w.stats.coldCalls;
  try{enterCold(state,cold);}catch{duplicateRejects++;}
  check("duplicate deopt cannot execute or allocate another activation",w.stats.coldCalls,calls);
  return frame;
};
const n=50_000, sum=n*(n-1)/2|0;
check("live interface call sees native-loaded override",await w.entryAsync("Osr","run","(I)I")(n),sum+2);
check("late class loaded",loaded,true);
check("running continuation deoptimizes on slot invalidation",w.stats.coldDeopts,1);
check("prefix effects execute once",w.entry("Osr","effects","()I")(),1);
check("active transfer with future upgrades held",w.stats.upgrades,0);
const bytes=w.stats.bytes, before=w.stats.coldResumes;
check("monitor/native continuation",await w.entryAsync("Osr","state","(IZ)I")(n,0),sum+8);
check("one monitored activation transferred",w.stats.coldResumes,before+1);
check("resume bytes accounted",w.stats.bytes>bytes,true);
check("monitor/Java EH continuation",await w.entryAsync("Osr","state","(IZ)I")(n,1),sum+9);
check("prefix effects never replay",w.entry("Osr","effects","()I")(),3);
check("native suspensions executed once",waits,2);
const lock=w.entry("Osr","lock","()Ljava/lang/Object;")() as object;
check("monitor released after normal and exceptional exits",w.sched.monitors.tryEnter(lock,w.sched.root),0);
w.sched.monitors.exit(lock,w.sched.root);
const priorDeopts=w.stats.coldDeopts;
check("nested chunk handoff result",await w.entryAsync("Osr","nested","(I)I")(20_000),60_000);
check("nested chunk handoff occurs once",w.stats.coldDeopts,priorDeopts+1);
check("nested prefix never replay",w.entry("Osr","effects","()I")(),4);
const depth=w.rtImports().depth, nested=w.prog.resolve("Osr","nested","(I)I")!;
depth.value=123;
check("raw nested chunk handoff result",(w.table.get(w.slotOf(nested)) as (n:number)=>number)(20_000),60_000);
check("raw nested handoff preserves caller depth",depth.value,123);
depth.value=0;
check("all handoffs reject duplicate entry",duplicateRejects,w.stats.coldDeopts);
check("nested handoff releases monitor",w.sched.monitors.tryEnter(lock,w.sched.root),0);
w.sched.monitors.exit(lock,w.sched.root);
// A real compile-worker job installs an ordinary Java-ABI hot root, not a resume entry.
{
  const files=[join(out,"classes.dex"),...PLATFORM_JARS.slice(0,2).map(j=>join(AOSP,j))];
  const page=world(files,{cold:true,holdUpgrades:()=>true,natives:new Natives({
    find:(cls,key)=>cls!=="Osr"?undefined:key==="invalidate()V"?()=>page.invalidate(page.slotOf(page.prog.resolve("Osr","nested","(I)I")!)):key==="late(LOsr$I;)LOsr$I;"?Object.assign(async()=>{
      const before=page.stats.invalidated;
      page.addDexes(loadDexes(join(out,"late/classes.dex")));
      check("ordinary hot interface slot invalidated",page.stats.invalidated>before,true);
      return await page.entryAsync("Late","make","()LOsr$I;")();
    },{javaValues:true}):undefined,
    thrown:e=>{const t=page.throwable(e);return t?{cls:page.classNameOf(t),msg:null,obj:t}:undefined;},
  })});
  check("cold worker seed",page.entry("Osr","nested","(I)I")(0),0);
  check("cold interface seed",page.entry("Osr","run","(I)I")(-1),0);
  const worker=world(files,{compileOnly:true}), uc=new UnitCompiler(worker);
  check("worker follows executing World",uc.sync(page.since(page.base),true),true);
  const m=page.prog.resolve("Osr","nested","(I)I")!,slot=page.slotOf(m),job=page.upgradeJob(slot)!;
  check("worker job carries activation contract",job.cold,true);
  const from=worker.numbering(), unit=uc.upgrade(job);
  if(typeof unit==="string")throw new Error(unit);
  check("stale unit policy rejected before installation",page.adoptUnit(slot,job,{...unit,header:{...unit.header,deopt:0}},page.epoch),false);
  check("worker hot root installed",page.adoptUnit(slot,job,unit,page.epoch),true);
  const depth=page.rtImports().depth; depth.value=123;
  check("ordinary hot root deopts through nested chunks",(page.table.get(slot) as (n:number)=>number)(20_000),60_000);
  check("ordinary hot root preserves caller depth",depth.value,123);depth.value=0;
  check("ordinary hot root transfers exactly once",page.stats.coldDeopts,1);
  check("ordinary hot prefix never replay",page.entry("Osr","effects","()I")(),3);
  check("worker follows after adoption",uc.sync(page.since(from),false),true);
  const run=page.prog.resolve("Osr","run","(I)I")!,runSlot=page.slotOf(run),runJob=page.upgradeJob(runSlot)!;
  check("worker follows job numbering",uc.sync(page.since(worker.numbering()),true),true);
  const runUnit=uc.upgrade(runJob);
  if(typeof runUnit==="string")throw new Error(runUnit);
  check("worker interface root installed",page.adoptUnit(runSlot,runJob,runUnit,page.epoch),true);
  check("ordinary hot native-loaded interface override",await page.entryAsync("Osr","run","(I)I")(100),4952);
  check("ordinary hot interface deopts once",page.stats.coldDeopts,2);
  check("ordinary hot native prefix never replay",page.entry("Osr","effects","()I")(),4);
}
// Use the shipping producer and loader, with a small unchanged DEX as its selected archive.
if(process.argv.includes("--aot")) {
  const dir=join(out,"aot");
  sh(["bun",join(ROOT,"scripts/wasm/run.ts"),"aot-build","--out",dir,"--jars","0","--app",join(out,"classes.dex")]);
  const index=JSON.parse(readFileSync(join(dir,"index.json"),"utf8")) as AotIndex;
  check("shipping producer emits guarded contract",index.deopt,DEOPT_ABI);
  const store={get:(file:string)=>new Uint8Array(readFileSync(join(dir,file)))};
  const files=[...PLATFORM_JARS.map(j=>join(AOSP,j)),join(out,"classes.dex")];
  check("cold runtime rejects previous capture ABI",!!world(files,{cold:true,aot:{get:(file:string)=>file==="index.json"?new TextEncoder().encode(JSON.stringify({...index,deopt:DEOPT_ABI-1})):store.get(file)}}).aot,false);
  for(const cold of [false,true]) for(const fail of [0,1]) {
    let nativeCalls=0, rootTransfers=0, stateTransfers=0, makes=0, guards=0, heapReads=0, beforeWideHeap=0, wideBudgetChecked=false;
    const page=world(files,{cold,heapUsed:()=>{heapReads++;return heapUsed();},holdUpgrades:()=>true,aot:store,natives:new Natives({
      ...nativeSource,
      find:(cls,key,isStatic,hasBody)=>cls!=="Osr"?nativeSource.find(cls,key,isStatic,hasBody):key==="invalidate()V"?()=>page.invalidate(page.slotOf(page.prog.resolve("Osr","nested","(I)I")!)):key==="await(IZ)I"?async(value:number,fail:number)=>{
        page.invalidate(page.slotOf(page.prog.resolve("Osr","state","(IZ)I")!));
        await Promise.resolve();if(fail)throw page.exception(page.makeThrowable("java/lang/IllegalArgumentException","AOT native throw"));return value+1;
      }:key==="late(LOsr$I;)LOsr$I;"?Object.assign(async()=>{
        nativeCalls++;page.addDexes(loadDexes(join(out,"late/classes.dex")));
        return await page.entryAsync("Late","make","()LOsr$I;")();
      },{javaValues:true}):undefined,
      thrown:e=>{const t=page.throwable(e);return t?{cls:page.classNameOf(t),msg:null,obj:t}:undefined;},
    })});
    check(`AOT attaches with cold=${cold}`,!!page.aot,true);
    const make=page.deoptImports.make, blocked=page.deoptImports.blocked;
    page.deoptImports.make=(slot,depth)=>{makes++;if(!cold)throw new Error("disabled AOT called activation import");return make(slot,depth);};
    page.deoptImports.blocked=state=>{guards++;if(!cold)throw new Error("disabled AOT ran a guard");return blocked(state);};
    const beginCapture=page.deoptImports.beginCapture;
    page.deoptImports.beginCapture=(state,pc)=>{
      beginCapture(state,pc);
      // Leave less than the snapshot payload in the real allocation window.
      if(state.method?.name==="wide"){page.rtImports().alloc.value=-1000;beforeWideHeap=heapReads;}
    };
    const capture=page.deoptImports.captureIndexed;
    let captureFaults=0, capturePc=-1, captureFrames: ReturnType<typeof page.stackTrace>=[];
    page.deoptImports.captureIndexed=(...args)=>{
      if(args[0].method?.name==="wide")wideBudgetChecked=heapReads>beforeWideHeap;
      if(args[0].method?.name==="captureFail" && !captureFaults++){
        const limit=Error.stackTraceLimit;Error.stackTraceLimit=128;
        let t:object;
        try{t=page.makeThrowable("java/lang/IllegalStateException","capture fault");}finally{Error.stackTraceLimit=limit;}
        capturePc=args[1];captureFrames=page.stackTrace(page.fieldReader<object>("java/lang/Throwable","backtrace","Ljava/lang/Object;")(t));throw page.exception(t);
      }
      return capture(...args);
    };
    const enter=page.enterColdDeopt.bind(page);
    page.enterColdDeopt=(s,c)=>{if(!cold)throw new Error("disabled runtime attempted cold handoff");if(s.method?.cls==="Osr"){if(s.method.name==="run")rootTransfers++;if(s.method.name==="state")stateTransfers++;if(s.method.name==="edge"){const op=s.item.insns[s.executedPc]&255;check("AOT branch commits before either outgoing edge",op>=0x32&&op<=0x3d,true);}}return enter(s,c);};
    check(`AOT native/EH result and monitor cold=${cold} fail=${fail}`,await page.entryAsync("Osr","state","(IZ)I")(100,fail),4958+fail);
    check(`AOT committed result/EH handoff cold=${cold} fail=${fail}`,stateTransfers,+cold);
    const lock=page.entry("Osr","lock","()Ljava/lang/Object;")() as object;
    check(`AOT monitor release cold=${cold}`,page.sched.monitors.tryEnter(lock,page.sched.root),0);page.sched.monitors.exit(lock,page.sched.root);
    check(`AOT live interface override cold=${cold}`,await page.entryAsync("Osr","run","(I)I")(100),4952);
    check(`actual AOT code runs cold=${cold}`,page.stats.aot.c>0,true);
    check(`AOT native executes once cold=${cold}`,nativeCalls,1);
    check(`AOT prefix executes once cold=${cold}`,page.entry("Osr","effects","()I")(),2);
    check(`AOT root handoff policy cold=${cold}`,rootTransfers,+cold);
    if(!cold)check("disabled AOT allocates no interpreted activations",page.stats.coldCalls,0);
    check(`AOT activation imports follow cold=${cold}`,makes>0,cold);
    const beforeStrings=page.stats.coldDeopts;
    check(`AOT uninitialized String defers handoff cold=${cold}`,await page.entryAsync("Osr","stringAliases","()I")(),2);
    check(`AOT committed String can hand off cold=${cold}`,page.stats.coldDeopts>beforeStrings,cold);
    check(`AOT epoch checks follow cold=${cold}`,guards>0,cold);
    for(const branch of [false,true]){const prefix=Number(page.entry("Osr","effects","()I")());check(`AOT branch handoff cold=${cold} taken=${branch}`,await page.entryAsync("Osr","edge","(Z)I")(branch),prefix+1+(branch?3:5));}
    const prior=page.stats.coldDeopts, prefix=Number(page.entry("Osr","effects","()I")());
    const j=fail?-0x123456789abcdefn:0x123456789abcdefn, f=fail?0x7fc12345:-2147483648, d=fail?0x7ff8123456789abcn:-9223372036854775808n;
    check(`AOT long/FP/reference bits cold=${cold}`,await page.entryAsync("Osr","raw","(JFDLjava/lang/Object;)J")(j,f,d,fail?null:lock),BigInt.asIntN(64,j ^ BigInt(f) ^ d ^ (fail?0n:9n)));
    check(`AOT wide carrier cold=${cold}`,await page.entryAsync("Osr","wide","("+"I".repeat(65)+")I")(...Array.from({length:65},(_,i)=>i)),2080);
    check(`AOT snapshot payload consults real heap cold=${cold}`,wideBudgetChecked,cold);
    check(`AOT vector transfers cold=${cold}`,page.stats.coldDeopts-prior,2*+cold);
    check(`AOT vector effects execute once cold=${cold}`,page.entry("Osr","effects","()I")(),prefix+2);
    const effects=Number(page.entry("Osr","effects","()I")());
    const capResult=await page.entryAsync("Osr","captureFail","()I")();
    check(`shared capture Java handler cold=${cold}`,capResult,cold?11:7);
    check(`shared capture fault reached cold=${cold}`,captureFaults>0,cold);
    if(cold){
      const frames=captureFrames.filter(f=>f.cls==="Osr"&&f.method==="captureFail");
      check("shared capture keeps one Java activation",frames.length,1);
      check("shared capture retains exact protected PC",frames[0]?.pc,capturePc);
    }
    check(`shared capture handler prefix once cold=${cold}`,page.entry("Osr","effects","()I")(),effects+1);
    check(`shared capture handler releases monitor cold=${cold}`,page.sched.monitors.tryEnter(lock,page.sched.root),0);page.sched.monitors.exit(lock,page.sched.root);
    console.log("AOT activation work",JSON.stringify({cold,fail,makes,guards,methods:page.stats.methods,bytes:page.stats.bytes,compileMs:page.stats.compileMs,aotC:page.stats.aot.c,deopts:page.stats.coldDeopts}));
  }
  const stale={get:(file:string)=>file==="index.json"?new TextEncoder().encode(JSON.stringify({...index,deopt:0})):store.get(file)};
  check("cold runtime rejects uninstrumented AOT",!!world(files,{cold:true,aot:stale}).aot,false);
  const off=join(out,"aot-off");
  sh(["bun",join(ROOT,"scripts/wasm/run.ts"),"aot-build","--out",off,"--jars","0","--app",join(out,"classes.dex"),"--deopt","off"]);
  const offStore={get:(file:string)=>new Uint8Array(readFileSync(join(off,file)))};
  check("off producer records absent contract",(JSON.parse(readFileSync(join(off,"index.json"),"utf8")) as AotIndex).deopt,0);
  check("disabled runtime accepts actual off assets",!!world(files,{cold:false,aot:offStore}).aot,true);
  check("cold runtime rejects actual off assets",!!world(files,{cold:true,aot:offStore}).aot,false);
}
console.log(`cold OSR: ${checks} checks; ${w.stats.coldDeopts} deoptimizations; ${w.stats.coldResumes} active transfers / ${w.stats.coldResumeEntries} compiled entries; live interface loading, effects, monitors, native suspension and Java EH`);
