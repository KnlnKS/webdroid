import { expect, test, describe } from "vite-plus/test";
import "../src/natives.ts";
import { mkPfd, pfdBackingBytes, fdContents, ashmemFd } from "../src/android/os.ts";
import { parcelled, unparcelled, exportParcel, importParcel, copyParcelable } from "../src/android/binder.ts";
import { StoredParcel } from "../src/shell/stored-parcel.ts";
import { nativeParcel, freeData, OwnedFd } from "../src/android/parcel.ts";
import { handle, release as releaseHandle, take } from "../src/android/handles.ts";
import { newObj, vcall, vcallAsync, mainThread, iof, staticField } from "../src/jvm/natives/jentry.ts";
import { getDeclared, type JObj } from "../src/jvm/runtime.ts";
import { newFile, fdInt, setFdInt, mkFd } from "../src/jvm/natives/jio.ts";
import { vfs } from "../src/shell/vfs.ts";
import { E } from "../src/native/abi.ts";
import { Cpu, setA64 } from "../src/native/cpu.ts";
import { defineHost, lookupHost } from "../src/native/host.ts";
import { kernelCalls } from "../src/native/calls.testkit.ts";
import { libcInit } from "../src/native/libc32/libc.ts";
import { mem, guestAt } from "../src/native/mem.ts";
import { jarray } from "../src/jvm/abi.ts";
import { FS_SYSCALLS, localOpen } from "../src/native/fs.ts";
import { closeFd, seekFd, readFd, preadFd, pwriteFd, truncateFd, dupFd, openFd } from "../src/native/fd.ts";
import { FdScope } from "../src/android/fd-scope.ts";
import { settleRemoteMaps } from "../src/native/mappings.ts";
import { kernelInit } from "../src/native/syscall.ts";
import { BytesFile } from "../src/shell/lazyfile.ts";
import { assetFd, scall, useTestBroker } from "./java.ts";
import { FileDescriptors, type DescriptorCalls } from "../src/shell/file-descriptors.ts";
import { brokerMethods } from "../src/shell/broker-contract.ts";
import { callProxy, serveCalls } from "../src/shell/rpc.ts";
import { isRemoteFd, processRights } from "../src/native/process-fd.ts";
import { type JBuffer, addressOf, directAddress } from "../src/jvm/natives/jnio.ts";
import { canonicalFilePaths, renamePath, makeFifo, useOwnerChanges, type FilePaths, type PathOwner } from "../src/shell/file-path.ts";
import type { BrokerCalls } from "../src/shell/broker-contract.ts";

/** this realm as a Worker whose mutable files `owner` holds, or as the page again */
const usePathOwner = (owner: PathOwner | null): void => { useTestBroker(owner ? owner as unknown as Partial<BrokerCalls> : {}, !!owner); };


describe("android-pfd", () => {
  test("document descriptors share seekable writes and commit on last close", async () => {
    const written: Uint8Array[] = [];
    const sink = (bytes: Uint8Array) => { written.push(bytes.slice()); };
    const key = `test-pfd-${Math.random()}`;
    const first = await mkPfd(new Uint8Array(8), sink, key);
    const second = await mkPfd(new Uint8Array(8), sink, key);
    const stream = async (pfd: typeof first) => {
      const fd = await vcall(pfd, "getFileDescriptor", "()Ljava/io/FileDescriptor;");
      return newObj("java/io/FileOutputStream", "(Ljava/io/FileDescriptor;)V", fd);
    };
    const a = await stream(first), b = await stream(second);
    await vcall(a, "write", "([BII)V", new Int8Array([1, 2, 3, 4]), 0, 4);
    const channel = await vcall(b, "getChannel", "()Ljava/nio/channels/FileChannel;");
    await vcall(channel, "position", "(J)Ljava/nio/channels/FileChannel;", 4n);
    await vcall(b, "write", "([BII)V", new Int8Array([5, 6, 7, 8]), 0, 4);
    await vcall(a, "close", "()V");
    await vcall(b, "close", "()V");
    await vcall(first, "close", "()V");
    expect(written).toHaveLength(0);
    await vcall(second, "close", "()V");
    await pfdBackingBytes(key);
    expect(written).toEqual([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]);
  });
});

describe("file-descriptor", () => {
  /** descriptor `token` of session `from` passed to session `to`, as a Parcel stages and receives it */
  const pass = async (kernel: FileDescriptors, calls: DescriptorCalls, from: number, token: number, to: number) =>
    kernel.receive(from, await calls.stage(token) as number, to);
  const FD = "()Ljava/io/FileDescriptor;";

  test("canonical mapping leases retain live ashmem aliases, protection and independent FD lifetime", async () => {
    const kernel = new FileDescriptors(), clients = [1001,1002].map(pid => kernel.session(pid,() => 0));
    const fd = ashmemFd(new Uint8Array(4096)), file = openFd(fd)!;
    const shared = await newObj("android/os/SharedMemory", "(Ljava/io/FileDescriptor;)V", await mkFd(fd));
    const call = clients[1];
    try {
      seekFd(fd,23,0);
      const token = await kernel.receive(1001,kernel.rights(1001).stage(fd) as number,1002);
      expect(await call.take(token)).toMatchObject({token});
      const acquired = await call.mappingAcquire(token,0,4096,3);
      if (typeof acquired === "number") throw new Error(`mappingAcquire: ${acquired}`);
      const a = acquired.lease;
      expect(await vcall(shared,"setProtect","(I)Z",1)).toBe(1);
      expect(await call.mappingAcquire(token,0,4096,3)).toBe(-E.PERM);
      const duplicate = await pass(kernel,clients[1],1002,token,1002);
      const alias = await call.mappingAcquire(duplicate,1,4095,1);
      if (typeof alias === "number") throw new Error(`mappingAcquire: ${alias}`);
      const b = alias.lease;
      expect(alias).toEqual({lease:b,region:acquired.region,immutable:false,pool:acquired.pool});
      await vcall(shared,"close","()V");
      await call.close(token);
      await call.close(duplicate);
      expect(file.references).toBe(2);
      expect(await call.mappingWrite(a,0,Uint8Array.of(8))).toBe(1);
      vfs.writeAt(file.content,1,Uint8Array.of(9));
      expect(await call.mappingRead(a,0,2)).toEqual(Uint8Array.of(8,9));
      expect(await call.mappingRead(b,0,1)).toEqual(Uint8Array.of(9));
      expect(file.pos).toBe(23);
      expect(await call.mappingWrite(b,0,Uint8Array.of(7))).toBe(-E.ACCES);
      expect(await clients[0].mappingRead(a,0,1)).toBe(-E.BADF);
      await call.mappingRelease(a);
      expect(file.references).toBe(1);
      kernel.close(1002);
      await new Promise(resolve => setTimeout(resolve,0));
      expect(file.references).toBe(0);
      expect(await call.mappingRead(b,0,1)).toBe(-E.BADF);
    } finally {
      await vcall(shared,"close","()V"); kernel.close(1001); kernel.close(1002);
    }
  });

  test("one process at a time opens a fifo another realm names", async () => {
    const kernel = new FileDescriptors(), [a, b] = [1001,1002].map(pid => kernel.session(pid,() => 0)), path = "/fifo-kernel";
    expect(makeFifo(path)).toBe(0);
    try {
      expect(await a.open(path,0x800)).toBe("fifo");
      expect(await b.open(path,1)).toBe(-E.NXIO);
      expect(localOpen(path,1)).toBe(-E.NXIO);
      kernel.close(1001);
      expect(await b.open(path,1)).toBe("fifo");
    } finally { kernel.close(1001); kernel.close(1002); vfs.delete(path); }
  });

  test("Java Parcel owner release closes only its descriptor side table", async () => {
    const path = "/data/data/test/fd/parcel-owner.bin";
    vfs.write(path, Uint8Array.of(1, 2));
    const fd = localOpen(path, 2), file = openFd(fd)!;
    const parcel = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;"), native = nativeParcel(parcel), ptr = handle(native);
    try {
      await vcall(parcel, "writeFileDescriptor", "(Ljava/io/FileDescriptor;)V", await mkFd(fd));
      expect(file.references).toBe(2);
      releaseHandle(ptr);
      expect(file.references).toBe(1);
      expect(native.objects.size).toBe(0);
      const byte = new Uint8Array(1);
      expect(readFd(fd, byte, 1)).toBe(1);
      expect([...byte]).toEqual([1]);
      freeData(native);
      expect(file.references).toBe(1);
      const transferred = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");
      await vcall(transferred, "writeFileDescriptor", "(Ljava/io/FileDescriptor;)V", await mkFd(fd));
      const taken = take<typeof native>(handle(nativeParcel(transferred)));
      try { expect(file.references).toBe(2); }
      finally { freeData(taken); }
      expect(file.references).toBe(1);
    } finally { freeData(native); releaseHandle(ptr); closeFd(fd); vfs.delete(path); }
  });

  test("retained Java Parcel rights replay shared offsets after sender death and survive store replacement",async()=>{
    const path="/data/data/test/fd/retained.bin",kernel=new FileDescriptors();
    vfs.write(path,Uint8Array.of(1,2,3,4));
    const channels=[new MessageChannel(),new MessageChannel()];
    const stops=channels.map((channel,i)=>serveCalls(channel.port1,kernel.session(1001+i,()=>0)));
    const proxies=channels.map(channel=>callProxy<DescriptorCalls>(channel.port2,brokerMethods.descriptors));
    const files=canonicalFilePaths(()=>0);let stored:StoredParcel|null=null;
    const recipients:JObj[]=[];
    try {
      usePathOwner({files,descriptors:proxies[0].endpoint});
      const fd=await scall("android/system/Os","open","(Ljava/lang/String;II)Ljava/io/FileDescriptor;",path,2,0);
      const pfd=await newObj("android/os/ParcelFileDescriptor","(Ljava/io/FileDescriptor;)V",fd);
      try {stored=await StoredParcel.retain(kernel,1001,await parcelled(pfd,processRights));}
      finally {await vcall(pfd,"close","()V");}
      kernel.close(1001);usePathOwner({files,descriptors:proxies[1].endpoint});
      for(let i=0;i<2;i++) {
        const replay=await stored.replay(1002);
        const restored=await unparcelled("android/os/ParcelFileDescriptor",structuredClone(replay));
        recipients.push(restored);
        const received=await vcall(restored,"getFileDescriptor",FD),byte=new Int8Array(1);
        expect(await scall("android/system/Os","read","(Ljava/io/FileDescriptor;[BII)I",received,byte,0,1)).toBe(1);
        expect([...byte]).toEqual([i+1]);
      }
      const closing=stored.close();expect(stored.close()).toBe(closing);await closing;
      await expect(stored.replay(1002)).rejects.toThrow("released");
      const received=await vcall(recipients[0],"getFileDescriptor",FD),byte=new Int8Array(1);
      expect(await scall("android/system/Os","read","(Ljava/io/FileDescriptor;[BII)I",received,byte,0,1)).toBe(1);
      expect([...byte]).toEqual([3]);
      await scall("android/system/Os","pwrite","(Ljava/io/FileDescriptor;[BIIJ)I",received,Int8Array.of(9),0,1,0n);
      expect([...vfs.read(path)!]).toEqual([9,2,3,4]);
      const rejected=await proxies[1].endpoint.stage(-1);
      await expect(StoredParcel.retain(kernel,1002,{bytes:new Uint8Array(),objects:[[0,{descriptor:rejected}]]})).rejects.toThrow("Invalid retained");
    } finally {
      for(const pfd of recipients)await vcall(pfd,"close","()V");await stored?.close();
      usePathOwner(null);proxies.forEach(proxy=>proxy.close());stops.forEach(stop=>stop());
      kernel.close(1001);kernel.close(1002);vfs.delete(path);
    }
  });

  test("broker decode scope owns lazy Bundle and PFD duplicates but preserves retained and recipient rights", async () => {
    const path = "/data/data/test/fd/scoped.bin", kernel = new FileDescriptors(), scope = new FdScope();
    kernel.ensureReceiver(1001);
    vfs.write(path, Uint8Array.of(1, 2, 3));
    const fd = localOpen(path, 2), file = openFd(fd)!;
    let stored: StoredParcel | undefined, recipient: JObj | undefined, duplicate: JObj | undefined;
    try {
      const pfd = await newObj("android/os/ParcelFileDescriptor", "(Ljava/io/FileDescriptor;)V", await mkFd(fd));
      const bundle = await newObj("android/os/Bundle", "()V");
      await vcall(bundle, "putParcelable", "(Ljava/lang/String;Landroid/os/Parcelable;)V", "fd", pfd);
      const lazy = await copyParcelable("android/os/Bundle", bundle, scope);
      const decoded = await vcall(lazy, "getParcelable", "(Ljava/lang/String;)Landroid/os/Parcelable;", "fd");
      duplicate = await vcall(decoded, "dup", "()Landroid/os/ParcelFileDescriptor;");
      const rights = kernel.rights(1001);
      stored = await StoredParcel.retain(kernel, 1001, await parcelled(lazy, rights));
      scope.close(); scope.close();
      expect(file.references).toBe(2);
      expect(fdInt(await vcall(duplicate, "getFileDescriptor", FD))).toBe(-1);
      closeFd(fd); kernel.close(1001);
      expect(file.references).toBe(1);
      const recipientScope = new FdScope();
      try {
        const replayed = await stored.readLocal(1002, (data, rights) => unparcelled("android/os/Bundle", data, rights, recipientScope));
        recipient = await vcall(replayed, "getParcelable", "(Ljava/lang/String;)Landroid/os/Parcelable;", "fd");
        recipientScope.transfer();
      } finally { recipientScope.close(); }
      await stored.close();
      const byte = new Uint8Array(1);
      expect(readFd(fdInt(await vcall(recipient, "getFileDescriptor", FD)), byte, 1)).toBe(1);
      expect([...byte]).toEqual([1]);
      await vcall(recipient, "close", "()V"); recipient = undefined;
      expect(file.references).toBe(0);
    } finally {
      scope.close(); await stored?.close();
      if (recipient) await vcall(recipient, "close", "()V");
      if (duplicate) await vcall(duplicate, "close", "()V");
      closeFd(fd); kernel.close(1001); kernel.close(1002); vfs.delete(path);
    }
  });

  test("broker decode scope cleans CREATOR and serialization failure without closing reused descriptor slots", async () => {
    const path = "/data/data/test/fd/scoped-failure.bin", kernel = new FileDescriptors();
    kernel.ensureReceiver(1001);
    vfs.write(path, Uint8Array.of(4, 5));
    const fd = localOpen(path, 2), file = openFd(fd)!;
    const scope = new FdScope();
    let stored: StoredParcel | undefined;
    try {
      const pfd = await newObj("android/os/ParcelFileDescriptor", "(Ljava/io/FileDescriptor;)V", await mkFd(fd));
      const bundle = await newObj("android/os/Bundle", "()V");
      for (const key of ["a", "b"]) await vcall(bundle, "putParcelable", "(Ljava/lang/String;Landroid/os/Parcelable;)V", key, pfd);
      let stages = 0;
      const rights = { ...kernel.rights(1001), stage: (n: number) => { if (++stages === 2) throw new Error("stage failure"); return kernel.rights(1001).stage(n); } };
      await expect(Promise.resolve(parcelled(bundle, rights))).rejects.toThrow("stage failure");
      expect(file.references).toBe(1);
      const data = await parcelled(bundle, { ...rights, stage: kernel.rights(1001).stage });
      data.bytes[4] = 0; // Corrupt Bundle's magic so its real CREATOR rejects the imported rights.
      stored = await StoredParcel.retain(kernel, 1001, data);
      let failed = false;
      try { await stored.readLocal(1002, (data, rights) => unparcelled("android/os/Bundle", data, rights, scope)); }
      catch { failed = true; }
      expect(failed).toBe(true);
      scope.close(); await stored.close();
      expect(file.references).toBe(1);
      const reuseScope = new FdScope(), parcel = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");
      await vcall(parcel, "writeFileDescriptor", "(Ljava/io/FileDescriptor;)V", await mkFd(fd));
      const native = nativeParcel(parcel), owned = [...native.objects.values()][0] as OwnedFd;
      native.objects.set(0, new OwnedFd(owned.fd, reuseScope));
      const slot = owned.fd;
      reuseScope.close();
      const replacement = localOpen(path, 2);
      try {
        expect(replacement).toBe(slot);
        freeData(native);
        expect(readFd(replacement, new Uint8Array(1), 1)).toBe(1);
      } finally { closeFd(replacement); await vcall(parcel, "recycle", "()V"); }
    } finally { scope.close(); await stored?.close(); kernel.close(1001); kernel.close(1002); closeFd(fd); vfs.delete(path); }
  });

  test("canonical descriptors share live bytes and offsets across ports and retain a recipient after owner death", async () => {
    const path = "/data/data/test/fd/port.bin", owner = new FileDescriptors();
    vfs.write(path, Uint8Array.of(1,2,3,4));
    const source = owner.session(1001, () => 0), recipient = owner.session(1002, () => E.ACCES);
    const channels = [new MessageChannel(), new MessageChannel()];
    const stops = [serveCalls(channels[0].port1,source),serveCalls(channels[1].port1,recipient)];
    const proxies = channels.map(channel => callProxy<DescriptorCalls>(channel.port2,brokerMethods.descriptors));
    const [a,b] = proxies.map(proxy => proxy.endpoint);
    try {
      expect(await b.open(path,2)).toBe(-E.ACCES);
      const fd = (await a.open(path,2) as {token: number}).token;
      expect(await owner.receive(1001,fd,1002)).toBe(-E.BADF);
      const copy = await pass(owner,source,1001,fd,1001);
      await a.fcntl(copy,2,1);
      expect(await a.fcntl(copy,1,0)).toBe(1);
      expect(await a.fcntl(fd,1,0)).toBe(0);
      const passed = await pass(owner,source,1001,copy,1002);
      expect(passed).toBeGreaterThan(0);
      expect(await b.read(passed,1)).toEqual(Uint8Array.of(1));
      expect(await a.read(fd,1)).toEqual(Uint8Array.of(2));
      await b.write(passed,Uint8Array.of(9),0);
      expect(await a.read(fd,2,0)).toEqual(Uint8Array.of(9,2));
      expect(await a.seek(copy,0,1)).toBe(2);
      await a.fcntl(copy,4,0x400);
      expect(await b.fcntl(passed,3,0) & 0x400).toBe(0x400);
      await a.fcntl(fd,4,0);
      expect(await b.stat(fd)).toBe(-E.BADF);
      const stagedLate = await a.stage(fd);
      const late = await owner.receive(1001,stagedLate,1002), channel = new MessageChannel();
      const { promise: entered, resolve: enter } = Promise.withResolvers<void>(), { promise: waiting, resolve: release } = Promise.withResolvers<void>();
      const { promise: disposed, resolve: dispose } = Promise.withResolvers<void>();
      const stop = serveCalls(channel.port1,{reply:async () => { enter();await waiting;return late; }},undefined,
        {reply:async value => { await owner.discard(1002,value,false);dispose(); }});
      const pending = callProxy<{reply():Promise<number>}>(channel.port2,["reply"]);
      try {
        const result = pending.endpoint.reply().catch(() => -1);
        await entered;stop();release();await disposed;await result;
        expect(await b.stat(late)).toBe(-E.BADF);
      } finally { release();pending.close();stop(); }
      owner.close(1001);
      expect(await a.read(fd,1)).toBe(-E.BADF);
      expect(await b.read(passed,1)).toEqual(Uint8Array.of(3));
      await b.truncate(passed,3);
      expect(await b.stat(passed)).toMatchObject({size:3});
      expect(await b.read(passed,1)).toEqual(new Uint8Array(0));
      vfs.setAttributes(path,{uid:12345,gid:1078,mode:0o660});
      vfs.delete(path);
      expect(await b.stat(passed)).toMatchObject({uid:12345,gid:1078,mode:0o100660,path:null});
      await b.write(passed,Uint8Array.of(8),0);
      expect(await b.read(passed,1,0)).toEqual(Uint8Array.of(8));
      expect(vfs.exists(path)).toBe(false);
      expect(await b.close(passed)).toBe(0);
      expect(await b.close(passed)).toBe(-E.BADF);
    } finally {
      owner.close(1001); owner.close(1002);
      proxies.forEach(proxy => proxy.close()); stops.forEach(stop => stop()); vfs.delete(path);
    }
  });

  test("canonical descriptor death retires pending replies without closing another process's shared open file", async () => {
    const path = "/data/data/test/fd/pending.bin", owner = new FileDescriptors();
    const { promise: waiting, resolve: release } = Promise.withResolvers<void>(), { promise: started, resolve: entered } = Promise.withResolvers<void>();
    vfs.mount(path,{size:4,read:async (offset,length) => { entered(); await waiting; return Uint8Array.of(1,2,3,4).slice(offset,offset+length); }});
    const a = owner.session(1001,() => 0), b = owner.session(1002,() => 0);
    try {
      const fd = (await a.open(path,0) as {token: number}).token;
      const passed = await pass(owner,a,1001,fd,1002);
      const staged = await a.stage(fd);
      const read = a.read(fd,2);
      await started;
      const receive = owner.receive(1001,staged,1002);
      const position = b.seek(passed,0,1);
      const duplicate = pass(owner,b,1002,passed,1002);
      owner.close(1001); release();
      expect(await read).toBe(-E.BADF);
      expect(await receive).toBe(-E.BADF);
      expect(await position).toBe(2);
      const second = await duplicate;
      expect(await b.read(second,1)).toEqual(Uint8Array.of(3));
      expect(await b.read(passed,1)).toEqual(Uint8Array.of(4));
    } finally { release(); owner.close(1001); owner.close(1002); vfs.delete(path); }
  });

  test("production Java and ARM descriptor entries share the canonical owner and await rename", async () => {
    const path="/data/data/test/fd/java-owner.tmp", renamed="/data/data/test/fd/java-owner.bin";
    const owner=new FileDescriptors(), paths=canonicalFilePaths(() => 0), channel=new MessageChannel();
    const stop=serveCalls(channel.port1,owner.session(1001,() => 0));
    const proxy=callProxy<DescriptorCalls>(channel.port2,brokerMethods.descriptors);
    const files:FilePaths={fileSetAttributes:async (p,c) => paths.fileSetAttributes(p,c),fileStat:async p => paths.fileStat(p),fileMkdir:async p => paths.fileMkdir(p),
      fileAccess:async (p,m) => paths.fileAccess(p,m),fileList:async p => paths.fileList(p),fileCreate:async p => paths.fileCreate(p),fileFifo:async p => paths.fileFifo(p),fileRemove:async p => paths.fileRemove(p),fileRename:async (a,b) => paths.fileRename(a,b)};
    usePathOwner({files,descriptors:proxy.endpoint});
    vfs.mkdir("/data/data/test/fd");
    const raf=await newObj("java/io/RandomAccessFile","(Ljava/lang/String;Ljava/lang/String;)V",path,"rw");
    const fd=await vcall(raf,"getFD",FD);
    const duplicate=await scall("android/system/Os","dup","(Ljava/io/FileDescriptor;)Ljava/io/FileDescriptor;",fd);
    setA64(true); kernelInit();
    const cpu=new Cpu(mainThread,"canonical-file-owner"),buffer=mem.malloc(16),pathPointer=mem.strdup(renamed);
    let nativeFd=-1;
    try {
      expect(isRemoteFd(fdInt(fd))).toBe(true);
      await vcall(raf,"write","([BII)V",Int8Array.of(1,2,3,4),0,4);
      const seek=defineHost("canonical-lseek",FS_SYSCALLS.lseek),write=defineHost("canonical-write",FS_SYSCALLS.write);
      expect(await cpu.call(seek,[fdInt(duplicate),1,0])).toBe(1);
      expect(await vcall(raf,"read","()I")).toBe(2);
      mem.st8(buffer,9);
      expect(await cpu.call(write,[fdInt(duplicate),buffer,1])).toBe(1);
      expect(await vcall(raf,"getFilePointer","()J")).toBe(3n);
      await scall("android/system/Os","rename","(Ljava/lang/String;Ljava/lang/String;)V",path,renamed);
      expect(vfs.exists(path)).toBe(false);
      expect([...vfs.read(renamed)!]).toEqual([1,2,9,4]);
      await vcall(raf,"seek","(J)V",0n);
      const bytes=new Int8Array(4);
      await vcall(raf,"readFully","([B)V",bytes);
      expect([...bytes]).toEqual([1,2,9,4]);
      nativeFd=await cpu.call(defineHost("canonical-openat",FS_SYSCALLS.openat),[-100,pathPointer,2]);
      expect(isRemoteFd(nativeFd)).toBe(true);
      expect(await cpu.call(defineHost("canonical-read",FS_SYSCALLS.read),[nativeFd,buffer,2])).toBe(2);
      expect([...mem.bytes(buffer,2)]).toEqual([1,2]);
      await cpu.call(defineHost("canonical-close",FS_SYSCALLS.close),[nativeFd]);nativeFd=-1;
      await vcall(raf,"close","()V");
      expect(await cpu.call(seek,[fdInt(duplicate),0,1])).toBe(4);
      await scall("android/system/Os","close","(Ljava/io/FileDescriptor;)V",duplicate);
      setA64(false);kernelInit();libcInit();
      const arm=new Cpu(mainThread,"canonical-arm32-file-owner"),mode=mem.strdup("r+");
      let stream=0;
      try {
        stream=await arm.call(lookupHost("fopen","libc.so")!,[pathPointer,mode]);
        expect(stream).toBeGreaterThan(0);
        expect(await arm.call(lookupHost("fseek","libc.so")!,[stream,1,0])).toBe(0);
        mem.st8(buffer,7);
        expect(await arm.call(lookupHost("fwrite","libc.so")!,[buffer,1,1,stream])).toBe(1);
        expect(await arm.call(lookupHost("ftell","libc.so")!,[stream])).toBe(2);
        expect(await arm.call(lookupHost("fclose","libc.so")!,[stream])).toBe(0);stream=0;
        expect([...vfs.read(renamed)!]).toEqual([1,7,9,4]);
      } finally {
        if(stream)await arm.call(lookupHost("fclose","libc.so")!,[stream]);
        mem.free(mode);arm.dispose();
      }
      const channel2=new MessageChannel(),stop2=serveCalls(channel2.port1,owner.session(1002,()=>E.ACCES));
      const recipient=callProxy<DescriptorCalls>(channel2.port2,brokerMethods.descriptors);
      let incoming: JObj | null=null,passed: JObj | null=null;
      try {
        const original=await scall("android/system/Os","open","(Ljava/lang/String;II)Ljava/io/FileDescriptor;",renamed,2,0);
        const outgoing=await scall("android/os/Parcel","obtain","()Landroid/os/Parcel;");
        await vcall(outgoing,"writeFileDescriptor","(Ljava/io/FileDescriptor;)V",original);
        const data=await exportParcel(nativeParcel(outgoing),processRights);
        await vcall(outgoing,"recycle","()V");
        const right=data.objects[0]![1];
        if(!right || !("descriptor" in right))throw new Error("canonical Binder right missing");
        expect(await owner.receive(1002,right.descriptor,1001)).toBe(-E.BADF);
        const received=await owner.receive(1001,right.descriptor,1002);
        expect(received).toBeGreaterThan(0);
        expect(await recipient.endpoint.fcntl(received,1,0)).toBe(1);
        expect(await owner.receive(1001,right.descriptor,1002)).toBe(-E.BADF);
        usePathOwner({files,descriptors:recipient.endpoint});
        incoming=await importParcel({...data,objects:[[data.objects[0]![0],{descriptor:received}]]});
        expect(await owner.discard(1002,received,false)).toBe(-E.BADF);
        passed=await vcall(incoming,"readFileDescriptor","()Landroid/os/ParcelFileDescriptor;");
        await vcall(incoming,"recycle","()V");incoming=null;
        const d=await vcall(passed,"getFileDescriptor",FD);
        expect(await scall("android/system/Os","lseek","(Ljava/io/FileDescriptor;JI)J",d,1n,0)).toBe(1n);
        expect(await scall("android/system/Os","lseek","(Ljava/io/FileDescriptor;JI)J",original,0n,1)).toBe(1n);
        await scall("android/system/Os","close","(Ljava/io/FileDescriptor;)V",original);
        owner.close(1001);
        const read=new Int8Array(1);
        expect(await scall("android/system/Os","read","(Ljava/io/FileDescriptor;[BII)I",d,read,0,1)).toBe(1);
        expect([...read]).toEqual([7]);
        await scall("android/system/Os","write","(Ljava/io/FileDescriptor;[BII)I",d,Int8Array.of(8),0,1);
        expect([...vfs.read(renamed)!]).toEqual([1,7,8,4]);
      } finally {
        if(incoming)await vcall(incoming,"recycle","()V");
        if(passed)await vcall(passed,"close","()V");
        recipient.close();stop2();owner.close(1002);usePathOwner({files,descriptors:proxy.endpoint});
      }
    } finally {
      await vcall(raf,"close","()V"); if(nativeFd>=0)await cpu.call(defineHost("canonical-cleanup-close",FS_SYSCALLS.close),[nativeFd]);
      owner.close(1001);proxy.close();stop();
      usePathOwner(null);
      mem.free(buffer);mem.free(pathPointer);cpu.dispose();setA64(false);vfs.delete(path);vfs.delete(renamed);
    }
  });

  test("a process copies, stats and changes canonical files through their owner", async () => {
    const source = "/data/data/test/fd/copy-source.bin", target = "/data/data/test/fd/copy-target.bin";
    const owner = new FileDescriptors(), paths = canonicalFilePaths(() => 0), channel = new MessageChannel();
    const stop = serveCalls(channel.port1, owner.session(1001, () => 0));
    const proxy = callProxy<DescriptorCalls>(channel.port2, brokerMethods.descriptors);
    usePathOwner({ files: new Proxy(paths, { get: (calls, name) => async (...args: never[]) => (calls as unknown as Record<string, (...a: never[]) => unknown>)[name as string]?.(...args) }), descriptors: proxy.endpoint });
    // the process trusts the stats it learned while the owner's counts of the files' changes hold
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true;
    useOwnerChanges(vfs.changeCounts());
    vfs.mkdir("/data/data/test/fd");
    vfs.write(source, Uint8Array.of(1, 2, 3, 4, 5));
    try {
      const path = (p: string) => scall("java/nio/file/Paths", "get", "(Ljava/lang/String;[Ljava/lang/String;)Ljava/nio/file/Path;", p, jarray([], "Ljava/lang/String;"));
      await scall("java/nio/file/Files", "copy", "(Ljava/nio/file/Path;Ljava/nio/file/Path;[Ljava/nio/file/CopyOption;)Ljava/nio/file/Path;",
        await path(source), await path(target), jarray([], "Ljava/nio/file/CopyOption;"));
      expect([...vfs.read(target)!]).toEqual([1, 2, 3, 4, 5]);
      const fd = await scall("android/system/Os", "open", "(Ljava/lang/String;II)Ljava/io/FileDescriptor;", target, 2, 0);
      expect(isRemoteFd(fdInt(fd))).toBe(true);
      const attrs = await newObj("sun/nio/fs/UnixFileAttributes", "()V");
      const fstat = async (field: string) => {
        await scall("sun/nio/fs/UnixNativeDispatcher", "fstat", "(ILsun/nio/fs/UnixFileAttributes;)V", fdInt(fd), attrs);
        return getDeclared(attrs, "sun/nio/fs/UnixFileAttributes", field);
      };
      const length = async () => vcall(await newFile(target), "length", "()J");
      expect([await fstat("st_size"), await length()]).toEqual([5n, 5n]);
      // another process's write
      vfs.writeAt(vfs.opened(target)!, 5, Uint8Array.of(6));
      expect([await fstat("st_size"), await length()]).toEqual([6n, 6n]);
      await scall("sun/nio/fs/UnixNativeDispatcher", "fchmod", "(II)V", fdInt(fd), 0o600);
      expect(vfs.attributes(target).mode).toBe(0o600);
      expect((await fstat("st_mode") as number) & 0o7777).toBe(0o600);
      expect(await vcall(await newFile(target), "setReadOnly", "()Z")).toBe(1);
      expect(vfs.attributes(target).mode).toBe(0o400);
      await scall("android/system/Os", "close", "(Ljava/io/FileDescriptor;)V", fd);
    } finally {
      usePathOwner(null); useOwnerChanges(undefined);
      delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
      owner.close(1001); proxy.close(); stop(); vfs.delete(source); vfs.delete(target);
    }
  });

  test("a stream over a RandomAccessFile's descriptor writes at the file's shared pointer", async () => {
    vfs.write("/data/data/test/fd/raf.bin", new Uint8Array(0));
    const raf = await newObj("java/io/RandomAccessFile", "(Ljava/lang/String;Ljava/lang/String;)V", "/data/data/test/fd/raf.bin", "rw");
    const d = await vcall(raf, "getFD", FD);
    expect(await vcall(d, "valid", "()Z")).toBe(1);
    expect(await vcall(raf, "getFD", FD)).toBe(d);
    const out = await newObj("java/io/FileOutputStream", "(Ljava/io/FileDescriptor;)V", d);
    await vcall(raf, "seek", "(J)V", 4n);
    await vcall(out, "write", "([BII)V", new Int8Array([1, 2, 3]), 0, 3);
    expect(await vcall(raf, "getFilePointer", "()J")).toBe(7n);
    await vcall(raf, "seek", "(J)V", 0n);
    await vcall(out, "write", "(I)V", 9);
    expect([...vfs.read("/data/data/test/fd/raf.bin")!]).toEqual([9, 0, 0, 0, 1, 2, 3]);
  });

  test("RandomAccessFile handles retain each other's out-of-order writes", async () => {
    const path = "/data/data/test/fd/ranges.bin";
    vfs.write(path, new Uint8Array(1024));
    const first = await newObj("java/io/RandomAccessFile", "(Ljava/lang/String;Ljava/lang/String;)V", path, "rw");
    const second = await newObj("java/io/RandomAccessFile", "(Ljava/lang/String;Ljava/lang/String;)V", path, "rw");
    await vcall(first, "write", "([B)V", Int8Array.from([1, 2, 3]));
    await vcall(second, "seek", "(J)V", 512n);
    await vcall(second, "write", "([B)V", Int8Array.from([4, 5, 6]));
    await vcall(first, "seek", "(J)V", 1023n);
    await vcall(first, "write", "(I)V", 7);
    await vcall(second, "close", "()V");
    await vcall(first, "close", "()V");
    const bytes = vfs.read(path)!;
    expect(bytes.length).toBe(1024);
    expect([...bytes.subarray(0, 3)]).toEqual([1, 2, 3]);
    expect([...bytes.subarray(512, 515)]).toEqual([4, 5, 6]);
    expect(bytes[1023]).toBe(7);
  });

  test("an open file sees a longer view of its shared backing", () => {
    const path = "/data/data/test/fd/growing.bin";
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    vfs.write(path, bytes.subarray(0, 3));
    const open = vfs.open(path)!;
    vfs.write(path, bytes);
    expect(open.len).toBe(6);
    expect([...open.data.subarray(0, open.len)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("a file stream's and an archive entry's descriptors duplicate onto open native files", async () => {
    vfs.write("/data/data/test/fd/in.bin", new Uint8Array([5, 6, 7]));
    const input = await newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", "/data/data/test/fd/in.bin");
    const pfd = await scall("android/os/ParcelFileDescriptor", "dup", "(Ljava/io/FileDescriptor;)Landroid/os/ParcelFileDescriptor;", await vcall(input, "getFD", FD));
    expect(await vcall(pfd, "getFd", "()I")).toBeGreaterThanOrEqual(0);
    const entry = await assetFd(new Uint8Array([1, 2, 3, 4]));
    const dup = await scall("android/os/ParcelFileDescriptor", "dup", "(Ljava/io/FileDescriptor;)Landroid/os/ParcelFileDescriptor;", await vcall(entry, "getFileDescriptor", FD));
    const end = await scall("android/system/Os", "lseek", "(Ljava/io/FileDescriptor;JI)J", await vcall(dup, "getFileDescriptor", FD), 0n, 2);
    expect(end).toBe(4n);
  });
});

describe("file-input-descriptor", () => {
  async function rejectsJava(value: Promise<unknown>, name: string) {
    const error = await value.then(() => null, error => error);
    expect(iof(error, name)).toBe(true);
  }

  test("descriptor streams share native offsets and borrow ownership across rename and unlink", async () => {
    const path = "/input-descriptor", renamed = path + "-renamed";
    vfs.write(path, Uint8Array.of(1, 2, 3, 4));
    const owner = await newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", path);
    const fd = await vcall(owner, "getFD", "()Ljava/io/FileDescriptor;");
    const borrowed = await newObj("java/io/FileInputStream", "(Ljava/io/FileDescriptor;)V", fd);
    try {
      expect(await vcall(owner, "getFD", "()Ljava/io/FileDescriptor;")).toBe(fd);
      expect(renamePath(path, renamed)).toBe(0);
      vfs.delete(renamed);
      expect(await vcall(borrowed, "read", "()I")).toBe(1);
      const byte = new Uint8Array(1);
      expect(await readFd(fdInt(fd), byte, 1)).toBe(1);
      expect(byte[0]).toBe(2);
      const channel = await vcall(owner, "getChannel", "()Ljava/nio/channels/FileChannel;");
      expect(await vcall(channel, "position", "()J")).toBe(2n);
      expect(await vcall(channel, "size", "()J")).toBe(4n);
      const mode = await staticField("java/nio/channels/FileChannel$MapMode", "READ_ONLY");
      const mapped = await vcall(channel, "map", "(Ljava/nio/channels/FileChannel$MapMode;JJ)Ljava/nio/MappedByteBuffer;", mode, 1n, 2n);
      expect(await vcall(mapped, "get", "(I)B", 1)).toBe(3);
      expect(await vcall(channel, "position", "()J")).toBe(2n);
      expect(await vcall(borrowed, "skip", "(J)J", -1n)).toBe(-1n);
      expect(await vcall(owner, "available", "()I")).toBe(3);
      const dst = new Int8Array(5);
      expect(await vcall(owner, "read", "([BII)I", dst, 1, 3)).toBe(3);
      expect([...dst]).toEqual([0, 2, 3, 4, 0]);
      expect(await vcall(owner, "read", "()I")).toBe(-1);
      await vcall(borrowed, "close", "()V");
      expect(seekFd(fdInt(fd), 0, 0)).toBe(0);
      expect(await vcall(owner, "read", "()I")).toBe(1);
      await rejectsJava(vcallAsync(borrowed, "read", "()I"), "java/io/IOException");
      await vcall(channel, "close", "()V");
      expect(fdInt(fd)).toBe(-1);
      expect(await vcall(channel, "isOpen", "()Z")).toBe(0);
    } finally { await vcall(owner, "close", "()V"); vfs.delete(path); vfs.delete(renamed); }
  });

  test("descriptor streams serialize lazy reads and reject invalid input", async () => {
    const path = "/input-descriptor-lazy", bytes = Uint8Array.of(5, 6, 7, 8);
    vfs.mount(path, { size: 4, read: async (offset, length) => bytes.subarray(offset, offset + Math.min(length, 2)) });
    const fd = await mkFd(localOpen(path, 0));
    const input = await newObj("java/io/FileInputStream", "(Ljava/io/FileDescriptor;)V", fd);
    try {
      const a = new Int8Array(3), b = new Int8Array(3);
      expect(await Promise.all([vcall(input, "read", "([B)I", a), vcall(input, "read", "([B)I", b)])).toEqual([3, 1]);
      expect([...a, ...b]).toEqual([5, 6, 7, 8, 0, 0]);
      expect(await vcall(input, "read", "([BII)I", a, 3, 0)).toBe(0);
      expect(await vcall(input, "markSupported", "()Z")).toBe(0);
      for (const [method, desc, args, error] of [
        ["read", "([BII)I", [a, -1, 1], "java/lang/IndexOutOfBoundsException"], ["read", "([BII)I", [a, 2, 2], "java/lang/IndexOutOfBoundsException"],
        ["read", "([B)I", [null], "java/lang/NullPointerException"], ["reset", "()V", [], "java/io/IOException"],
      ] satisfies [string, string, unknown[], string][]) {
        await rejectsJava(vcallAsync(input, method, desc, ...args), error);
      }
      closeFd(fdInt(fd));
      await rejectsJava(vcallAsync(input, "read", "()I"), "java/io/IOException");
      await rejectsJava(vcallAsync(input, "available", "()I"), "java/io/IOException");
    } finally { closeFd(fdInt(fd)); await vcall(input, "close", "()V"); vfs.delete(path); }
  });

  test("descriptor streams wait for pipe bytes without closing borrowed descriptors", async () => {
    setA64(true); kernelInit();
    const cpu = new Cpu(mainThread, "input-descriptor-pipe"), buffer = mem.malloc(16);
    const call = kernelCalls(cpu);
    expect(await call("pipe2", buffer, 0)).toBe(0);
    const fd = await mkFd(mem.ld32(buffer));
    const writer = mem.ld32(buffer + 4);
    const input = await newObj("java/io/FileInputStream", "(Ljava/io/FileDescriptor;)V", fd);
    try {
      const bytes = new Int8Array(2), pending = vcall(input, "read", "([B)I", bytes);
      mem.write(buffer + 8, Uint8Array.of(9, 10));
      expect(await call("write", writer, buffer + 8, 2)).toBe(2);
      expect(await pending).toBe(2);
      expect([...bytes]).toEqual([9, 10]);
      closeFd(writer);
      expect(await vcall(input, "read", "()I")).toBe(-1);
      await vcall(input, "close", "()V");
      expect(await readFd(fdInt(fd), new Uint8Array(1), 1)).toBe(0);
    } finally { closeFd(fdInt(fd)); closeFd(writer); mem.free(buffer); cpu.dispose(); }
  });

  test("descriptor constructors defer invalid descriptor failures and honor explicit ownership", async () => {
    await rejectsJava((async () => newObj("java/io/FileInputStream", "(Ljava/io/FileDescriptor;)V", null))(), "java/lang/NullPointerException");
    const fd = await mkFd(-1);
    const invalid = await newObj("java/io/FileInputStream", "(Ljava/io/FileDescriptor;)V", fd);
    await rejectsJava(vcallAsync(invalid, "read", "()I"), "java/io/IOException");
    await vcall(invalid, "close", "()V");
    const path = "/input-descriptor-owner";
    vfs.write(path, Uint8Array.of(1));
    setFdInt(fd, localOpen(path, 0));
    const input = await newObj("java/io/FileInputStream", "(Ljava/io/FileDescriptor;Z)V", fd, 1);
    await vcall(input, "close", "()V");
    expect(fdInt(fd)).toBe(-1);
    vfs.delete(path);
  });
});

describe("file-relative", () => {
  test("a relative directory lists relative children and reports a plain File parent", async () => {
    vfs.write("/relative-list/child", new Uint8Array(0));
    const dir = await newObj("java/io/File", "(Ljava/lang/String;)V", "relative-list");
    const [child] = await vcall(dir, "listFiles", "()[Ljava/io/File;") as JObj[];
    expect(await vcall(child, "getPath", "()Ljava/lang/String;")).toBe("relative-list/child");
    expect(await vcall(await vcall(child, "getParentFile", "()Ljava/io/File;"), "getPath", "()Ljava/lang/String;")).toBe("relative-list");
  });
});

describe("parcel-file", () => {
  test("byte-backed descriptors have native storage and duplicates outlive the original", async () => {
    const pfd = await mkPfd(Uint8Array.of(1, 2, 3));
    const fd = await vcall(pfd, "getFd", "()I");
    expect(fd).toBeGreaterThanOrEqual(0);
    expect(seekFd(fd, 0, 2)).toBe(3);
    const duplicate = await vcall(pfd, "dup", "()Landroid/os/ParcelFileDescriptor;");
    await vcall(pfd, "close", "()V");
    await expect(vcallAsync(pfd, "getFd", "()I")).rejects.toBeDefined();
    const copyFd = await vcall(duplicate, "detachFd", "()I");
    expect(seekFd(copyFd, 0, 1)).toBe(3);
    await vcall(duplicate, "close", "()V");
    expect(seekFd(copyFd, 0, 0)).toBe(0);
    closeFd(copyFd);
  });
  test("an imported writable descriptor writes back once its reader closes", async () => {
    const path = "/data/local/tmp/pfd-write-back-test";
    vfs.write(path, Uint8Array.of(1, 2, 3), false);
    try {
      const PFD = "android/os/ParcelFileDescriptor";
      const pfd = await scall(PFD, "open", "(Ljava/io/File;I)Landroid/os/ParcelFileDescriptor;", await newFile(path), 0x30000000);
      const reader = await unparcelled(PFD, await parcelled(pfd));
      const fd = await vcall(reader, "getFd", "()I");
      truncateFd(fd, 0); pwriteFd(fd, Uint8Array.of(9), 0);
      await vcall(reader, "close", "()V");
      for (let i = 0; i < 50 && vfs.read(path)?.length !== 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(vfs.read(path)).toEqual(Uint8Array.of(9));
      await vcall(pfd, "close", "()V");
    } finally { vfs.delete(path); }
  });
  test("FD wire serialization owns its buffers independently of the source storage", async () => {
    const pfd = await mkPfd(Uint8Array.of(1, 2, 3));
    try {
      const wire = await parcelled(pfd);
      const exported = wire.objects.find(([, value]) => value && "bytes" in value)?.[1];
      if (!exported || !("bytes" in exported)) throw new Error("descriptor bytes missing from Parcel");
      expect(exported.bytes.buffer).toBeInstanceOf(ArrayBuffer);
      const fd = await vcall(pfd, "getFd", "()I");
      const source = await fdContents(fd);
      expect(exported.bytes.buffer).not.toBe(source!.buffer);
      const cloned = structuredClone(wire);
      expect(cloned.objects).toEqual(wire.objects);
      exported.bytes[0] = 9;
      expect(await fdContents(fd)).toEqual(Uint8Array.of(1, 2, 3));
    } finally { await vcall(pfd, "close", "()V"); }
  });
  test("read-only file opens load lazy bytes and AutoCloseInputStream owns the descriptor", async () => {
    const path = "/data/local/tmp/pfd-lazy-test";
    vfs.mount(path, { size: 3, read: async (offset, length) => Uint8Array.of(7, 8, 9).slice(offset, offset + length) });
    try {
      const pfd = await scall("android/os/ParcelFileDescriptor", "open", "(Ljava/io/File;I)Landroid/os/ParcelFileDescriptor;", await newFile(path), 0x10000000);
      const input = await newObj("android/os/ParcelFileDescriptor$AutoCloseInputStream", "(Landroid/os/ParcelFileDescriptor;)V", pfd);
      expect(await vcall(input, "read", "()I")).toBe(7);
      expect(await vcall(pfd, "getStatSize", "()J")).toBe(3n);
      await vcall(input, "close", "()V");
      await expect(vcallAsync(pfd, "getFd", "()I")).rejects.toBeDefined();
    } finally { vfs.delete(path); }
  });

  test("Os.mmap exposes file bytes to native code and munmap releases the address", async () => {
    const pfd = await mkPfd(Uint8Array.of(9, 8, 7));
    const fd = await vcall(pfd, "getFileDescriptor", "()Ljava/io/FileDescriptor;");
    const address = await scall("android/system/Os", "mmap", "(JJIILjava/io/FileDescriptor;J)J", 0n, 3n, 1, 2, fd, 0n) as bigint;
    expect([...mem.bytes(guestAt(address), 3)]).toEqual([9, 8, 7]);
    await scall("android/system/Os", "munmap", "(JJ)V", address, 3n);
    await vcall(pfd, "close", "()V");
  });
});

describe("rename", () => {
  describe("renamePath", () => {
    test("moves a loaded file and keeps a lazy source lazy", () => {
      vfs.write("/data/t/a.txt", new Uint8Array([1, 2, 3]));
      expect(renamePath("/data/t/a.txt", "/data/t/b.txt")).toBe(0);
      expect(vfs.read("/data/t/a.txt")).toBeNull();
      expect([...vfs.read("/data/t/b.txt")!]).toEqual([1, 2, 3]);

      const lazy = new BytesFile(new Uint8Array([9]));
      vfs.mount("/data/t/lazy.bin", lazy);
      expect(renamePath("/data/t/lazy.bin", "/data/t/moved.bin")).toBe(0);
      expect(vfs.node("/data/t/moved.bin")?.content).toBe(lazy);
      expect(vfs.exists("/data/t/lazy.bin")).toBe(false);
    });

    test("reports a missing source and a directory target", () => {
      expect(renamePath("/data/t/none", "/data/t/x")).toBe(-E.NOENT);
      vfs.mkdir("/data/t/dir");
      vfs.write("/data/t/f", new Uint8Array(1));
      expect(renamePath("/data/t/f", "/data/t/dir")).toBe(-E.ISDIR);
      expect(vfs.exists("/data/t/f")).toBe(true);
    });

    test("Java and native renames carry directory entries", async () => {
      vfs.write("/data/t/old/sub/x", new Uint8Array([4]));
      vfs.mkdir("/data/t/old/empty");
      const made = vfs.mtime("/data/t/old/empty");
      expect(await vcall(await newFile("/data/t/old"), "renameTo", "(Ljava/io/File;)Z", await newFile("/data/t/new"))).toBe(1);
      expect(vfs.exists("/data/t/old")).toBe(false);
      expect([...vfs.read("/data/t/new/sub/x")!]).toEqual([4]);
      expect(vfs.isDir("/data/t/new/empty")).toBe(true);
      expect(vfs.mtime("/data/t/new/empty")).toBe(made);
      expect(renamePath("/data/t/new", "/data/t/new/inner")).toBe(-E.INVAL);
    });
  });
});

describe("shared-memory", () => {
  test("Worker shared memory maps into guest memory and hands Java stores to the owner", async () => {
    const owner = new FileDescriptors(), ports = [1001,1002].map(pid => {
      const channel = new MessageChannel(), stop = serveCalls(channel.port1,owner.session(pid,() => 0));
      return {stop,proxy:callProxy<DescriptorCalls>(channel.port2,brokerMethods.descriptors)};
    });
    const files = canonicalFilePaths(() => 0);
    let first: JObj | null = null, second: JObj | null = null, a: JBuffer | undefined, b: JBuffer | undefined;
    try {
      usePathOwner({ files, descriptors: ports[0].proxy.endpoint });
      first = await scall("android/os/SharedMemory","create","(Ljava/lang/String;I)Landroid/os/SharedMemory;","aliases",8192);
      a = await vcall(first,"mapReadWrite","()Ljava/nio/ByteBuffer;") as JBuffer;
      expect(await directAddress(a)).toBe(Number(addressOf(a)));
      await vcall(a,"putInt","(II)Ljava/nio/ByteBuffer;",4096,0x12345678);
      const fd = fdInt(await vcall(first,"getFileDescriptor","()Ljava/io/FileDescriptor;"));
      // the descriptor leaves with the stores its mappings hold
      const staged = await processRights.stage(fd), held = new Uint8Array(4);
      expect(await preadFd(fd,held,held.length,4096)).toBe(4);
      expect(new DataView(held.buffer).getInt32(0)).toBe(0x12345678);
      const token = await owner.receive(1001,staged!,1002);
      usePathOwner({ files, descriptors: ports[1].proxy.endpoint });
      second = await newObj("android/os/SharedMemory","(Ljava/io/FileDescriptor;)V",await mkFd(await processRights.take(token)));
      expect(await vcall(second,"getSize","()I")).toBe(8192);
      expect(await vcall(second,"setProtect","(I)Z",1)).toBe(1);
      expect(await vcall(first,"setProtect","(I)Z",3)).toBe(0);
      b = await vcall(second,"map","(III)Ljava/nio/ByteBuffer;",1,4096,4096) as JBuffer;
      expect(await vcall(b,"getInt","(I)I",0)).toBe(0x12345678);
      // the mapping outlives its descriptors, and unmapping a page carries its stores to the owner
      await vcall(a,"putInt","(II)Ljava/nio/ByteBuffer;",4100,0x34567812);
      const fd2 = fdInt(await vcall(second,"getFileDescriptor","()Ljava/io/FileDescriptor;")), reopened = dupFd(fd2);
      await vcall(first,"close","()V"); await vcall(second,"close","()V");
      await scall("android/system/Os","munmap","(JJ)V",addressOf(a) + 4096n,4096n);
      await settleRemoteMaps();
      expect(await preadFd(reopened,held,held.length,4100)).toBe(4);
      expect(new DataView(held.buffer).getInt32(0)).toBe(0x34567812);
      await closeFd(reopened);
      await scall("android/system/Os","munmap","(JJ)V",addressOf(a),4096n); a = undefined;
      await scall("android/os/SharedMemory","unmap","(Ljava/nio/ByteBuffer;)V",b); b = undefined;
    } finally {
      if (a) await scall("android/os/SharedMemory","unmap","(Ljava/nio/ByteBuffer;)V",a);
      if (b) await scall("android/os/SharedMemory","unmap","(Ljava/nio/ByteBuffer;)V",b);
      if (first) await vcall(first,"close","()V"); if (second) await vcall(second,"close","()V");
      usePathOwner(null);
      for (const {stop,proxy} of ports) { proxy.close(); stop(); }
      owner.close(1001); owner.close(1002);
    }
  });

  test("shared memory maps and parcels its protected bytes", async () => {
    const shared = await scall("android/os/SharedMemory", "create", "(Ljava/lang/String;I)Landroid/os/SharedMemory;", "sample", 3);
    const writable = await vcall(shared, "mapReadWrite", "()Ljava/nio/ByteBuffer;");
    await vcall(writable, "put", "([B)Ljava/nio/ByteBuffer;", Int8Array.of(3, 5, 7));
    await scall("android/os/SharedMemory", "unmap", "(Ljava/nio/ByteBuffer;)V", writable);
    expect(await vcall(shared, "setProtect", "(I)Z", 1)).toBe(1);
    expect(await vcall(shared, "setProtect", "(I)Z", 3)).toBe(0);
    const parcel = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");
    await vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", shared, 0);
    await vcall(parcel, "setDataPosition", "(I)V", 0);
    const restored = await vcall(parcel, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
    const readOnly = await vcall(restored, "mapReadOnly", "()Ljava/nio/ByteBuffer;");
    const result = new Int8Array(3);
    await vcall(readOnly, "get", "([B)Ljava/nio/ByteBuffer;", result);
    expect([...result]).toEqual([3, 5, 7]);
    expect(await vcall(readOnly, "isReadOnly", "()Z")).toBe(1);
    await scall("android/os/SharedMemory", "unmap", "(Ljava/nio/ByteBuffer;)V", readOnly);
  });
});
