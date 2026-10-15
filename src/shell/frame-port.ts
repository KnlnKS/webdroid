// A process Worker presents straight into its page canvas, transferred as an OffscreenCanvas, so the
// page thread and its GPU work are not in the frame path. The page hears of each frame shown, with a
// copy while it mirrors frames for an observer that reads their pixels: the whole frame, or only
// downscaled crops of the regions it watches, which costs the Worker a small blit instead of a copy.
import { note, Ev } from "../timeline";
import { shownFrameAt } from "../android/vsync";
/** screen regions [left,top,right,bottom], each sent scaled to fit `max` px on its long side */
export type MirrorCrops = {regions:[number,number,number,number][];max:number};
export type Mirror = boolean | MirrorCrops;
type DisplayMessage = {kind:"shown";at:number;frame?:number;copy:ImageBitmap|null;crops?:ImageBitmap[];still?:boolean} | {kind:"mirror";on:Mirror} | {kind:"taken"} | {kind:"close"};
/** mirrored frames the page has yet to take: a page thread held up (a readback waiting on a GPU
 *  backlog) would otherwise queue a full-screen copy for every frame presented meanwhile */
const MIRRORED_IN_FLIGHT=3;
export type FrameSender = {present(bitmap:ImageBitmap):void;close():void};

/** whoever reads presented frames (lat, the e2e probe): `copy` is a frame's pixels, or `crops` the
 *  mirrored regions' (each the observer's to close), `at` when it was presented, and `frame` when the display frame that shows it
 *  began, both on the page's clock. `still` marks the crops of what was already shown when region mirroring began, not a new frame. */
export type DisplayObserver = (canvas:HTMLCanvasElement,copy:ImageBitmap|null,at:number,crops?:ImageBitmap[],still?:boolean,frame?:number)=>void;
declare global { var __wdPresented: DisplayObserver | undefined; }

export function sendFrames(port:MessagePort,screen:OffscreenCanvas):FrameSender {
  const context=screen.getContext("bitmaprenderer");
  if(!context)throw new Error("Bitmap presentation context unavailable");
  let closed=false,mirror:Mirror=false,inFlight=0;
  /** the latest frame presented while MIRRORED_IN_FLIGHT were untaken, mirrored once one is */
  let held:{at:number;frame:number}|null=null;
  const finish=()=>{if(!closed){closed=true;port.close();}};
  port.onmessageerror=finish;
  const send=(copies:Promise<ImageBitmap[]>,message:(copies:ImageBitmap[])=>DisplayMessage)=>{
    inFlight++;
    void copies.then(c=>{
      if(closed)c.forEach(b=>b.close());else port.postMessage(message(c),c);
    },()=>{inFlight--;});
  };
  const sendCrops=(spec:MirrorCrops,at:number,still:boolean,frame?:number)=>send(Promise.all(spec.regions.map(([l,t,r,b])=>{
    const scale=Math.min(1,spec.max/Math.max(r-l,b-t));
    return createImageBitmap(screen,l,t,r-l,b-t,{resizeWidth:Math.max(1,Math.round((r-l)*scale)),resizeHeight:Math.max(1,Math.round((b-t)*scale))});
  })),crops=>({kind:"shown",at,frame,copy:null,crops,still}));
  const mirrorFrame=(at:number,frame:number)=>{
    if(mirror===true)send(createImageBitmap(screen).then(copy=>[copy]),([copy])=>({kind:"shown",at,frame,copy}));
    else if(mirror)sendCrops(mirror,at,false,frame);
  };
  port.onmessage=({data}:MessageEvent<DisplayMessage>)=>{
    if(data.kind==="close"){finish();return;}
    if(data.kind==="taken"){
      inFlight--;
      if(held&&mirror){const {at,frame}=held;held=null;mirrorFrame(at,frame);}
      return;
    }
    if(data.kind!=="mirror")return;
    mirror=data.on;held=null;
    if(typeof mirror==="object"&&screen.width>1)sendCrops(mirror,performance.timeOrigin+performance.now(),true);
  };
  return {
    present(bitmap){
      if(closed){bitmap.close();return;}
      if(screen.width!==bitmap.width)screen.width=bitmap.width;
      if(screen.height!==bitmap.height)screen.height=bitmap.height;
      context.transferFromImageBitmap(bitmap);
      note(Ev.Present);
      const now=performance.now(),at=performance.timeOrigin+now,frame=performance.timeOrigin+shownFrameAt(now);
      if(!mirror)port.postMessage({kind:"shown",at,frame,copy:null} satisfies DisplayMessage);
      else if(inFlight>=MIRRORED_IN_FLIGHT)held={at,frame};
      else mirrorFrame(at,frame);
    },
    close(){if(!closed)try{port.postMessage({kind:"close"} satisfies DisplayMessage);}finally{finish();}},
  };
}

export type FrameReceiver = {mirror(on:Mirror):void;close():void};
export function receiveFrames(port:MessagePort,canvas:HTMLCanvasElement,shown:()=>void):FrameReceiver {
  let closed=false;
  const close=()=>{if(closed)return;closed=true;try{port.postMessage({kind:"close"} satisfies DisplayMessage);}finally{port.close();}};
  port.onmessageerror=close;
  port.onmessage=({data}:MessageEvent<DisplayMessage>)=>{
    if(data.kind==="close"){close();return;}
    if(data.kind!=="shown")return;
    if(closed){data.copy?.close();data.crops?.forEach(c=>c.close());return;}
    if(data.copy||data.crops)port.postMessage({kind:"taken"} satisfies DisplayMessage);
    if(!data.still)shown();
    const observe=globalThis.__wdPresented;
    if(observe)observe(canvas,data.copy,data.at-performance.timeOrigin,data.crops,data.still,data.frame===undefined?undefined:data.frame-performance.timeOrigin);else{data.copy?.close();data.crops?.forEach(c=>c.close());}
  };
  return {mirror:on=>{if(!closed)port.postMessage({kind:"mirror",on} satisfies DisplayMessage);},close};
}
