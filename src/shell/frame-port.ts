/** Complete frame snapshots cross this port; a pending frame never aliases the renderer. */
type FrameMessage = {kind:"frame";id:number;bitmap:ImageBitmap} | {kind:"ack";id:number;error?:string} | {kind:"close"};
type PendingFrame = {id:number;bitmap:ImageBitmap;resolve(shown:boolean):void;reject(error:Error):void};
export type FrameSender = {present(bitmap:ImageBitmap):Promise<boolean>;close():void};

/** One transferred frame and one newest pending frame bound both memory and stale presentation. */
export function sendFrames(port:MessagePort):FrameSender {
  let closed=false,nextId=1,inflight:Omit<PendingFrame,"bitmap">|undefined,pending:PendingFrame|undefined;
  const error = () => new Error("Process display closed");
  const finish = () => {
    if(closed)return;
    closed=true;
    inflight?.reject(error());inflight=undefined;
    if(pending){pending.bitmap.close();pending.reject(error());pending=undefined;}
    port.close();
  };
  const send = (frame:PendingFrame) => {
    const {bitmap:_,...request}=frame;inflight=request;
    try{port.postMessage({kind:"frame",id:frame.id,bitmap:frame.bitmap} satisfies FrameMessage,[frame.bitmap]);}
    catch(error){inflight=undefined;frame.bitmap.close();frame.reject(error instanceof Error?error:new Error(String(error)));}
  };
  port.onmessageerror=finish;
  port.onmessage=({data}:MessageEvent<FrameMessage>)=>{
    if(data.kind==="close"){finish();return;}
    if(data.kind!=="ack"||data.id!==inflight?.id)return;
    const sent=inflight;inflight=undefined;
    if(data.error)sent.reject(new Error(data.error));else sent.resolve(true);
    if(pending){const next=pending;pending=undefined;send(next);}
  };
  return {
    present(bitmap){
      if(closed){bitmap.close();return Promise.reject(error());}
      return new Promise((resolve,reject)=>{
        const frame={id:nextId++,bitmap,resolve,reject};
        if(!inflight){send(frame);return;}
        if(pending){pending.bitmap.close();pending.resolve(false);}
        pending=frame;
      });
    },
    close(){if(!closed)try{port.postMessage({kind:"close"} satisfies FrameMessage);}finally{finish();}},
  };
}

/** The page owns the receiving bitmap until the synchronous sink consumes it or fails. */
export function receiveFrames(port:MessagePort,present:(bitmap:ImageBitmap)=>void):()=>void {
  let closed=false;
  const close=()=>{if(closed)return;closed=true;try{port.postMessage({kind:"close"} satisfies FrameMessage);}finally{port.close();}};
  port.onmessageerror=close;
  port.onmessage=({data}:MessageEvent<FrameMessage>)=>{
    if(data.kind==="close"){close();return;}
    if(data.kind!=="frame")return;
    if(closed){data.bitmap.close();return;}
    let error:string|undefined;
    try{present(data.bitmap);}catch(cause){error=cause instanceof Error?cause.message:String(cause);}
    finally{data.bitmap.close();}
    port.postMessage({kind:"ack",id:data.id,error} satisfies FrameMessage);
  };
  return close;
}

export function canvasFrameSink(canvas:HTMLCanvasElement):(bitmap:ImageBitmap)=>void {
  const context=canvas.getContext("bitmaprenderer");
  if(!context)throw new Error("Bitmap presentation context unavailable");
  return bitmap=>{
    if(canvas.width!==bitmap.width)canvas.width=bitmap.width;
    if(canvas.height!==bitmap.height)canvas.height=bitmap.height;
    context.transferFromImageBitmap(bitmap);
  };
}
