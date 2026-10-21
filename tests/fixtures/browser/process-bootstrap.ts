import { processBroker, type ProcessBroker, type ProcessBootstrap } from "../../../src/shell/processes.ts";
import { brokerMethods, type BrokerCalls } from "../../../src/shell/broker-contract.ts";
import { packages, PackageRecord } from "../../../src/android/packages.ts";
import { Resources } from "../../../src/android/res.ts";
import { TV } from "../../../src/android/axml.ts";
import { vfs } from "../../../src/shell/vfs.ts";
import { packedArchives } from "../../../src/shell/packedarchive.ts";
import { RemoteFile } from "../../../src/shell/remote-file.ts";
import { guestClockControl, setSystemTimeout, wallMillis, bootTime, createGuestClockPort } from "../../../src/guest-clock.ts";
import { callProxy } from "../../../src/shell/rpc.ts";
import { sendFrames } from "../../../src/shell/frame-port.ts";
import { attachPointerInput } from "../../../src/shell/pointer-input.ts";
import { inputMethods, receiveIme, type InputCalls } from "../../../src/shell/input-port.ts";
import { ProcessHost, workerControlMethods } from "../../../src/shell/process-host.ts";
import type { WorkerControl } from "../../../src/shell/worker-control.ts";
import { NOT_CRASHED, recordRemoteExit } from "../../../src/android/server/appexitinfo.ts";
import { visibleWorkerProcesses, visibleWorkersAlive, workerAotProfiles, workerSnapshots } from "../../../src/shell/worker-diagnostics.ts";
import { fixtureUrl, fixtureWorker, stubEndpoint, type BrokerInit, type PointerCalls } from "./fixture-calls.ts";

const failed = (reply: unknown) => !!(reply as { error?: string } | null)?.error;
/** a client fixture Worker calling the broker as `pid`: `ask` answers the value of a call of the method by the
 *  name it is called by, or `{error}` with its message */
function brokerWorker(broker: ProcessBroker, pid: number) {
  const worker = fixtureWorker("client"), waiting = new Map<number, (value: unknown) => void>();
  let next = 1, ready!: () => void;
  const started = new Promise<void>(resolve => ready = resolve);
  worker.onmessage = ({ data }) => {
    if (data.ready) ready();
    else { waiting.get(data.id)!("error" in data ? { error: data.error } : data.value); waiting.delete(data.id); }
  };
  const port = broker.brokerPort(pid);
  worker.postMessage({ broker: port, methods: brokerMethods } satisfies BrokerInit, [port]);
  const ask = (method: string, ...args: unknown[]) => started.then(() => new Promise<unknown>(resolve => {
    const id = next++;
    waiting.set(id, resolve);
    worker.postMessage({ id, method, args });
  }));
  return { ask, worker };
}
/** a process of `pkg` in a fixture Worker playing `role`, which the broker starts as it starts its own */
function hosted(broker: ProcessBroker, pkg: string, process: string, pid: number, role: string) {
  const worker = fixtureWorker(role), host = new ProcessHost({ pid, url: fixtureUrl(role), worker, release() {} }, pkg, broker.hosts);
  return { worker, entry: broker.register(pkg, process, pid, host) };
}
/** what `worker` first posts under `key` */
const posted = <T>(worker: Worker, key: string) => new Promise<T>((resolve, reject) => {
  worker.addEventListener("message", ({ data }) => { if (data && typeof data === "object" && key in data) resolve(data[key]); });
  worker.addEventListener("error", event => reject(new Error(event.message)));
});

export async function bootstrapOwnership() {
  const displays: Promise<void>[] = [];
  let reads = 0, began!: () => void;
  const waiting = new Promise<void>(resolve => began = resolve);
  for (const [i, pkg] of ["test.archive.one", "test.archive.two"].entries()) {
    const path = `/data/app/${pkg}/base.apk`;
    const root = { name: "manifest", attrs: [{ ns: "", name: "package", resId: 0, type: TV.STRING, data: 0, str: pkg }], children: [] };
    packages.set(pkg, new PackageRecord(root, new Resources(null, {}), path, 12000 + i, async () => []));
    vfs.mount(path, { size: 64 << 20, read(offset) {
      reads++;
      if (offset === 7) { began(); return new Promise<Uint8Array>(() => {}); }
      return Uint8Array.of(i + 10);
    } });
  }
  const broker = processBroker(), callers: ReturnType<typeof callProxy<BrokerCalls>>[] = [];
  const watchClock = (data: ProcessBootstrap) => {
    if (!data.broker) throw new Error("expected command capability");
    callers.push(callProxy<BrokerCalls>(data.broker,brokerMethods));
    if (!data.display) throw new Error("expected display capability");
    displays.push(new Promise<void>(resolve => data.display!.addEventListener("message",({data})=>{if(data.kind==="close")resolve();})));
    sendFrames(data.display, data.screen);
  };
  // each process's Worker posts back the bootstrap it is started with
  const start = (pkg: string, process: string, pid: number) => {
    const { worker, entry } = hosted(broker, pkg, process, pid, "echo");
    return { entry, data: posted<ProcessBootstrap>(worker, "bootstrap") };
  };
  const file = (data: ProcessBootstrap) => {
    watchClock(data);
    const source = data.registry[0].source;
    if (!("port" in source)) throw new Error("expected lazy archive port");
    return new RemoteFile(source);
  };
  const one = start("test.archive.one", "test.archive.one", 7001), two = start("test.archive.two", "test.archive.two", 7002);
  const first = file(await one.data), other = file(await two.data);
  const firstIme = one.entry.host!.ime!, otherIme = two.entry.host!.ime!;
  const eagerReads = reads;
  // A failed handoff disposes the exports it made, and its process dies.
  const clone = globalThis.structuredClone;
  const unpublished: RemoteFile[] = [];
  let failed: unknown;
  try {
    globalThis.structuredClone = value => {
      const data = value as ProcessBootstrap;
      watchClock(data);
      for (const record of data.registry) if ("port" in record.source) unpublished.push(new RemoteFile(record.source));
      throw new DOMException("handoff failed", "DataCloneError");
    };
    failed = await start("test.archive.one", "test.archive.one:handoff", 7003).entry.ready.then(() => null, error => error.msg);
  } finally { globalThis.structuredClone = clone; }
  const discarded = await Promise.all(unpublished.map(file => file.read(0, 1).catch(error => error.message)));
  const retained = Array.from(await first.read(0, 1));
  const pending = first.read(7, 1).catch(error => error.message);
  await waiting;
  broker.fail(7001, "fixture process exit", NOT_CRASHED);
  const ended = await pending;
  const imeDeadClosed=!firstIme.input.isConnected,imePeerSurvives=otherIme.input.isConnected;
  const isolated = Array.from(await other.read(0, 1));
  broker.fail(7002, "fixture process exit", NOT_CRASHED);
  await Promise.all(displays);
  const callersClosed = (await Promise.all(callers.map(client=>client.endpoint.process.processAlive(0).then(()=>false,()=>true)))).every(Boolean);
  packages.clear(); packedArchives.clear();
  return { imeOwners:{deadClosed:imeDeadClosed,peerSurvives:imePeerSurvives},eagerReads, failed, discarded, retained, ended, isolated, callersClosed, displaysClosed:displays.length };
}

export async function endpointOwnership() {
  const broker = processBroker();
  const names = ["test.endpoint.one", "test.endpoint.two"];
  const entries = names.map((pkg, i) => {
    const root = { name: "manifest", attrs: [{ ns: "", name: "package", resId: 0, type: TV.STRING, data: 0, str: pkg }], children: [] };
    packages.set(pkg, new PackageRecord(root, new Resources(null, {}), `/data/app/${pkg}/base.apk`, 13000 + i, async () => []));
    return broker.register(pkg, pkg, 8001 + i);
  });
  let entered!: () => void, killed = false, removed = false;
  const waiting = new Promise<void>(resolve => entered = resolve);
  const endpoint = (pid: number) => stubEndpoint({
    transact: async (request, caller) => {
      if (request.code === 2) { await other.cookiesChanged(); return {handled:caller.pid,data:{bytes:Uint8Array.of(caller.uid & 255),objects:[]}}; }
      if (request.code === 3) {
        const right=request.data.objects[0]?.[1];
        if(!right || !("descriptor" in right))throw new Error("missing driver FD right");
        const owner=callProxy<BrokerCalls>(broker.brokerPort(pid),brokerMethods);
        try {
          const read=await owner.endpoint.descriptors.fileDescriptor({kind:"read",fd:right.descriptor,length:1});
          await owner.endpoint.descriptors.fileDescriptor({kind:"write",fd:right.descriptor,offset:0,bytes:Uint8Array.of(77)});
          await owner.endpoint.descriptors.fileDescriptor({kind:"seek",fd:right.descriptor,offset:0,whence:0});
          const stage=await owner.endpoint.descriptors.fileDescriptor({kind:"stage",fd:right.descriptor});
          await owner.endpoint.descriptors.fileDescriptor({kind:"close",fd:right.descriptor});
          return {handled:(read as Uint8Array)[0],data:{bytes:new Uint8Array(0),objects:[[0,{descriptor:stage}]]}};
        } finally {owner.close();}
      }
      entered(); return new Promise(() => {});
    },
    service: async () => ({ pid, id: 1 }),
    packageRemoved: async () => { await new Promise(resolve => setTimeout(resolve, 10)); removed = true; },
    kill: () => { setTimeout(() => { killed = true; broker.fail(pid, "fixture kill delivered", NOT_CRASHED); }, 10); },
  });
  const worker = fixtureWorker("endpoint"), channel = new MessageChannel();
  const reverse = broker.brokerPort(8002);
  worker.postMessage({port:channel.port1,broker:reverse,methods:brokerMethods} satisfies BrokerInit & {port:MessagePort}, [channel.port1,reverse]);
  broker.ready(8001, endpoint(8001)); broker.readyPort(8002, channel.port2);
  broker.ready(8001, endpoint(9999));
  const first = await entries[0].ready, other = await entries[1].ready;
  const request = { kind: "peek" as const, intent: { bytes: new Uint8Array(0), objects: [] } };
  const filePath = "/data/data/test.endpoint.two/fd.bin";
  vfs.write(filePath,Uint8Array.of(1));
  const fileOpened = await other.service({...request,intent:{bytes:Uint8Array.of(43),objects:[]}});
  const fileWritten = vfs.read(filePath)?.[0];
  vfs.writeAt(vfs.open(filePath)!,0,Uint8Array.of(66));
  const fileRead = await other.service({...request,intent:{bytes:Uint8Array.of(44),objects:[]}});
  const binderFile=await other.service({...request,intent:{bytes:Uint8Array.of(45),objects:[]}});
  const repeatedReady = (await first.service(request))?.pid === 8001;
  const reverseCaller = await other.service({...request,intent:{bytes:Uint8Array.of(42),objects:[]}});
  const pending = broker.transact(8002, { handle: { pid: 8001, id: 1 }, code: 1, flags: 0, data: request.intent })
    .catch(error => error.msg);
  await waiting;
  const lifeRead = await other.service({...request,intent:{bytes:Uint8Array.of(47),objects:[]}});
  const victim=broker.register(names[1],names[1]+":signal",8003);
  broker.ready(victim.pid,{...endpoint(victim.pid),kill:()=>broker.fail(victim.pid,"fixture signal delivered",NOT_CRASHED)});
  await other.service({...request,intent:{bytes:Uint8Array.of(49),objects:[]}});
  const signalOwn = !broker.alive(8003), signalForeign = broker.alive(8001);
  await broker.forceStop(names[0]);
  const pendingCause = await pending;
  const lifeDead=await other.service({...request,intent:{bytes:Uint8Array.of(48),objects:[]}});
  const cleanupPort=callProxy<BrokerCalls>(broker.brokerPort(8002),brokerMethods);
  await cleanupPort.endpoint.process.processWatch(8002,1);
  const retained=entries[1].watchers.size;
  cleanupPort.close();
  for(let i=0;i<30&&entries[1].watchers.size===retained;i++)await new Promise(r=>setTimeout(r,1));
  const watcherCleaned=entries[1].watchers.size===retained-1;
  const otherAlive = broker.alive(8002) && (await other.service(request))?.pid === 8002;
  const binderSurvivor=await other.service({...request,intent:{bytes:Uint8Array.of(46),objects:[]}});
  await broker.packageRemoved("test.removed.package");
  removed = (await other.service(request))?.id === 2;
  broker.fail(8002, "fixture cleanup", NOT_CRASHED);
  vfs.delete(filePath);
  worker.terminate();
  return { repeatedReady, reverseCaller, killed, alive: broker.alive(8001), pendingCause, otherAlive, removed,
    lifecycle:{read:lifeRead,dead:lifeDead,signalOwn,signalForeign,watcherCleaned},
    fileDescriptors:{opened:!!fileOpened && fileOpened.pid>0,foreign:fileOpened?.id,written:fileWritten,read:fileRead,binder:binderFile,survivor:binderSurvivor} };
}

/** A real Worker's CookieManager and WebView calls share the page's jar and survive a sibling's death. */
export async function cookieOwnership() {
  const broker = processBroker(), pkg = "test.cookies.shared", isolated = "test.cookies.other";
  for (const [i, name] of [pkg, isolated].entries()) {
    const root = {name:"manifest",attrs:[{ns:"",name:"package",resId:0,type:TV.STRING,data:0,str:name}],children:[]};
    packages.set(name, new PackageRecord(root, new Resources(null, {}), `/data/app/${name}/base.apk`, 14000 + i, async () => []));
  }
  for (const [i, name] of [pkg, pkg, isolated].entries()) broker.register(name, name + ":" + i, 8101 + i);
  const peers = [8102, 8103].map(pid => callProxy<BrokerCalls>(broker.brokerPort(pid), brokerMethods));
  const jar = await broker.cookies(pkg), otherJar = await broker.cookies(isolated);
  jar.remove(); otherJar.remove();
  let changes = 0;
  const unwatch = jar.watch(() => changes++);
  const { ask, worker } = brokerWorker(broker, 8101);
  try {
    const url = "https://cookies.example/dir/index";
    const session = await ask("cookieSet", url, "session=one; Path=/; HttpOnly");
    const persisted = await ask("cookieSet", url, "saved=two; Path=/; Max-Age=86400");
    const read = await peers[0].endpoint.cookieGet(url), isolatedRead = await peers[1].endpoint.cookieGet(url);
    const document = (await ask("cookieDocument", url, null, false) as {text: string}[]).map(cookie => cookie.text);
    const network = await ask("cookieNetwork", url, url, [], false);
    await peers[0].endpoint.cookieAccept(false);
    const accept = await ask("cookieAccept"), denied = await ask("cookieSet", url, "denied=three");
    await peers[0].endpoint.cookieAccept(true);
    const removed = await ask("cookieRemove", true), afterSession = await peers[0].endpoint.cookieGet(url);
    await ask("cookieFlush");
    const saved = JSON.parse(localStorage.getItem("wd:web-cookies:" + pkg) ?? "{}").cookies.map((cookie: {key: string}) => cookie.key);
    const original = broker.cookies;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => entered = resolve), blocked = new Promise<void>(resolve => release = resolve);
    broker.cookies = async name => { entered(); await blocked; return original.call(broker, name); };
    let pending: unknown;
    try {
      const write = ask("cookieSet", url, "late=no");
      await waiting;
      broker.fail(8101, "cookie fixture death", NOT_CRASHED);
      release(); pending = await write;
    } finally { release(); broker.cookies = original; }
    const dead = await ask("cookieSet", url, "afterdeath=no");
    const survivor = await peers[0].endpoint.cookieGet(url);
    await peers[0].endpoint.cookieRemove(false);
    const empty = await peers[0].endpoint.cookieHas();
    return {session, persisted, read, isolatedRead, document, network, accept, denied, removed, afterSession, saved,
      dead: failed(dead), pendingDead: failed(pending), survivor, empty, changes};
  } finally {
    unwatch(); for (const client of peers) client.close();
    for (const pid of [8101, 8102, 8103]) broker.fail(pid, "cookie fixture cleanup", NOT_CRASHED);
    worker.terminate(); jar.forget(); otherJar.forget(); packages.delete(pkg); packages.delete(isolated);
  }
}

export async function clockBootstrapOwnership() {
  const broker = processBroker(), pkg = "test.clock.worker", pid = 8201;
  const root = {name:"manifest",attrs:[{ns:"",name:"package",resId:0,type:TV.STRING,data:0,str:pkg}],children:[]};
  const path = `/data/app/${pkg}/base.apk`;
  packages.set(pkg, new PackageRecord(root, new Resources(null, {}), path, 15000, async () => []));
  vfs.mount(path, {size:1,read:()=>Uint8Array.of(31)});
  const clock = createGuestClockPort(pid), start = guestClockControl.now(), wall = wallMillis();
  const { worker, entry } = hosted(broker, pkg, pkg, pid, "clock"), workers = [worker];
  // the clock comes before the start the broker sends once it has the bootstrap
  worker.postMessage({clock:clock.data}, [clock.data.port!]);
  broker.watch(pid, clock.close);
  const ticks: {tick:string;now:number;wall?:number}[] = [];
  worker.addEventListener("message", ({data}) => { if (data.tick) ticks.push(data); });
  try {
    const ready = await posted<{display:boolean;archive:number[];controlled:boolean;bootTime:number;identity:(number|string)[];commands:{cookies:boolean}}>(worker, "report");
    let brokerTimer = 0;
    setSystemTimeout(()=>brokerTimer++,20);
    const incoming = await entry.ready;
    await incoming.cookiesChanged();
    await incoming.packageRemoved("worker.endpoint.absent.package");
    const advanced = await guestClockControl.advanceBy(10), pendingBeforeDeath = guestClockControl.pending();
    const previous = {pid:8199,uid:15000,process:pkg,pkg,reason:4,status:0,importance:400,timestamp:wall,
      description:"crash",state:null,tombstone:null,dialog:false};
    recordRemoteExit(previous);
    const survivor = broker.register(pkg,pkg+":reader",8202);
    const reader = callProxy<BrokerCalls>(broker.brokerPort(survivor.pid),brokerMethods);
    const died = new Promise<void>(resolve=>broker.watch(pid,()=>resolve()));
    incoming.kill(9,{reason:4,description:"crash"});
    await died;
    const records = await reader.endpoint.exitRecords(pkg);
    records[0]!.description="changed wire copy";
    const stored = (await reader.endpoint.exitRecords(pkg))[0]!;
    const exit = {pid:stored.pid,uid:stored.uid,process:stored.process,pkg:stored.pkg,reason:stored.reason,status:stored.status,dialog:stored.dialog,description:stored.description};
    reader.close();broker.fail(survivor.pid,"exit reader cleanup",NOT_CRASHED);
    worker.terminate();
    const crashRow=(await workerSnapshots(broker.processes())).find(row=>row.pid===pid)!;
    const fatal=crashRow.terminal!.record!.crash!;
    const crash={expected:crashRow.terminal?.expected,reason:crashRow.terminal?.record?.reason,error:"error" in crashRow,fatal:{...fatal},copied:false};
    fatal.exceptionMessage="changed terminal copy";
    crash.copied=(await workerSnapshots(broker.processes())).find(row=>row.pid===pid)!.terminal!.record!.crash!.exceptionMessage==="fatal fixture";
    const terminals=[];
    for(const [i,status] of [0,7,null].entries()) {
      const nextPid=8203+i,{worker:peer}=hosted(broker,pkg,pkg+":"+nextPid,nextPid,"clock");workers.push(peer);
      await posted(peer,"report");
      const ended=new Promise<void>(resolve=>broker.watch(nextPid,()=>resolve()));
      if(status===null)await broker.forceStop(pkg);else peer.postMessage({finish:status});
      await ended;
      const row=(await workerSnapshots(broker.processes())).find(row=>row.pid===nextPid)!;
      if(!row.terminal?.record)throw new Error("missing canonical terminal record");
      const record=row.terminal.record;
      const result={expected:row.terminal.expected,reason:record.reason,status:record.status,error:"error" in row,copied:false};
      record.status=99;
      result.copied=(await workerSnapshots(broker.processes())).find(row=>row.pid===nextPid)!.terminal!.record!.status!==99;
      terminals.push(result);peer.terminate();
    }
    const pendingAfterDeath = guestClockControl.pending();
    await guestClockControl.advanceBy(10);
    return {crash,terminals,exit,display:ready.display,controlled:ready.controlled,archive:ready.archive,origin:ready.bootTime===bootTime,identity:ready.identity,commands:ready.commands,
      wall:ticks[0]?.wall===wall+10,uptime:ticks.every(tick=>tick.now===start+10),ticks:ticks.map(tick=>tick.tick),advanced,pendingBeforeDeath,pendingAfterDeath,
      brokerTimer,pendingAfterAdvance:guestClockControl.pending()};
  } finally { workers.forEach(peer=>peer.terminate());for(const nextPid of [8203,8204,8205])broker.fail(nextPid,"exit fixture cleanup",NOT_CRASHED);broker.fail(pid,"clock fixture cleanup",NOT_CRASHED); packages.delete(pkg); }
}

/** a Worker's and its peers' calls on the stores the broker keeps for every process */
export async function storeOwnership() {
  const broker = processBroker(), pkg = "test.stores.shared", foreign = "test.stores.other";
  broker.files.attach(8302,vfs);
  for (const [i, name] of [pkg, foreign].entries()) {
    const root = {name:"manifest",attrs:[{ns:"",name:"package",resId:0,type:TV.STRING,data:0,str:name}],children:[]};
    packages.set(name,new PackageRecord(root,new Resources(null,{}),`/data/app/${name}/base.apk`,16000+i,async()=>[]));
  }
  const entries = [pkg,pkg,foreign].map((name,i)=>broker.register(name,name+":"+i,8301+i));
  broker.ready(8302,stubEndpoint()); broker.ready(8303,stubEndpoint());
  const peers = [8302,8303].map(pid=>callProxy<BrokerCalls>(broker.brokerPort(pid),brokerMethods));
  const {ask,worker}=brokerWorker(broker,8301);
  try {
    await ask("settings.get","global","webdroid_worker_setting");
    const settingsWritten=await ask("settings.put","global","webdroid_worker_setting","shared");
    const settingsRead=await peers[0].endpoint.settings.get("global","webdroid_worker_setting");
    const rows=await peers[0].endpoint.settings.entries("global");
    rows.find(([name])=>name==="webdroid_worker_setting")![1]="copied";
    const sameKey=await ask("settings.ssaidKey")===await peers[0].endpoint.settings.ssaidKey();
    const permission="android.permission.POST_NOTIFICATIONS", extra="android.permission.CAMERA";
    const before=await ask("permissions.permissionCheck",pkg,[permission]);
    await ask("permissions.permissionGrant",pkg,[permission]);
    const grantRead=await peers[0].endpoint.permissions.permissionCheck(pkg,[permission]);grantRead[0]=false;
    const own=await ask("permissions.permissionCheck",pkg,[permission]);
    const foreignDenied=await ask("permissions.permissionGrant",foreign,[permission]) as {error:string};
    packages.get(foreign)!.grants.add("android.permission.GRANT_RUNTIME_PERMISSIONS");
    await peers[1].endpoint.permissions.permissionGrant(pkg,[extra]);
    const privileged=await ask("permissions.permissionCheck",pkg,[extra]);
    const prefName = pkg + ":worker", policyName = "android:notification-policy:" + foreign;
    const prefAck = await ask("prefs.preferenceChange", prefName, [{kind:"put",key:"array",value:["one"]}]);
    await peers[0].endpoint.prefs.preferenceChange(prefName, [{kind:"put",key:"other",value:9n}]);
    const prefCopy = await ask("prefs.preferenceRead",prefName,"array") as string[]; prefCopy.push("local");
    const prefFresh = await peers[0].endpoint.prefs.preferenceRead(prefName,"array");
    const prefKeys = await ask("prefs.preferenceKeys",prefName) as string[];
    const foreignPref = await ask("prefs.preferenceChange",foreign+":private",[{kind:"put",key:"secret",value:1}]) as {error:string};
    const emptyForeign = await ask("prefs.preferenceFiles",foreign) as {error:string};
    broker.preferences.open(policyName).set("delegate",pkg);
    const publicPolicy = await ask("prefs.preferenceRead",policyName,"delegate");
    const policyWrite = await ask("prefs.preferenceChange",policyName,[{kind:"remove",key:"delegate"}]) as {error:string};
    const prefFiles = await ask("prefs.preferenceFiles",pkg) as [string,[string,unknown][]][];
    const prefs = {ack:prefAck,fresh:prefFresh,keys:prefKeys,foreignDenied:!!foreignPref.error,emptyForeignDenied:!!emptyForeign.error,
      publicPolicy,policyDenied:!!policyWrite.error,files:prefFiles.map(([name])=>name)};
    await ask("files.filePrepare",pkg);
    const directory=`/data/data/${pkg}/databases`;
    const made=await ask("files.fileMkdir",directory),repeated=await ask("files.fileMkdir",directory);
    const ownerStat=await peers[0].endpoint.files.fileStat(directory);
    const remoteStat=await ask("files.fileStat",directory) as {value:{uid:number,gid:number,mode:number}};
    const metadata = remoteStat.value.uid === packages.get(pkg)!.uid && remoteStat.value.gid === packages.get(pkg)!.uid && (remoteStat.value.mode & 0o7777) === 0o755;
    remoteStat.value.uid = 0;
    const retainedMetadata = (await peers[0].endpoint.files.fileStat(directory)).value?.uid === packages.get(pkg)!.uid;
    const changedMode = await ask("files.fileSetAttributes",directory,{mode:0o700}) === 0 && ((await peers[0].endpoint.files.fileStat(directory)).value!.mode & 0o7777) === 0o700;
    await broker.files.flush();
    const {PrivateFiles} = await import("../../../src/shell/privatefiles.ts");
    const restarted = new PrivateFiles();
    let restoredMetadata = false;
    try {
      vfs.rmdir(directory,false);restarted.attach(8399,vfs);await restarted.prepare(pkg);
      const restored = vfs.attributes(directory,true);
      restoredMetadata = restored.uid === packages.get(pkg)!.uid && restored.gid === packages.get(pkg)!.uid && restored.mode === 0o700;
    } finally {restarted.detach(8399);}
    const listed=await ask("files.fileList",`/data/data/${pkg}`) as {value:string[]};
    listed.value.length=0;
    const freshList=await peers[0].endpoint.files.fileList(`/data/data/${pkg}`);
    const foreignPath=await ask("files.fileMkdir",`/data/data/${foreign}/denied`);
    // Drain the notification endpoint before death, so cleanup is not racing its reply.
    await (await entries[1].ready).activity({kind:"back"});
    worker.terminate();broker.fail(8301,"store Worker ended",NOT_CRASHED);
    const settingsSurvivor=await peers[0].endpoint.settings.get("global","webdroid_worker_setting");
    return {prefs,paths:{made,repeated,directory:((ownerStat.value?.mode ?? 0) & 0o170000) === 0o040000,copied:freshList.value?.includes("databases"),foreignPath,metadata,retainedMetadata,changedMode,restoredMetadata},permissions:{before,own,foreignDenied:!!foreignDenied.error,privileged},
      settings:{written:settingsWritten,read:settingsRead,sameKey,survivor:settingsSurvivor}};
  }finally{
    for(const client of peers)client.close();worker.terminate();
    for(const pid of [8301,8302,8303])broker.fail(pid,"store fixture cleanup",NOT_CRASHED);
    for(const root of [`/data/data/${pkg}`,`/data/user_de/0/${pkg}`])for(const [path] of [...vfs.entries(root)])vfs.rmdir(path);
    broker.preferences.remove(pkg); broker.preferences.delete("android:notification-policy:"+foreign);
    broker.permissions.clear(pkg);broker.permissions.clear(foreign);
    packages.delete(pkg);packages.delete(foreign);
    await broker.files.flush();
  }
}

/** A PendingIntent's Intent may carry no descriptor; the staged one the refused request held is given back. */
export async function pendingDescriptorRights() {
  const broker=processBroker(),pkg="test.pending.rights",pid=8401,path=`/data/data/${pkg}/retained.bin`;
  const manifest={name:"manifest",attrs:[{ns:"",name:"package",resId:0,type:TV.STRING,data:0,str:pkg}],children:[]};
  packages.set(pkg,new PackageRecord(manifest,new Resources(null,{}),`/data/app/${pkg}/base.apk`,18000,async()=>[]));
  vfs.mkdir("/data/data");
  broker.register(pkg,pkg,pid);
  const {ask,worker}=brokerWorker(broker,pid);
  try {
    await ask("files.fileMkdir",`/data/data/${pkg}`);
    const opened=await ask("descriptors.fileDescriptor",{kind:"open",path,flags:0x42}) as number|{token:number};
    if(typeof opened==="number")throw new Error("Descriptor open failed: "+opened);
    const staged=await ask("descriptors.fileDescriptor",{kind:"stage",fd:opened.token}) as number;
    const denied=await ask("pending.create",pkg,"broadcast",0,0,{bytes:new Uint8Array(24),objects:[[0,{descriptor:staged}]]}) as {error?:string};
    const retired=typeof await ask("descriptors.fileDescriptor",{kind:"stat",fd:staged})==="number";
    return {pendingRejected:denied.error==="File descriptors passed in Intent" && retired};
  } finally {
    worker.terminate();broker.fail(pid,"pending rights fixture cleanup",NOT_CRASHED);
    vfs.delete(path);packages.delete(pkg);
  }
}

export async function pointerInputOwnership() {
  const worker=fixtureWorker("pointer"),channel=new MessageChannel(),client=callProxy<PointerCalls>(channel.port1,["pointer","release","samples"]);
  worker.postMessage({port:channel.port2},[channel.port2]);
  const canvases=[1,2].map(()=>{const c=document.createElement("canvas");c.style.cssText="position:fixed;left:0;top:0;width:100px;height:100px";document.body.append(c);return c;});
  const bindings=canvases.map((canvas,i)=>attachPointerInput(canvas,()=>({width:200,height:200,scrollUnit:128,touchSlop:16,edgeSlop:6,minScalingSpan:40}),
    (action,pointers)=>client.endpoint.pointer(i+1,action,pointers[0].x,pointers[0].y)));
  const pointer=(i:number,type:string,x:number,y:number)=>canvases[i].dispatchEvent(new PointerEvent(type,{clientX:x,clientY:y,pointerId:i+1}));
  try {
    pointer(0,"pointerdown",10,20);
    pointer(0,"pointermove",20,30);pointer(0,"pointermove",30,40);pointer(0,"pointerup",40,50);
    pointer(1,"pointerdown",5,6);pointer(1,"pointercancel",0,0);
    await client.endpoint.samples();await client.endpoint.release();
    // Each read is an independent port roundtrip; allow the queued UP's acknowledgment chain.
    let samples:number[][]=[];
    for(let i=0;i<20;i++){samples=await client.endpoint.samples();if(samples.length===5)break;}
    bindings.forEach(binding=>binding.close());
    pointer(0,"pointerdown",1,1);pointer(1,"pointerdown",1,1);
    const closed=await client.endpoint.samples();
    return {samples,closed:closed.length===samples.length};
  } finally { bindings.forEach(binding=>binding.close());client.close();worker.terminate();canvases.forEach(c=>c.remove()); }
}

export async function workerDiagnosticOwnership() {
  const broker=processBroker(),pkg="test.worker.diagnostics",clients:ReturnType<typeof callProxy>[]=[];
  const root={name:"manifest",attrs:[{ns:"",name:"package",resId:0,type:TV.STRING,data:0,str:pkg}],children:[]};
  packages.set(pkg,new PackageRecord(root,new Resources(null,{}),`/data/app/${pkg}/base.apk`,19000,async()=>[]));
  const worker=fixtureWorker("control");
  const pids=[8401,8402,8403,8404,8405],foreground=broker.activities.foreground;
  try {
    for(const [i,mode] of ['ready','reject','hang','packages','queueHang'].entries()) {
      const entry=broker.register(pkg,pkg+":"+i,pids[i]),channel=new MessageChannel();
      const client=callProxy<WorkerControl>(channel.port1,workerControlMethods);clients.push(client);
      // a host whose control the fixture Worker serves as `mode` says
      entry.host={url:location.origin+"/process-worker.js?pid="+entry.pid,control:client.endpoint,ended:null,close:client.close} as Partial<ProcessHost> as ProcessHost;
      await new Promise<void>(resolve=>{worker.onmessage=()=>resolve();worker.postMessage({port:channel.port2,mode,pid:entry.pid,pkg:entry.pkg,process:entry.process},[channel.port2]);});
    }
    const first=await workerSnapshots(broker.processes()),second=await workerSnapshots(broker.processes());
    const profiles=await workerAotProfiles(broker.processes());
    const profileFailure=(pid:number)=>{const row=profiles.find(row=>row.pid===pid)!;return 'error' in row?row.error:null;};
    broker.activities.setForeground(8405);
    const blocked=await visibleWorkerProcesses(broker,30);
    const stillBlocked=await visibleWorkersAlive(broker,30);
    broker.activities.setForeground(8401);
    const live=await visibleWorkersAlive(broker,1000);
    const count=await new Promise<{hungCalls:number;aliveCalls:number}>(resolve=>{worker.onmessage=({data})=>resolve(data);worker.postMessage({count:true});});
    const hanging=broker.entry(8403);
    const held=workerSnapshots([hanging]);
    const publish=callProxy<BrokerCalls>(broker.brokerPort(hanging.pid),brokerMethods);clients.push(publish);
    const died=new Promise<void>(resolve=>broker.watch(hanging.pid,()=>resolve()));
    void Promise.resolve(publish.endpoint.processExited({pid:9999,uid:0,pkg:"foreign",process:"foreign",reason:1,status:0,
      importance:400,timestamp:Date.now(),description:null,state:null,tombstone:null,dialog:false})).catch(()=>{});
    await died;
    const terminal=(await held)[0].terminal!;
    const pendingTerminal={expected:terminal.expected,reason:terminal.record!.reason,status:terminal.record!.status,pid:terminal.record!.pid};
    broker.fail(8401,"actual diagnostic fixture exit",NOT_CRASHED);
    const ended=await workerSnapshots(broker.processes());
    const row=(rows:typeof first,pid:number)=>rows.find(row=>row.pid===pid)!;
    const failure=(rows:typeof first,pid:number)=>{const value=row(rows,pid);return 'error' in value?value.error:null;};
    const healthy=row(first,8401);
    return {pendingTerminal,healthy:'snapshot' in healthy,rejected:failure(first,8402),hung:failure(first,8403),
      phase:failure(first,8404),profilePending:profileFailure(8404),profileIdentity:profileFailure(8405),secondHealthy:'snapshot' in row(second,8401),hungCalls:count.hungCalls,
      queueBlocked:'snapshot' in blocked[0] && !blocked[0].alive && !stillBlocked,live,aliveCalls:count.aliveCalls,
      retained:failure(ended,8401),identity:'snapshot' in healthy?healthy.snapshot.identity.pid:null};
  } finally {
    broker.activities.setForeground(foreground);
    for(const pid of pids)broker.fail(pid,"diagnostic fixture cleanup",NOT_CRASHED);
    clients.forEach(client=>client.close());worker.terminate();packages.delete(pkg);
  }
}

export async function imeOwnership() {
  const canvas = document.createElement("canvas"); document.body.append(canvas);
  const input = new MessageChannel(), view = new MessageChannel(), calls = callProxy<InputCalls>(input.port1,inputMethods);
  const owner = receiveIme(view.port1,canvas,calls.endpoint), inputs:string[]=[];
  let entered!:()=>void; const first = new Promise<void>(resolve=>entered=resolve);
  const worker=fixtureWorker("ime");
  worker.onmessage=({data})=>{if(data.input){inputs.push(data.input);if(data.input==='a')entered();}};
  const wait = async (ready:()=>boolean) => {const until=performance.now()+2000;while(!ready()){if(performance.now()>until)throw new Error("IME core deadline");await new Promise(resolve=>setTimeout(resolve,0));}};
  try {
    const forwarded=structuredClone({input:input.port2,view:view.port2},{transfer:[input.port2,view.port2]});
    worker.postMessage(forwarded,[forwarded.input,forwarded.view]);
    await wait(()=>!owner.input.disabled);
    const edit=(text:string)=>{owner.input.value=text;owner.input.setSelectionRange(text.length,text.length);owner.input.dispatchEvent(new InputEvent("input",{isComposing:false}));};
    edit("a");await first;edit("ab");edit("abc");worker.postMessage({kind:"release"});
    await wait(()=>inputs.length===2&&owner.input.value==="abc");
    worker.postMessage({kind:"switch"});await wait(()=>owner.input.value==="new editor");
    const switched=owner.input.value;
    worker.postMessage({kind:"hide"});await wait(()=>owner.input.disabled);
    const inactive=owner.input.disabled;
    owner.close();edit("closed");await new Promise(resolve=>setTimeout(resolve,0));
    return {inputs,switched,inactive,closed:!owner.input.isConnected};
  }finally{owner.close();calls.close();worker.terminate();canvas.remove();}
}
