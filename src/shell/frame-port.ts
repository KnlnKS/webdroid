// A process Worker presents straight into its page canvas, transferred as an OffscreenCanvas, so the
// page thread and its GPU work are not in the frame path. The page hears of the first frame shown, and
// of each one while an observer reads them (lat, the e2e probe), with a copy while it mirrors frames for
// one that reads their pixels: the whole frame, or only downscaled crops of the regions it watches,
// which costs the Worker a small blit instead of a copy.
import { note, Ev } from "../timeline.ts";
import { shownFrameAt } from "../android/vsync.ts";
import { duplex, methodsOf } from "./rpc.ts";
/** screen regions [left,top,right,bottom], each sent scaled to fit `max` px on its long side */
type MirrorCrops = {regions:[number,number,number,number][];max:number};
export type Mirror = boolean | MirrorCrops;
/** a frame shown: when it was presented and when the display frame that shows it began, on the page's clock, with a copy of its
 *  pixels or the mirrored regions' crops, transferred with it and closed by whoever drops them. `still` marks the crops of what
 *  was already shown when region mirroring began, not a new frame. */
type FrameView = {shown(at:number,frame:number|undefined,copy:ImageBitmap|null,crops?:ImageBitmap[],still?:boolean):void};
/** an observer reads every frame, mirrored as `on` says; `taken` answers a mirrored frame */
type FrameControl = {mirror(on:Mirror):void;taken():void};
type Shown=Parameters<FrameView["shown"]>;
const viewMethods=methodsOf<FrameView>()(["shown"]),controlMethods=methodsOf<FrameControl>()(["mirror","taken"]);
const bitmaps=(copy:ImageBitmap|null,crops?:ImageBitmap[])=>copy?[copy]:crops??[];
/** mirrored frames the page has yet to take: a page thread held up (a readback waiting on a GPU
 *  backlog) would otherwise queue a full-screen copy for every frame presented meanwhile */
const MIRRORED_IN_FLIGHT=3;
type FrameSender = {present(bitmap:ImageBitmap):void;close():void};

/** whoever reads presented frames (lat, the e2e probe): `copy` is a frame's pixels, or `crops` the
 *  mirrored regions' (each the observer's to close), `at` when it was presented, and `frame` when the display frame that shows it
 *  began, both on the page's clock. `still` marks the crops of what was already shown when region mirroring began, not a new frame. */
type DisplayObserver = (canvas:HTMLCanvasElement,copy:ImageBitmap|null,at:number,crops?:ImageBitmap[],still?:boolean,frame?:number)=>void;
declare global { var __wdPresented: DisplayObserver | undefined; }

export function sendFrames(port:MessagePort,screen:OffscreenCanvas):FrameSender {
  const context=screen.getContext("bitmaprenderer");
  if(!context)throw new Error("Bitmap presentation context unavailable");
  /** `observed` once an observer asks for frames: until then the page hears of the first only */
  let closed=false,observed=false,presented=false,mirror:Mirror=false,inFlight=0;
  /** the latest frame presented while MIRRORED_IN_FLIGHT were untaken, mirrored once one is */
  let held:{at:number;frame:number}|null=null;
  const page=duplex<FrameControl,FrameView>(port,{
    mirror(on){
      observed=true;mirror=on;held=null;
      if(typeof on==="object"&&screen.width>1)sendCrops(on,performance.timeOrigin+performance.now(),true);
    },
    taken(){
      inFlight--;
      if(held){const {at,frame}=held;held=null;mirrorFrame(at,frame);}
    },
  },viewMethods,{notifications:viewMethods,transfer:{shown:(_at,_frame,copy,crops)=>bitmaps(copy,crops)},onClose:()=>{closed=true;}});
  const send=(shown:Promise<Shown>)=>{
    inFlight++;
    void shown.then(args=>{if(closed)for(const b of bitmaps(args[2],args[3]))b.close();else page.endpoint.shown(...args);},()=>{inFlight--;});
  };
  const sendCrops=(spec:MirrorCrops,at:number,still:boolean,frame?:number)=>send(Promise.all(spec.regions.map(([l,t,r,b])=>{
    const scale=Math.min(1,spec.max/Math.max(r-l,b-t));
    return createImageBitmap(screen,l,t,r-l,b-t,{resizeWidth:Math.max(1,Math.round((r-l)*scale)),resizeHeight:Math.max(1,Math.round((b-t)*scale))});
  })).then((crops):Shown=>[at,frame,null,crops,still]));
  const mirrorFrame=(at:number,frame:number)=>{
    if(mirror===true)send(createImageBitmap(screen).then((copy):Shown=>[at,frame,copy]));
    else if(mirror)sendCrops(mirror,at,false,frame);
  };
  return {
    present(bitmap){
      if(closed){bitmap.close();return;}
      if(screen.width!==bitmap.width)screen.width=bitmap.width;
      if(screen.height!==bitmap.height)screen.height=bitmap.height;
      context.transferFromImageBitmap(bitmap);
      note(Ev.Present);
      if(presented&&!observed)return;
      presented=true;
      const now=performance.now(),at=performance.timeOrigin+now,frame=performance.timeOrigin+shownFrameAt(now);
      if(!mirror)page.endpoint.shown(at,frame,null);
      else if(inFlight>=MIRRORED_IN_FLIGHT)held={at,frame};
      else mirrorFrame(at,frame);
    },
    close:page.close,
  };
}

export type FrameReceiver = {mirror(on:Mirror):void;close():void};
/** `canvas`'s frames from its Worker: `shown` hears of each, and an observer installed before the display began reads every one */
export function receiveFrames(port:MessagePort,canvas:HTMLCanvasElement,mirroring:Mirror,shown:()=>void):FrameReceiver {
  let closed=false;
  const worker=duplex<FrameView,FrameControl>(port,{shown(at,frame,copy,crops,still){
    if(copy||crops)worker.endpoint.taken();
    if(!still)shown();
    const observe=globalThis.__wdPresented;
    if(observe)observe(canvas,copy,at-performance.timeOrigin,crops,still,frame===undefined?undefined:frame-performance.timeOrigin);
    else for(const b of bitmaps(copy,crops))b.close();
  }},controlMethods,{notifications:controlMethods,onClose:()=>{closed=true;}});
  const mirror=(on:Mirror)=>{if(!closed)worker.endpoint.mirror(on);};
  if(mirroring||globalThis.__wdPresented)mirror(mirroring);
  return {mirror,close:worker.close};
}
