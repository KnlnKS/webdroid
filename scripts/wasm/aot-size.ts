// Serialized bytes, not retained heap or CPU. Every byte belongs to exactly one section.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const flag=(k:string)=>{const i=process.argv.indexOf(k);return i<0?undefined:process.argv[i+1];};
const labels=["custom","types","imports","functions","tables","memories","globals","exports","start","elements","code","data","dataCount","tags"];
function measure(dir:string){
  const sizes:Record<string,number>={header:0},files=readdirSync(dir).filter(f=>/^c\d+\.wasm$/.test(f));
  if(!files.length)throw new Error(`no C modules in ${dir}`);
  let total=0;
  for(const file of files){
    const b=readFileSync(join(dir,file));if(b.length<8||b.readUInt32LE(0)!==0x6d736100||b.readUInt32LE(4)!==1)throw new Error(`invalid Wasm header ${file}`);total+=b.length;sizes.header+=8;let at=8;
    const read=()=>{let n=0,s=0,v;do{v=b[at++];n+=(v&127)*2**s;s+=7;}while(v&128);return n;};
    while(at<b.length){const start=at,id=b[at++],length=read(),end=at+length;if(end>b.length)throw new Error(`invalid section ${file}`);
      let label=labels[id]??`section${id}`;
      if(id===0){const n=read();label="custom:"+new TextDecoder().decode(b.subarray(at,at+n));}
      sizes[label]=(sizes[label]??0)+end-start;at=end;
    }
  }
  if(Object.values(sizes).reduce((n,v)=>n+v,0)!==total)throw new Error("size ledger mismatch");
  return {dir,modules:files.length,total,sizes};
}
const guarded=flag("--guarded"),off=flag("--off");if(!guarded||!off)throw new Error("--guarded DIR --off DIR required");
const a=measure(guarded),b=measure(off),delta=Object.fromEntries([...new Set([...Object.keys(a.sizes),...Object.keys(b.sizes)])].map(k=>[k,(a.sizes[k]??0)-(b.sizes[k]??0)]));
const report={timingsAccepted:false,guarded:a,off:b,delta,totalDelta:a.total-b.total};
const output=flag("--out");if(output)writeFileSync(output,JSON.stringify(report,null,2));else console.log(JSON.stringify(report,null,2));
