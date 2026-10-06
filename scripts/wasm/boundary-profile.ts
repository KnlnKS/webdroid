// Attribute SELF samples, never the inclusive subtree of a native call, to the boundary.
// --owners is an optional reviewed node-id -> {category,evidence} map for bundled/generated frames.
import { readFileSync, writeFileSync } from "node:fs";
type Category="boundary"|"nativeWork"|"java"|"runtime"|"idle"|"unattributed";
interface Node {id:number;children?:number[];callFrame:{functionName:string;url:string;lineNumber:number;columnNumber:number}}
interface Profile {nodes:Node[];samples:number[];timeDeltas:number[]}
interface Owner {category:Category;evidence:string}
const flag=(key:string)=>{const i=process.argv.indexOf(key);return i<0?undefined:process.argv[i+1];};
const path=flag("--profile");if(!path)throw new Error("--profile <cpuprofile> required");
const profile=JSON.parse(readFileSync(path,"utf8")) as Profile;
const owners:Record<string,Owner>=flag("--owners")?JSON.parse(readFileSync(flag("--owners")!,"utf8")):{};
const categories:Category[]=["boundary","nativeWork","java","runtime","idle","unattributed"];
const classify=(n:Node):Category=>{
  const explicit=owners[n.id];if(explicit){if(!categories.includes(explicit.category)||!explicit.evidence)throw new Error(`unreviewed owner ${n.id}`);return explicit.category;}
  const {url,functionName:name}=n.callFrame;
  if(name==="(idle)")return "idle";
  if(/\/src\/wasm\/host\/(bridge|natives)\.ts$/.test(url))return "boundary";
  if(/\bb:(get:|set:|alen|acopy|aget|aset|js)/.test(name))return "boundary";
  // Wasm includes Java bodies, native stubs, accessors and the ARM core; the URL alone
  // cannot distinguish them. Leave it unresolved until its module/function is mapped.
  if(url.startsWith("wasm://"))return "unattributed";
  if(/\/src\/(android|graphics)\//.test(url)||/\/src\/native\/(core\/|cpu\.ts$)/.test(url))return "nativeWork";
  // World/JNI/Java-ABI files contain both execution and boundary machinery.
  // Do not exclude their unknown leaf frames from the conservative upper bound.
  if(name==="(garbage collector)")return "runtime";
  return "unattributed";
};
const nodes=new Map(profile.nodes.map(n=>[n.id,n])), totals=Object.fromEntries(categories.map(c=>[c,0])) as Record<Category,number>;
const self=new Map<number,number>();
if(profile.samples.length!==profile.timeDeltas.length)throw new Error("sample/time delta mismatch");
for(let i=0;i<profile.samples.length;i++){const id=profile.samples[i],n=nodes.get(id);if(!n)throw new Error(`missing node ${id}`);const dt=profile.timeDeltas[i];if(dt<0)throw new Error("negative sample interval");totals[classify(n)]+=dt;self.set(id,(self.get(id)??0)+dt);}
const active=Object.entries(totals).filter(([k])=>k!=="idle").reduce((n,[,v])=>n+v,0);
const report={profile:path,accepted:false,activeSampleUs:active,selfSampleUs:totals,
  boundaryLowerPercent:active?100*totals.boundary/active:null,
  boundaryUpperPercent:active?100*(totals.boundary+totals.unattributed)/active:null,
  remaining:"Unmapped/generated frames need reviewed ownership. Actual tap completion, every active process and an idle window are separate prerequisites.",
  top:[...self].sort((a,b)=>b[1]-a[1]).slice(0,40).map(([id,us])=>({id,us,category:classify(nodes.get(id)!),frame:nodes.get(id)!.callFrame,evidence:owners[id]?.evidence??null}))};
const output=flag("--out");if(output)writeFileSync(output,JSON.stringify(report,null,2));else console.log(JSON.stringify(report,null,2));
