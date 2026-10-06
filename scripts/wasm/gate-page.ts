import { world } from "./lib";
import { Natives } from "../../src/wasm/host/natives";
import { crossings } from "../../src/wasm/host/stats";
import { nativeSource } from "../../src/wasm/host/nativesource";
import { mangleField } from "../../src/jvm/abi";
import { prepareMethod } from "../../src/jvm/prepared";
import { Flow, Irreducible } from "../../src/jvm/structure";
import { defaultLoop } from "../../src/wasm/link/sched";

export interface GateConfig { files: string[]; method: string; n: number; repeats: number; cold: boolean; trace:boolean }
interface Point { work: number; ms: number }
const median = (a: number[]) => [...a].sort((a,b)=>a-b)[a.length>>1];
function moduleFunctions(bytes:Uint8Array,mod:WebAssembly.Module){
  const read=(b:Uint8Array,p:{at:number})=>{let n=0,shift=0,v;do{v=b[p.at++];n+=(v&127)*2**shift;shift+=7;}while(v&128);return n;};
  const names=new Map<number,string>();
  for(const section of WebAssembly.Module.customSections(mod,"name")){
    const b=new Uint8Array(section),p={at:0};
    while(p.at<b.length){const kind=b[p.at++],length=read(b,p),end=p.at+length;if(kind===1){const count=read(b,p);for(let i=0;i<count;i++){const index=read(b,p),size=read(b,p);names.set(index,new TextDecoder().decode(b.subarray(p.at,p.at+size)));p.at+=size;}}p.at=end;}
  }
  // Count the wire imports: Module.imports omits the enabled js-string builtins.
  let imported=0;const functions:{index:number;name:string;bodyBytes:number}[]=[],p={at:8};
  const valueType=()=>{const t=bytes[p.at++];if(t===0x63||t===0x64)read(bytes,p);};
  const limits=()=>{const flags=read(bytes,p);read(bytes,p);if(flags&1)read(bytes,p);};
  while(p.at<bytes.length){const kind=bytes[p.at++],length=read(bytes,p),end=p.at+length;
    if(kind===2){const count=read(bytes,p);for(let i=0;i<count;i++){
      for(let j=0;j<2;j++){const size=read(bytes,p);p.at+=size;}
      const k=bytes[p.at++];if(k===0){imported++;read(bytes,p);}else if(k===1){valueType();limits();}else if(k===2)limits();else if(k===3){valueType();p.at++;}else if(k===4){p.at++;read(bytes,p);}else throw new Error(`unknown import kind ${k}`);
    }}
    if(kind===10){const count=read(bytes,p);for(let i=0;i<count;i++){const size=read(bytes,p);functions.push({index:imported+i,name:names.get(imported+i)??"",bodyBytes:size});p.at+=size;}}
    p.at=end;
  }
  return functions;
}
export async function gateRun(cfg: GateConfig) {
  let points: Point[] = [], start = 0, hostCalls = 0, activation = 0, yields=0;
  const source = new Natives({ ...nativeSource, find: (cls,key,s,b) => {
    if(cls!=="Gate")return nativeSource.find(cls,key,s,b);
    if(key==="mark(I)V")return (work:number)=>{const now=performance.now();if(!work){start=now;performance.mark(`gate:${cfg.method}:entry:${activation}`);}if(work===cfg.n)performance.mark(`gate:${cfg.method}:end:${activation}`);points.push({work,ms:now-start});};
    if(key==="scalar(I)I")return (v:number)=>{hostCalls++;return v;};
    if(key==="text(Ljava/lang/String;)I")return (v:string)=>{hostCalls++;return v.length;};
    if(key==="array([I)I")return (v:Int32Array)=>{hostCalls++;return v.length;};
    if(key==="field(LGate$Box;)I")return (v:Record<string,number>)=>{hostCalls++;return v[mangleField("Gate$Box","value")];};
    return undefined;
  }});
  const w=world(cfg.files,{natives:source,cold:cfg.cold,loop:{...defaultLoop,yield:soon=>{yields++;return defaultLoop.yield(soon);}}});
  const modules:{sequence:number;bytes:number;functions:ReturnType<typeof moduleFunctions>}[]=[],compile=w.compile.bind(w);
  if(cfg.trace)w.compile=bytes=>{const sequence=modules.length;performance.mark(`gate:compile:${sequence}:begin`);const mod=compile(bytes);performance.mark(`gate:compile:${sequence}:end`);modules.push({sequence,bytes:bytes.length,functions:moduleFunctions(bytes,mod)});return mod;};
  const errors:string[]=[]; w.onGap=id=>errors.push(w.gapList[id]);
  let irreducible=false;
  if(cfg.method==="irreducible"){
    const m=w.prog.resolve("GateIr","run","(I)I")!,item=m.dex.code(m.codeOff);
    try{new Flow(prepareMethod(m.dex,item,m.desc,true),item,Infinity);}catch(e){if(!(e instanceof Irreducible))throw e;irreducible=true;}
    if(!irreducible)errors.push("DEX graph lost its multiple-entry cycle");
  }
  const prepared=performance.now(), call=w.entryAsync("Gate",cfg.method,"(I)I");
  const preparationMs=performance.now()-prepared;
  const runs:{result:unknown;ms:number;entryAt:number|null;points:Point[];crossings:number;hostCalls:number;yields:number}[]=[];
  for(let i=0;i<=cfg.repeats;i++){
    activation=i;points=[];hostCalls=0;const crossingStart=crossings.n,yieldStart=yields,t=performance.now();
    const result=await call(cfg.n), ms=performance.now()-t;
    runs.push({result,ms,entryAt:points.length?start:null,points:points.slice(),crossings:crossings.n-crossingStart,hostCalls,yields:yields-yieldStart});
  }
  if(runs.some(r=>r.result!==runs[0].result))errors.push("repeat result differs");
  let expected=1;
  if(cfg.method.endsWith("Calls"))expected=(cfg.method==="scalarCalls"?cfg.n*(cfg.n-1)/2:cfg.n*({textCalls:9,arrayCalls:4096,emptyArrayCalls:0,fieldCalls:7}[cfg.method]??0))|0;
  else for(let i=0;i<cfg.n;i++)expected=cfg.method==="irreducible"&&(i===0?cfg.n&1:i&1)?expected^11:(Math.imul(expected,7)+3)|0;
  if(runs.some(r=>r.result!==expected))errors.push(`result differs from independent numeric oracle ${expected}`);
  if(cfg.method.endsWith("Calls")&&runs.some(r=>r.hostCalls!==cfg.n))errors.push("native crossing count differs from loop count");
  // Windows include checkpoint dispatch, scheduler waits and chunk reentry in both samples.
  const windows=(p:Point[])=>{const rows: {end:number;duration:number;rate:number}[]=[];let from=0;
    for(let to=1;to<p.length;to++)if(p[to].ms-p[from].ms>=5){const duration=p[to].ms-p[from].ms;rows.push({end:p[to].ms,duration,rate:(p[to].work-p[from].work)/duration});from=to;}return rows;};
  const later=runs.slice(Math.max(1,runs.length-3)).flatMap(r=>windows(r.points)).map(x=>x.rate);
  const reference=later.length?median(later):null, first=windows(runs[0].points);
  const referenceRatesByRun=runs.slice(-3).map(r=>windows(r.points).map(x=>x.rate)).map(r=>r.length?median(r):null);
  const referenceStable=reference!==null&&referenceRatesByRun.length===3&&referenceRatesByRun.every(r=>r!==null&&Math.abs(r/reference-1)<=0.1);
  const match=reference===null?-1:first.findIndex((_,i)=>i+2<first.length&&first.slice(i,i+3).every(x=>x.rate>=0.9*reference));
  const traces=[...w.traces.values()].filter(t=>t.name.includes("Gate")).map(t=>({name:t.name,offsets:[...t.offsets],pcs:[...t.pcs]}));
  return {cfg,expected,irreducible,traces,modules,timeOrigin:performance.timeOrigin,visibility:document.visibilityState,preparationMs,runs,firstWindows:first,referenceRate:reference,referenceRatesByRun,referenceStable,
    speedReachedMs:match<0?null:first[match+2].end,errors,stats:w.stats,
    tierEvidenceRequired:true,accepted:false};
}
(globalThis as { gateRun?:typeof gateRun }).gateRun=gateRun;
