import { releaseRights, type ParcelData } from "../android/binder.ts";
import { mapRights, type DescriptorRights, type FileDescriptors, type RetainedDescriptor } from "./file-descriptors.ts";

/** Broker-local descriptor ownership; no retained right is exposed as a wire token. */
export class StoredParcel {
  private kernel: FileDescriptors; private data: ParcelData;
  private rights=new Map<number,RetainedDescriptor>();
  private closed=false;
  private closing:Promise<void>|undefined;
  private constructor(kernel:FileDescriptors,data:ParcelData) { this.kernel = kernel; this.data = data; }
  static async retain(kernel:FileDescriptors,pid:number,data:ParcelData): Promise<StoredParcel> {
    const stored=new StoredParcel(kernel,data),positions=new Set<number>();
    try {
      stored.data=await mapRights(data,async (object,at)=>{
        if (positions.has(at)) throw new Error("Duplicate retained Parcel object position");
        positions.add(at);
        if (object && "bytes" in object) throw new Error("Snapshot descriptors cannot be retained as shared rights");
        if (!object || !("descriptor" in object)) return object && {...object};
        const right=await kernel.retain(pid,object.descriptor);
        if (!right) throw new Error("Invalid retained Parcel descriptor");
        stored.rights.set(at,right);
        return null;
      },()=>stored.close());
      return stored;
    } finally {await releaseRights(data,kernel.rights(pid),true);}
  }
  async replay(pid:number): Promise<ParcelData> {
    const live=()=>{if (this.closed) throw new Error("Stored Parcel has been released");};
    live();
    this.kernel.ensureReceiver(pid);
    const rights=this.kernel.rights(pid);
    const data=await mapRights(this.data,async (object,at)=>{
      live();
      const right=this.rights.get(at);
      if (!right) return object && {...object};
      const token=await this.kernel.replay(right,pid);
      if (token < 0) throw new Error("Cannot replay retained Parcel descriptor");
      return {descriptor:token};
    },partial=>releaseRights(partial,rights,false));
    if (this.closed) await releaseRights(data,rights,false);
    live();
    return data;
  }
  /** `read` of a replay to `pid`, whose rights it may take; the rest are discarded */
  async readLocal<T>(pid: number, read: (data: ParcelData, rights: DescriptorRights) => T | Promise<T>): Promise<T> {
    const data = await this.replay(pid), rights = this.kernel.rights(pid);
    try { return await read(data, rights); }
    finally { await releaseRights(data, rights, false); }
  }
  close(): Promise<void> {
    if(this.closing)return this.closing;
    this.closed=true;
    const rights=[...this.rights.values()];this.rights.clear();
    return this.closing=Promise.all(rights.map(right=>this.kernel.release(right))).then(()=>{});
  }
}
