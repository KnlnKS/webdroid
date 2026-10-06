// Called by an owned browser harness immediately around its existing ordinary action.
import type { Browser } from "playwright";
export async function startBoundaryProfiles(browser:Browser,readProcessDiagnostics?:()=>Promise<unknown>, options: {window?:boolean;sources?:boolean}={}){
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
  const traceEvents: {name:string;ts:number;args?:{sync_id?:string}}[]=[];
  let traceDone: Promise<void>|undefined,traceStarted=false;
  if(options.window){
    cdp.on("Tracing.dataCollected",e=>traceEvents.push(...e.value as unknown as typeof traceEvents));
    traceDone=new Promise(resolve=>cdp.once("Tracing.tracingComplete",()=>resolve()));
    try{await cdp.send("Tracing.start",{traceConfig:{includedCategories:["__metadata"]},transferMode:"ReportEvents"});
      traceStarted=true;await cdp.send("Tracing.recordClockSyncMarker",{syncId:"boundary:start"});
    }catch(e){errors.push(`profile clock start: ${String(e)}`);}
  }
  return async()=>{
    const profiles=[],sourceErrors:string[]=[];
    try{
      if(traceStarted)await cdp.send("Tracing.recordClockSyncMarker",{syncId:"boundary:end"}).catch(e=>errors.push(`profile clock end: ${String(e)}`));
      // Stop every profile before collecting sources: cache-build Workers can retire meanwhile.
      const stoppedProfiles=await Promise.allSettled(targets.map(async target=>({
        ...(await send(target.sessionId,"Profiler.stop")),stopped:performance.now()
      })));
      for(let i=0;i<targets.length;i++){
        const target=targets[i];
        try{const stoppedProfile=stoppedProfiles[i];if(stoppedProfile.status==="rejected")throw stoppedProfile.reason;
          const {profile,stopped}=stoppedProfile.value,after=await read(target.sessionId).catch(e=>({failure:String(e)}));
          const sources: {scriptId:string;source:string}[]=[];
          if(options.sources){
            try{await send(target.sessionId,"Debugger.enable");
            const ids=new Set<string>(profile.nodes.filter((n:any)=>/^[1-9][0-9]*$/.test(n.callFrame.scriptId)&&!n.callFrame.url.startsWith("wasm://")).map((n:any)=>n.callFrame.scriptId));
            for(const scriptId of ids){
              try{const s=await send(target.sessionId,"Debugger.getScriptSource",{scriptId});sources.push({scriptId,source:s.scriptSource});}
              catch(e){sourceErrors.push(`${target.target.targetId} source ${scriptId}: ${String(e)}`);}
            }
            await send(target.sessionId,"Debugger.disable");
            }catch(e){sourceErrors.push(`${target.target.targetId} source collection: ${String(e)}`);}
          }
          profiles.push({...target,stopped,after,profile,sources});}
        catch(e){errors.push(`${target.target.targetId}: ${String(e)}`);}
        finally{await cdp.send("Target.detachFromTarget",{sessionId:target.sessionId}).catch(()=>{});}
      }
      const after=(await cdp.send("Target.getTargets")).targetInfos.filter(t=>relevant(t.type));
      const uncovered=[...after,...appeared].filter(t=>!targets.some(p=>p.target.targetId===t.targetId));
      if(traceStarted){await cdp.send("Tracing.end");await traceDone;}
      const start=traceEvents.find(e=>e.name==="clock_sync"&&e.args?.sync_id==="boundary:start")?.ts;
      const end=traceEvents.find(e=>e.name==="clock_sync"&&e.args?.sync_id==="boundary:end")?.ts;
      const window=options.window?{startUs:start,endUs:end,valid:start!==undefined&&end!==undefined&&end>start}:undefined;
      if(options.window&&!window?.valid)errors.push("common profile clock markers missing or unordered");
      const processesAfter=await readProcessDiagnostics?.();
      return {accepted:false,window,traceEvents,profiles,errors,sourceErrors,uncovered,processesBefore,processesAfter,diagnosticsAvailable:!!readProcessDiagnostics,completeCoverage:!errors.length&&!uncovered.length&&profiles.length===infos.length};
    }finally{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error("profile capture closed"));}pending.clear();await cdp.detach();}
  };
}
