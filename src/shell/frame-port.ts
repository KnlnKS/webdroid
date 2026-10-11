// A process Worker presents straight into its page canvas, transferred as an OffscreenCanvas, so the
// page thread and its GPU work are not in the frame path. The page hears of each frame shown, with a
// copy while it mirrors frames for an observer that reads their pixels.
type DisplayMessage = {kind:"shown";at:number;copy:ImageBitmap|null} | {kind:"mirror";on:boolean} | {kind:"close"};
export type FrameSender = {present(bitmap:ImageBitmap):void;close():void};

/** whoever reads presented frames (lat, the e2e probe): `copy` is a frame's pixels, its to close,
 *  and `at` when it was presented, on the page's clock */
export type DisplayObserver = (canvas:HTMLCanvasElement,copy:ImageBitmap|null,at:number)=>void;
declare global { var __wdPresented: DisplayObserver | undefined; }

export function sendFrames(port:MessagePort,screen:OffscreenCanvas):FrameSender {
  const context=screen.getContext("bitmaprenderer");
  if(!context)throw new Error("Bitmap presentation context unavailable");
  let closed=false,mirror=false;
  const finish=()=>{if(!closed){closed=true;port.close();}};
  port.onmessageerror=finish;
  port.onmessage=({data}:MessageEvent<DisplayMessage>)=>{if(data.kind==="mirror")mirror=data.on;else if(data.kind==="close")finish();};
  return {
    present(bitmap){
      if(closed){bitmap.close();return;}
      if(screen.width!==bitmap.width)screen.width=bitmap.width;
      if(screen.height!==bitmap.height)screen.height=bitmap.height;
      context.transferFromImageBitmap(bitmap);
      const at=performance.timeOrigin+performance.now();
      if(!mirror){port.postMessage({kind:"shown",at,copy:null} satisfies DisplayMessage);return;}
      void createImageBitmap(screen).then(copy=>{
        if(closed)copy.close();else port.postMessage({kind:"shown",at,copy} satisfies DisplayMessage,[copy]);
      });
    },
    close(){if(!closed)try{port.postMessage({kind:"close"} satisfies DisplayMessage);}finally{finish();}},
  };
}

export type FrameReceiver = {mirror(on:boolean):void;close():void};
export function receiveFrames(port:MessagePort,canvas:HTMLCanvasElement,shown:()=>void):FrameReceiver {
  let closed=false;
  const close=()=>{if(closed)return;closed=true;try{port.postMessage({kind:"close"} satisfies DisplayMessage);}finally{port.close();}};
  port.onmessageerror=close;
  port.onmessage=({data}:MessageEvent<DisplayMessage>)=>{
    if(data.kind==="close"){close();return;}
    if(data.kind!=="shown")return;
    if(closed){data.copy?.close();return;}
    shown();
    const observe=globalThis.__wdPresented;
    if(observe)observe(canvas,data.copy,data.at-performance.timeOrigin);else data.copy?.close();
  };
  return {mirror:on=>{if(!closed)port.postMessage({kind:"mirror",on} satisfies DisplayMessage);},close};
}
