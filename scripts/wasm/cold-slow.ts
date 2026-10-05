import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { ColdInterpreter } from "../../src/wasm/cold/interpreter";
import { supportsColdBody } from "../../src/wasm/cold/runtime";
import { ColdSlowOps } from "../../src/wasm/cold/slowops";
import { decodeInstructions } from "../../src/jvm/prepared";
import { world } from "./lib";
import { shellIn } from "./tools";
import { AOSP } from "./paths";
import { Natives } from "../../src/wasm/host/natives";
import { nativeSource } from "../../src/wasm/host/nativesource";
import type { Compiler } from "../../src/wasm/compiler/j2w";
import type { MethodInfo } from "../../src/wasm/compiler/program";
import type { HostFn } from "../../src/wasm/link/hostapi";

const out = mkdtempSync(join(tmpdir(), "cold-slow-")), sh = shellIn(out);
writeFileSync(join(out, "ColdSlow.java"), `
public class ColdSlow {
  int value; long wide; Object ref; float f; double d;
  static int counter; static Throwable caught;
  public static int caughtObject(int n){try{return 100/n;}catch(ArithmeticException e){caught=e; return caught==e?38:0;}}
  public static Object lockObject(){return lock;}
  static final Object lock=new ColdSlow(); static int serial;
  public static int serialAwait(int n){synchronized(lock){int old=serial; serial=await(old); return serial;}}
  public static int suspendedRecursive(int n){return n==0?await(0):suspendedRecursive(n-1)+1;}
  interface Get { int get(); }
  static class Base implements Get { public int get(){return 3;} }
  static class Sub extends Base { public int get(){return 7;} }
  static class Init { static int n = ++counter + 40; }
  static class Fail { static int n = fail(); static int fail(){throw new IllegalArgumentException();} }
  static native int await(int n);
  static native int rejected(int n);
  static int plus(int n){return n+5;}
  public static int objects(int n){ColdSlow a=new ColdSlow(); a.value=n; a.wide=0x123456789abcdefL; a.ref=a; a.f=1.25f; a.d=-2.5; return a.value+(a.ref==a?2:0)+(int)(a.wide>>48)+(int)(a.f*4)+(int)(a.d*2);}
  public static int arrays(int n){int[] a=new int[]{n,2,3}; long[] b=new long[]{123456789012L}; Object[] c=new ColdSlow[2]; c[0]=new ColdSlow(); return a.length+a[0]+(int)(b[0]%97)+(c[0] instanceof ColdSlow?7:0);}
  public static int dispatch(int n){Base b=n==0?new Base():new Sub(); Get g=b; return b.get()+g.get()+plus(n);}
  public static int catches(int n){try{int[] a=new int[2]; return a[n]+10/(n-1);}catch(ArrayIndexOutOfBoundsException e){return 31;}catch(ArithmeticException e){return 32;}}
  public static int casts(int n){try{Object a=n==0?new ColdSlow():new Base(); return ((ColdSlow)a).value+7;}catch(ClassCastException e){return 33;}}
  public static int throwing(int n){try{if(n==0)throw null; throw new IllegalArgumentException();}catch(NullPointerException e){return 34;}catch(RuntimeException e){return 35;}finally{counter++;}}
  public static int monitor(int n){Object lock=new ColdSlow(); synchronized(lock){synchronized(lock){try{if(n==0)throw new IllegalArgumentException();return n+3;}finally{counter++;}}}}
  public static int monitorCatch(int n){try{return monitor(n);}catch(IllegalArgumentException e){return 36;}}
  public static int strings(int n){String a=new String(new char[]{'a','b'}); Object b=a; return ((String)b).length()+n;}
  public static int stringBytes(int n)throws Exception{return new String(new byte[]{65,-61,-87},0,3,"UTF-8").length()+n;}
  public static int init(int n){return Init.n+Init.n+counter+n;}
  public static int initFail(int n){int r=0; try{r+=Fail.n;}catch(ExceptionInInitializerError e){r+=1;}try{r+=Fail.n;}catch(NoClassDefFoundError e){r+=2;}return r+n;}
  public static int suspended(int n){return await(n)+plus(n);}
  public static int suspendedCatch(int n){try{return rejected(n);}catch(IllegalArgumentException e){return n+37;}}
  public static IllegalArgumentException problem(){return new IllegalArgumentException();}
  public static void main(String[] args){for(String name:new String[]{"objects","arrays","dispatch","catches","caughtObject","casts","throwing","monitorCatch","strings","stringBytes","init","initFail"})for(int n:new int[]{-1,0,1,2,4})try{System.out.println(ColdSlow.class.getDeclaredMethod(name,int.class).invoke(null,n));}catch(Exception e){System.out.println("throw:"+e.getCause().getClass().getName().replace('.','/'));}}
  static class Vol { volatile int value; }
  public static int repeatedFields(int n){Vol a=new Vol(); int r=0; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; a.value+=n; r+=a.value; return r;}
  public static int payloads(int n){int[] a={11,12,13,14,15}; int[] b={21,22,23,24,25}; return a[n]+b[n];}
  public static int mainTest(int n){return objects(n);}
}
`);
sh(["javac", "--release", "11", "-d", out, join(out, "ColdSlow.java")]);
sh(["d8", "--release", "--min-api", "34", "--output", out, ...readdirSync(out).filter(n => n.endsWith(".class")).map(n => join(out,n))]);
const paths = [join(out,"classes.dex"), ...PLATFORM_JARS.slice(0,2).map(j => join(AOSP,j))];
let gates = 0;
const natives: Record<string, HostFn> = {
  "await(I)I": async (n: number) => { gates++; await Promise.resolve(); return n+1; },
  "rejected(I)I": async () => { await Promise.resolve(); const t=await wc.entryAsync("ColdSlow","problem","()Ljava/lang/IllegalArgumentException;")(); throw wc.exception(t as object); },
};
class MeasuredNatives extends Natives {
  declarationWords = 0; callerDeclarationWords = 0; declarations = 0;
  override declare(cx: Compiler, methods: Iterable<MethodInfo>): void {
    const declared = [...methods]; this.declarations++;
    for (const m of declared) if (m.codeOff) {
      const words = m.dex.code(m.codeOff).insns.length;
      this.declarationWords += words;
      if (m.cls === "ColdSlow") this.callerDeclarationWords += words;
    }
    super.declare(cx, declared);
  }
}
const measuredNatives = new MeasuredNatives({ ...nativeSource, find: (cls,key,s,b) => cls === "ColdSlow" && natives[key] ? natives[key] : nativeSource.find(cls,key,s,b) });
const wc = world(paths, { cold: true, natives: measuredNatives });
const warm = world(paths, { natives: new Natives(nativeSource) });
const jdk=sh(["java","-cp",out,"ColdSlow"]).trim().split("\n");
let jdkAt=0;
let checks = 0;
const expect = (what: string, got: unknown, want: unknown) => { if(got !== want)throw new Error(`${what}: ${got} != ${want}`); checks++; };
const run = async (w: typeof wc, name: string, n: number) => {try{return await w.entryAsync("ColdSlow",name,"(I)I")(n);}catch(e){const t=w.throwable(e); return t ? "throw:"+w.classNameOf(t) : (()=>{throw e;})();}};
for (const name of ["objects","arrays","dispatch","catches","caughtObject","casts","throwing","monitorCatch","strings","stringBytes","init","initFail"]) {
  for(const n of [-1,0,1,2,4]) { const want=await run(warm,name,n); const got=await run(wc,name,n); expect(`JDK ${name}(${n})`,String(got),jdk[jdkAt++]); expect(`${name}(${n})`,got,want); }
  console.log("pass",name);
}
expect("suspended invoke",await run(wc,"suspended",7),20);
expect("suspended Java throw",await run(wc,"suspendedCatch",7),44);
expect("actual native suspension",gates,1);
const serial=await Promise.all(Array.from({length:20},(_,i)=>run(wc,"serialAwait",i)));
expect("contended suspended monitor",serial.join(","),Array.from({length:20},(_,i)=>i+1).join(","));
expect("recursive suspended call",await run(wc,"suspendedRecursive",150),151);
const before={adapters:wc.stats.coldSlowAdapters,modules:wc.stats.coldSlowModules,bytes:wc.stats.bytes};
expect("repeated field side effects",await run(wc,"repeatedFields",2),600);
const work={adapters:wc.stats.coldSlowAdapters-before.adapters,modules:wc.stats.coldSlowModules-before.modules,bytes:wc.stats.bytes-before.bytes};
console.log("repeated-field construction work",JSON.stringify(work));
expect("repeated fields share compiled adapters",work.modules < work.adapters/2,true);
for(const n of [0,2,4]) expect("distinct PC-relative array payloads",await run(wc,"payloads",n),await run(warm,"payloads",n));
const cold = new ColdInterpreter(), method=wc.prog.resolve("ColdSlow","suspended","(I)I")!, item=method.dex.code(method.codeOff);
const frame=cold.prepare(item,true)(); const strand=wc.sched.strand(); cold.context(frame,method,strand);
const call=decodeInstructions(item.insns).find(i=>i.name.startsWith("invoke-static"))!;
cold.enterAt(frame,item,call.pc);
const state=cold.snapshot(frame), slow=new ColdSlowOps(wc);
const input=call.regs[0]; state.bits[input]=7n;
const pending=slow.step(state,strand); await pending;
expect("pending result exists",!!state.result,true);
const copy=cold.restore(item,state), restored=cold.snapshot(copy);
expect("result snapshot retains producer PC",restored.result!.pc,call.pc);
await slow.step(restored,strand);
expect("move-result commits value",restored.result,undefined);
const badProducer={...state,bits:state.bits.slice(),references:[...state.references],kinds:state.kinds.slice(),result:{...state.result!,pc:state.result!.pc+1}};
const destination=decodeInstructions(item.insns).find(i=>i.pc===state.pc)!.a, unchanged=badProducer.bits[destination];
let producerRejected=false;try{await slow.step(badProducer,strand);}catch{producerRejected=true;}
expect("slow execution rejects foreign result producer",producerRejected,true);expect("rejected result leaves destination intact",badProducer.bits[destination],unchanged);
wc.validateColdSnapshot(state,strand);
const otherCall=decodeInstructions(item.insns).find(i=>i.name.startsWith("invoke")&&i.pc!==call.pc)!;
for(const mutate of [(s:typeof state)=>{s.result!.pc=otherCall.pc;s.executedPc=otherCall.pc},(s:typeof state)=>{s.executedPc=state.pc}]) {
  const bad={...state,bits:state.bits.slice(),references:[...state.references],kinds:state.kinds.slice(),result:{...state.result!}};
  mutate(bad); let rejected=false; try{wc.validateColdSnapshot(bad,strand);}catch{rejected=true;}
  expect("shared resume validator rejects foreign committed result",rejected,true);
  expect("shared resume validation leaves destination intact",bad.bits[destination],state.bits[destination]);
}
for(const opcode of [0xfe,0xff]) {
  const unsupported={regs:1,ins:0,tries:[],insns:new Uint16Array([opcode,0,0x000e])};
  const dex=new Proxy(method.dex,{get(target,key){return key==="code"?()=>unsupported:Reflect.get(target,key);}});
  expect("unsupported constant preflight",supportsColdBody({...method,dex}),false);
}
for(const mutate of [(s: typeof state)=>{s.pc++},(s: typeof state)=>{s.kinds[0]=2},(s: typeof state)=>{s.result=undefined},(s: typeof state)=>{s.edges=-1},(s: typeof state)=>{s.result!.pc++}]) {
  const bad={...state,bits:state.bits.slice(),references:[...state.references],kinds:state.kinds.slice(),result:state.result&&{...state.result}};
  mutate(bad); let rejected=false; try{cold.restore(item,bad);}catch{rejected=true;} expect("reject malformed snapshot",rejected,true);
}
cold.inFlight(copy,true);let rejected=false;try{cold.snapshot(copy);}catch{rejected=true;}expect("reject in-flight snapshot",rejected,true);cold.inFlight(copy,false);
// A thrown opcode preserves its destination and transfers the same reference to
// the ordered catch handler; move-exception commits it after snapshot restoration.
const ehMethod=wc.prog.resolve("ColdSlow","caughtObject","(I)I")!, ehItem=ehMethod.dex.code(ehMethod.codeOff), ehFrame=cold.prepare(ehItem,true)();
cold.context(ehFrame,ehMethod,strand);
const division=decodeInstructions(ehItem.insns).find(i=>i.name.startsWith("div-int"))!;
cold.enterAt(ehFrame,ehItem,division.pc);
const eh=cold.snapshot(ehFrame); eh.bits[division.a]=77n;
if(division.name.endsWith("/2addr")){eh.bits[division.a]=100n;eh.bits[division.b]=0n;}else{eh.bits[division.b]=100n;eh.bits[division.c]=0n;}
const beforeThrow=eh.bits[division.a];
await slow.step(eh,strand);
expect("throwing destination unchanged",eh.bits[division.a],beforeThrow);
expect("pending exception exists",!!eh.exception,true);
const thrown=eh.exception!.value, ehRestored=cold.snapshot(cold.restore(ehItem,eh));
slow.validate(ehRestored,strand);
const moveException=decodeInstructions(ehItem.insns).find(i=>i.pc===ehRestored.pc)!;
await slow.step(ehRestored,strand);
expect("move-exception preserves identity",ehRestored.references[moveException.a],thrown);
const monitorMethod=wc.prog.resolve("ColdSlow","serialAwait","(I)I")!, monitorItem=monitorMethod.dex.code(monitorMethod.codeOff), monitorFrame=cold.prepare(monitorItem,true)();
cold.context(monitorFrame,monitorMethod,strand);
const monitorIns=decodeInstructions(monitorItem.insns), enter=monitorIns.find(i=>i.name==="monitor-enter")!, exit=monitorIns.find(i=>i.name==="monitor-exit")!;
cold.enterAt(monitorFrame,monitorItem,enter.pc);
const held=cold.snapshot(monitorFrame), lock=await wc.entryAsync("ColdSlow","lockObject","()Ljava/lang/Object;")();
held.references[enter.a]=lock; held.kinds[enter.a]=1;
await slow.step(held,strand);
expect("monitor state records acquisition",held.monitors[0].count,1);
const resumed=cold.snapshot(cold.restore(monitorItem,held)); slow.validate(resumed,strand);
expect("snapshot retains owned monitor",resumed.monitors[0].object,lock);
const foreign=wc.sched.strand(wc.sched.hostThread());let ownershipRejected=false;try{slow.validate({...resumed,owner:foreign},foreign);}catch{ownershipRejected=true;}expect("reject foreign monitor owner",ownershipRejected,true);wc.sched.end(foreign);
resumed.pc=exit.pc;resumed.references[exit.a]=lock;resumed.kinds[exit.a]=1;await slow.step(resumed,strand);
expect("explicit release consumes monitor state",resumed.monitors.length,0);
expect("canonical monitor actually released",wc.sched.monitors.depth(lock as object,strand),0);
wc.sched.end(strand);
expect("slow adapters do not rescan caller bodies for native imports",measuredNatives.callerDeclarationWords,0);
console.log("cold counters",JSON.stringify({slowAdapters:wc.stats.coldSlowAdapters,slowModules:wc.stats.coldSlowModules,slowCalls:wc.stats.coldSlowCalls,slowWaits:wc.stats.coldSlowWaits,typingMethods:wc.stats.coldTypingMethods,snapshotRegisters:wc.stats.coldSnapshotRegisters,nativeDeclarationWords:measuredNatives.declarationWords,nativeDeclarations:measuredNatives.declarations}));
console.log(`cold slow: ${checks} checks, ${wc.stats.coldMethods} methods / ${wc.stats.coldCalls} activations; object/fields/arrays/dispatch/EH/monitors/class initialization/JSPI and pending-result snapshot validation`);
