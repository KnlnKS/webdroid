import { readFileSync } from "node:fs";
const flag=(n:string)=>{const i=process.argv.indexOf(n);if(i<0)throw new Error(`${n} required`);return process.argv[i+1];};
interface Module {sequence:number;functions:{index:number;name:string;bodyBytes:number}[]}
interface Row {method:string;result:{timeOrigin:number;runs:{entryAt:number|null;points:{ms:number}[]}[];modules:Module[]}}
const rows=(JSON.parse(readFileSync(flag("--mechanism"),"utf8")) as {results:Row[]}).results;
const groups=new Map<string,{index:number;body:number;tier:string;receiptUTC:number}[]>();
for(const line of readFileSync(flag("--log"),"utf8").split("\n")){
  const m=line.match(/^(\S+).*\[pid=(\d+)\].*Compiled function (0x[\da-f]+)#(\d+) using (\w+).*bodysize (\d+)/);
  if(!m)continue;const key=m[2]+":"+m[3];if(!groups.has(key))groups.set(key,[]);
  groups.get(key)!.push({index:+m[4],body:+m[6],tier:m[5],receiptUTC:Date.parse(m[1])});
}
const report=[...groups].map(([engineModule,events])=>{
  const matches=rows.flatMap(r=>r.result.modules.filter(m=>events.every(e=>m.functions.some(f=>f.index===e.index&&f.bodyBytes===e.body))).map(m=>({r,m})));
  if(matches.length!==1)return {engineModule,unresolvedCandidates:matches.length};
  const {r,m}=matches[0],first=r.result.runs[0],entry=first.entryAt===null?null:r.result.timeOrigin+first.entryAt;
  return {engineModule,method:r.method,moduleSequence:m.sequence,optimized:events.filter(e=>e.tier==="TurboFan").map(e=>({
    ...e,name:m.functions.find(f=>f.index===e.index)!.name,
    receiptAfterFirstEntryMs:entry===null?null:e.receiptUTC-entry,
    // Receipt is an upper bound, not the optimizer's completion timestamp; trace events retain that timestamp.
    receivedDuringFirstActivation:entry!==null&&e.receiptUTC>=entry&&e.receiptUTC<=entry+(first.points.at(-1)?.ms??0),
  }))};
});
console.log(JSON.stringify({accepted:false,modules:report,remaining:"Require matching raw browser trace, an idle untraced speed run and stable optimized reference. Ambiguous signatures cannot establish a tier transition."},null,2));
