import type { ParcelData } from "../android/binder.ts";
import type { FileDescriptors, RetainedDescriptor } from "./file-descriptors.ts";

export class StoredParcelError extends Error {}

/** Broker-local descriptor ownership; no retained right is exposed as a wire token. */
export class StoredParcel {
  private kernel: FileDescriptors; private data: ParcelData;
  private rights=new Map<number,RetainedDescriptor>();
  private closed=false;
  private closing:Promise<void>|undefined;
  private constructor(kernel:FileDescriptors,data:ParcelData) { this.kernel = kernel; this.data = data; }
  static async retain(kernel:FileDescriptors,pid:number,data:ParcelData): Promise<StoredParcel> {
    const stored=new StoredParcel(kernel,{bytes:data.bytes.slice(),objects:[]});
    const positions=new Set<number>();
    try {
      for (const [at,object] of data.objects) {
        if (positions.has(at)) throw new StoredParcelError("Duplicate retained Parcel object position");
        positions.add(at);
        if (object && "descriptor" in object) {
          const right=await kernel.retain(pid,object.descriptor);
          if (!right) throw new StoredParcelError("Invalid retained Parcel descriptor");
          stored.rights.set(at,right);stored.data.objects.push([at,null]);
        } else {
          if (object && "bytes" in object) throw new StoredParcelError("Snapshot descriptors cannot be retained as shared rights");
          stored.data.objects.push([at,object && {...object}]);
        }
      }
      return stored;
    } catch (error) {await stored.close();throw error;}
    finally {await Promise.all(data.objects.map(([,object])=>object && "descriptor" in object ? kernel.discard(pid,object.descriptor,true) : undefined));}
  }
  async replay(pid:number): Promise<ParcelData> {
    if (this.closed) throw new Error("Stored Parcel has been released");
    this.kernel.ensureReceiver(pid);
    const data:ParcelData={bytes:this.data.bytes.slice(),objects:[]};
    try {
      for (const [at,object] of this.data.objects) {
        if (this.closed) throw new Error("Stored Parcel has been released");
        const right=this.rights.get(at);
        if (!right) {data.objects.push([at,object && {...object}]);continue;}
        const token=await this.kernel.replay(right,pid);
        if (token < 0) throw new Error("Cannot replay retained Parcel descriptor");
        data.objects.push([at,{descriptor:token}]);
      }
      if (this.closed) throw new Error("Stored Parcel has been released");
      return data;
    } catch (error) {
      await Promise.all(data.objects.map(([,object])=>object && "descriptor" in object ? this.kernel.discard(pid,object.descriptor,false) : undefined));
      throw error;
    }
  }
  async readLocal<T>(pid: number, read: (data: ParcelData, take: (token: number) => number,
    discard: (data: ParcelData) => Promise<void>) => T | Promise<T>): Promise<T> {
    const data = await this.replay(pid);
    const discard = async (value: ParcelData) => { await Promise.all(value.objects.map(([,o]) => o && "descriptor" in o ? this.kernel.discard(pid, o.descriptor, false) : undefined)); };
    try { return await read(data, token => this.kernel.takeLocal(pid, token), discard); }
    finally { await discard(data); }
  }
  close(): Promise<void> {
    if(this.closing)return this.closing;
    this.closed=true;
    const rights=[...this.rights.values()];this.rights.clear();
    return this.closing=Promise.all(rights.map(right=>this.kernel.release(right))).then(()=>{});
  }
}
