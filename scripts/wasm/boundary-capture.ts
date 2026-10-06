// Called by an owned browser harness immediately around its existing ordinary action.
import type { Browser } from "playwright";
export async function startBoundaryProfiles(browser:Browser,readProcessDiagnostics?:()=>Promise<unknown>){
  const processesBefore=await readProcessDiagnostics?.();
  const cdp=await browser.newBrowserCDPSession();
  const relevant=(type:string)=>["page","iframe","worker","shared_worker","service_worker"].includes(type);
  const appeared: {targetId:string;type:string}[]=[];
  cdp.on("Target.targetCreated",e=>{if(relevant(e.targetInfo.type))appeared.push(e.targetInfo);});
  await cdp.send("Target.setDiscoverTargets",{discover:true});
  let id=0;
  const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  cdp.on("Target.receivedMessageFromTarget",e=>{
    const m=JSON.parse(e.message),p=pending.get(m.id);if(!p)return;
    clearTimeout(p.timer);pending.delete(m.id);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result);
  });
  const send=(sessionId:string,method:string,params:unknown={})=>new Promise<any>((resolve,reject)=>{
    const request=++id,timer=setTimeout(()=>{pending.delete(request);reject(new Error(`target command timed out: ${method}`));},5000);
    pending.set(request,{resolve,reject,timer});
    cdp.send("Target.sendMessageToTarget",{sessionId,message:JSON.stringify({id:request,method,params})}).catch(e=>{clearTimeout(timer);pending.delete(request);reject(e);});
  });
  const read=(sessionId:string)=>send(sessionId,"Runtime.evaluate",{expression:"JSON.stringify(globalThis.wd?.perf?{available:true,ticks:globalThis.wd.ticks,perf:globalThis.wd.perf}:{available:false})",returnByValue:true}).then(r=>r.result?.value?JSON.parse(r.result.value):null);
  const infos=(await cdp.send("Target.getTargets")).targetInfos.filter(t=>relevant(t.type));
  const targets: {target:typeof infos[number];sessionId:string;before:unknown;started:number}[]=[],errors:string[]=[];
  for(const target of infos){
    let sessionId:string|undefined;
    try{
      sessionId=(await cdp.send("Target.attachToTarget",{targetId:target.targetId,flatten:false})).sessionId;
      const before=await read(sessionId);
      await send(sessionId,"Profiler.enable");await send(sessionId,"Profiler.setSamplingInterval",{interval:1000});await send(sessionId,"Profiler.start");
      targets.push({target,sessionId,before,started:performance.now()});
    }catch(e){errors.push(`${target.targetId}: ${String(e)}`);if(sessionId)await cdp.send("Target.detachFromTarget",{sessionId}).catch(()=>{});}
  }
  return async()=>{
    const profiles=[];
    try{
      for(const target of targets){
        try{const {profile}=await send(target.sessionId,"Profiler.stop"),stopped=performance.now(),after=await read(target.sessionId);profiles.push({...target,stopped,after,profile});}
        catch(e){errors.push(`${target.target.targetId}: ${String(e)}`);}
        finally{await cdp.send("Target.detachFromTarget",{sessionId:target.sessionId}).catch(()=>{});}
      }
      const after=(await cdp.send("Target.getTargets")).targetInfos.filter(t=>relevant(t.type));
      const uncovered=[...after,...appeared].filter(t=>!targets.some(p=>p.target.targetId===t.targetId));
      const processesAfter=await readProcessDiagnostics?.();
      return {accepted:false,profiles,errors,uncovered,processesBefore,processesAfter,diagnosticsAvailable:!!readProcessDiagnostics,completeCoverage:!errors.length&&!uncovered.length&&profiles.length===infos.length};
    }finally{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error("profile capture closed"));}pending.clear();await cdp.detach();}
  };
}
