import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { UnitCompiler } from "../../src/wasm/link/unit";
import { Natives } from "../../src/wasm/host/natives";
import { loadDexes, world } from "./lib";
import { AOSP } from "./paths";
import { shellIn } from "./tools";

const out = mkdtempSync(join(tmpdir(), "cold-osr-")), sh = shellIn(out);
writeFileSync(join(out, "Osr.java"), `public class Osr {
  public interface I { int f(); }
  public static class Base implements I { public int f(){return 1;} }
  static int effects; static final Object lock=new Object();
  static native I late(I before); static native int await(int value, boolean fail); static native void invalidate();
  public static int effects(){return effects;}
  public static Object lock(){return lock;}
  public static int run(int n){effects++; I r=new Base(); if(n<0)return 0; int x=0; for(int i=0;i<n;i++)x+=i; return late(r).f()+x;}
  public static int nested(int n){effects++; synchronized(lock){int x=0; for(int i=0;i<n;i++)for(int j=0;j<3;j++){x++; if(i==n/2 && j==0)invalidate();} return x;}}
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
console.log(`cold OSR: ${checks} checks; ${w.stats.coldDeopts} deoptimizations; ${w.stats.coldResumes} active transfers / ${w.stats.coldResumeEntries} compiled entries; live interface loading, effects, monitors, native suspension and Java EH`);
