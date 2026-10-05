import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { Natives } from "../../src/wasm/host/natives";
import { loadDexes, world } from "./lib";
import { AOSP } from "./paths";
import { shellIn } from "./tools";

const out = mkdtempSync(join(tmpdir(), "cold-osr-")), sh = shellIn(out);
writeFileSync(join(out, "Osr.java"), `public class Osr {
  public interface I { int f(); }
  public static class Base implements I { public int f(){return 1;} }
  static int effects; static final Object lock=new Object();
  static native I late(I before); static native int await(int value, boolean fail);
  public static int effects(){return effects;}
  public static Object lock(){return lock;}
  public static int run(int n){effects++; I r=new Base(); int x=0; for(int i=0;i<n;i++)x+=i; return late(r).f()+x;}
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
  find:(cls,key)=>cls!=="Osr"?undefined:key==="late(LOsr$I;)LOsr$I;"?late:key==="await(IZ)I"?async(value:number,fail:number)=>{
    waits++; await Promise.resolve();
    if(fail)throw w.exception(w.makeThrowable("java/lang/IllegalArgumentException","OSR native throw"));
    return value+1;
  }:undefined,
  thrown:e=>{const t=w.throwable(e);return t?{cls:w.classNameOf(t),msg:null,obj:t}:undefined;},
})});
const n=50_000, sum=n*(n-1)/2|0;
check("live interface call sees native-loaded override",await w.entryAsync("Osr","run","(I)I")(n),sum+2);
check("late class loaded",loaded,true);
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
console.log(`cold OSR: ${checks} checks; ${w.stats.coldResumes} active transfers / ${w.stats.coldResumeEntries} compiled entries; live interface loading, effects, monitors, native suspension and Java EH`);
