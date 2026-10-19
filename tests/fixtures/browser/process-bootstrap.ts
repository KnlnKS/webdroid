import { processBroker, brokerMethods, type BrokerCalls, type ProcessBroker } from "../../../src/shell/processes.ts";
import { packages, PackageRecord } from "../../../src/android/packages.ts";
import { Resources } from "../../../src/android/res.ts";
import { TV } from "../../../src/android/axml.ts";
import { vfs } from "../../../src/shell/vfs.ts";
import { packedArchives } from "../../../src/shell/packedarchive.ts";
import { RemoteFile } from "../../../src/shell/remote-file.ts";
import { bootstrapTransfers } from "../../../src/shell/process-bootstrap-data.ts";
import { guestClockControl, setSystemTimeout, wallMillis, bootTime, createGuestClockPort } from "../../../src/guest-clock.ts";
import { callProxy } from "../../../src/shell/process-port.ts";
import { sendFrames } from "../../../src/shell/frame-port.ts";
import { attachPointerInput } from "../../../src/shell/pointer-input.ts";
import { receiveIme } from "../../../src/shell/ime-port.ts";
import { workerControlMethods } from "../../../src/shell/worker-control-methods.ts";
import { NOT_CRASHED, recordRemoteExit } from "../../../src/android/server/appexitinfo.ts";
import { fixtureUrl, fixtureWorker, stubEndpoint, type BrokerInit, type LocationControl, type PointerCalls } from "./fixture-calls.ts";

const failed = (reply: unknown) => !!(reply as { error?: string } | null)?.error;
type ClientEvent = { changed?: true; accountsChanged?: true; setting?: [string, string] };
/** a client fixture Worker calling the broker as `pid`: `ask` answers a call's value, or `{error}` with its
 *  message; given `events`, the Worker serves `pid`'s endpoint and reports its notifications there */
function brokerWorker(broker: ProcessBroker, pid: number, events?: (event: ClientEvent) => void) {
  const worker = fixtureWorker("client"), waiting = new Map<number, (value: unknown) => void>();
  let next = 1, ready!: () => void;
  const started = new Promise<void>(resolve => ready = resolve);
  worker.onmessage = ({ data }) => {
    if (data.ready) ready();
    else if ("id" in data) { waiting.get(data.id)!("error" in data ? { error: data.error } : data.value); waiting.delete(data.id); }
    else events?.(data);
  };
  const port = broker.brokerPort(pid), endpoint = events && new MessageChannel();
  worker.postMessage({ broker: port, methods: brokerMethods, endpoint: endpoint?.port1 } satisfies BrokerInit & { endpoint?: MessagePort },
    endpoint ? [port, endpoint.port1] : [port]);
  if (endpoint) broker.readyPort(pid, endpoint.port2);
  const ask = (method: keyof BrokerCalls | "write", ...args: unknown[]) => started.then(() => new Promise<unknown>(resolve => {
    const id = next++;
    waiting.set(id, resolve);
    worker.postMessage({ id, method, args });
  }));
  return { ask, worker };
}

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
  const watchClock = (data: Awaited<ReturnType<typeof broker.bootstrap>>) => {
    if (!data.broker) throw new Error("expected command capability");
    callers.push(callProxy<BrokerCalls>(data.broker,brokerMethods));
    if (!data.display) throw new Error("expected display capability");
    displays.push(new Promise<void>(resolve => data.display!.addEventListener("message",({data})=>{if(data.kind==="close")resolve();})));
    sendFrames(data.display, data.screen);
  };
  const ownerOne=broker.connect("test.archive.one", "test.archive.one", 7001),ownerTwo=broker.connect("test.archive.two", "test.archive.two", 7002);
  // each bootstrap hands its process the canvas it presents to
  const bootstrap = (owner: typeof ownerOne) => { owner.canvas=document.createElement("canvas"); return broker.bootstrap(owner.pid); };
  const file = (data: Awaited<ReturnType<typeof broker.bootstrap>>) => {
    watchClock(data);
    const source = data.registry[0].source;
    if (!("port" in source)) throw new Error("expected lazy archive port");
    return new RemoteFile(source);
  };
  const first = file(await bootstrap(ownerOne)), other = file(await bootstrap(ownerTwo));
  const firstIme=ownerOne.ime!,otherIme=ownerTwo.ime!;
  const eagerReads = reads;
  const replacement = file(await bootstrap(ownerOne));
  const replacementIme=ownerOne.ime!;
  const imeReplaced=firstIme!==replacementIme && !firstIme.input.isConnected;
  const superseded = await first.read(0, 1).catch(error => error.message);
  // A failed handoff must dispose its new exports while retaining the published owner set.
  const clone = globalThis.structuredClone;
  const unpublished: RemoteFile[] = [];
  let failed = false;
  try {
    globalThis.structuredClone = value => {
      const data = value as Awaited<ReturnType<typeof broker.bootstrap>>;
      watchClock(data);
      for (const record of data.registry) if ("port" in record.source) unpublished.push(new RemoteFile(record.source));
      throw new DOMException("handoff failed", "DataCloneError");
    };
    await bootstrap(ownerOne);
  } catch (error) { failed = error instanceof DOMException && error.name === "DataCloneError"; }
  finally { globalThis.structuredClone = clone; }
  const discarded = await Promise.all(unpublished.map(file => file.read(0, 1).catch(error => error.message)));
  const retained = Array.from(await replacement.read(0, 1));
  const imeRetained=ownerOne.ime===replacementIme && replacementIme.input.isConnected;
  const pending = replacement.read(7, 1).catch(error => error.message);
  await waiting;
  broker.fail(7001, "fixture process exit", NOT_CRASHED);
  const ended = await pending;
  const imeDeadClosed=!replacementIme.input.isConnected,imePeerSurvives=otherIme.input.isConnected;
  const isolated = Array.from(await other.read(0, 1));
  broker.fail(7002, "fixture process exit", NOT_CRASHED);
  await Promise.all(displays);
  const callersClosed = (await Promise.all(callers.map(client=>client.endpoint.clipboardGet().then(()=>false,()=>true)))).every(Boolean);
  packages.clear(); packedArchives.clear();
  return { imeOwners:{replaced:imeReplaced,retained:imeRetained,deadClosed:imeDeadClosed,peerSurvives:imePeerSurvives},eagerReads, superseded, failed, discarded, retained, ended, isolated, callersClosed, displaysClosed:displays.length };
}

export async function endpointOwnership() {
  const broker = processBroker();
  const names = ["test.endpoint.one", "test.endpoint.two"];
  const entries = names.map((pkg, i) => {
    const root = { name: "manifest", attrs: [{ ns: "", name: "package", resId: 0, type: TV.STRING, data: 0, str: pkg }], children: [] };
    packages.set(pkg, new PackageRecord(root, new Resources(null, {}), `/data/app/${pkg}/base.apk`, 13000 + i, async () => []));
    return broker.connect(pkg, pkg, 8001 + i);
  });
  let entered!: () => void, killed = false, removed = false;
  const waiting = new Promise<void>(resolve => entered = resolve);
  const endpoint = (pid: number) => stubEndpoint({
    transact: async (request, caller) => {
      if (request.code === 2) { await other.clipboardChanged(); return {handled:caller.pid,data:{bytes:Uint8Array.of(caller.uid & 255),objects:[]}}; }
      if (request.code === 3) {
        const right=request.data.objects[0]?.[1];
        if(!right || !("descriptor" in right))throw new Error("missing driver FD right");
        const owner=callProxy<BrokerCalls>(broker.brokerPort(pid),brokerMethods);
        try {
          const read=await owner.endpoint.fileDescriptor({kind:"read",fd:right.descriptor,length:1});
          await owner.endpoint.fileDescriptor({kind:"pwrite",fd:right.descriptor,offset:0,bytes:Uint8Array.of(77)});
          await owner.endpoint.fileDescriptor({kind:"seek",fd:right.descriptor,offset:0,whence:0});
          const stage=await owner.endpoint.fileDescriptor({kind:"stage",fd:right.descriptor});
          await owner.endpoint.fileDescriptor({kind:"close",fd:right.descriptor});
          return {handled:read.bytes![0],data:{bytes:new Uint8Array(0),objects:[[0,{descriptor:stage.result}]]}};
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
  const victim=broker.connect(names[1],names[1]+":signal",8003);
  broker.ready(victim.pid,{...endpoint(victim.pid),kill:()=>broker.fail(victim.pid,"fixture signal delivered",NOT_CRASHED)});
  await other.service({...request,intent:{bytes:Uint8Array.of(49),objects:[]}});
  const signalOwn = !broker.alive(8003), signalForeign = broker.alive(8001);
  await broker.forceStop(names[0]);
  const pendingCause = await pending;
  const lifeDead=await other.service({...request,intent:{bytes:Uint8Array.of(48),objects:[]}});
  const cleanupPort=callProxy<BrokerCalls>(broker.brokerPort(8002),brokerMethods);
  await cleanupPort.endpoint.processWatch(8002,1);
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

/** Real Worker CookieManager commands share the page's WebView jar and survive a sibling's death. */
export async function cookieOwnership() {
  const broker = processBroker(), pkg = "test.cookies.shared", isolated = "test.cookies.other";
  for (const [i, name] of [pkg, isolated].entries()) {
    const root = {name:"manifest",attrs:[{ns:"",name:"package",resId:0,type:TV.STRING,data:0,str:name}],children:[]};
    packages.set(name, new PackageRecord(root, new Resources(null, {}), `/data/app/${name}/base.apk`, 14000 + i, async () => []));
  }
  for (const [i, name] of [pkg, pkg, isolated].entries()) broker.connect(name, name + ":" + i, 8101 + i);
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
    const document = jar.document(url).map(cookie => cookie.text);
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
    return {session, persisted, read, isolatedRead, document, accept, denied, removed, afterSession, saved,
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
  const entry = broker.connect(pkg, pkg, pid);entry.canvas=document.createElement("canvas");
  const clock = createGuestClockPort(pid);
  broker.watch(pid, clock.close);
  const data = await broker.bootstrap(pid), start = guestClockControl.now(), wall = wallMillis();
  const url = fixtureUrl("clock"), worker = new Worker(url, {type:"module"}), workers=[worker];
  entry.workerDiagnostic={url};
  const ticks: {tick:string;now:number;wall?:number}[] = [];
  try {
    const ready = await new Promise<{display:boolean;archive:number[];controlled:boolean;bootTime:number;identity:(number|string)[];commands:{cookies:boolean;clipboard:unknown}}>((resolve,reject) => {
      worker.onerror = event => reject(new Error(event.message));
      worker.onmessage = ({data}) => { if(data.ready) {broker.readyPort(pid,data.endpoint);resolve(data);} else ticks.push(data); };
      worker.postMessage({clock:clock.data}, [clock.data.port!]);
      worker.postMessage(data, bootstrapTransfers(data));
    });
    let brokerTimer = 0;
    setSystemTimeout(()=>brokerTimer++,20);
    const incoming = await entry.ready;
    await incoming.settingsChanged("global","worker_endpoint_probe");
    await incoming.packageRemoved("worker.endpoint.absent.package");
    const advanced = await guestClockControl.advanceBy(10), pendingBeforeDeath = guestClockControl.pending();
    const previous = {pid:8199,uid:15000,process:pkg,pkg,reason:4,status:0,importance:400,timestamp:wall,
      description:"crash",state:null,tombstone:null,dialog:false};
    recordRemoteExit(previous);
    const survivor = broker.connect(pkg,pkg+":reader",8202);
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
    const crashRow=(await broker.workerSnapshots()).find(row=>row.pid===pid)!;
    const fatal=crashRow.terminal!.record!.crash!;
    const crash={expected:crashRow.terminal?.expected,reason:crashRow.terminal?.record?.reason,error:"error" in crashRow,fatal:{...fatal},copied:false};
    fatal.exceptionMessage="changed terminal copy";
    crash.copied=(await broker.workerSnapshots()).find(row=>row.pid===pid)!.terminal!.record!.crash!.exceptionMessage==="fatal fixture";
    const terminals=[];
    for(const [i,status] of [0,7,null].entries()) {
      const nextPid=8203+i,next=broker.connect(pkg,pkg+":"+nextPid,nextPid);
      next.workerDiagnostic={url};next.canvas=document.createElement("canvas");
      const nextData=await broker.bootstrap(nextPid),peer=new Worker(url,{type:"module"});workers.push(peer);
      await new Promise<void>((resolve,reject)=>{
        peer.onerror=event=>reject(new Error(event.message));
        peer.onmessage=({data})=>{if(data.ready){broker.readyPort(nextPid,data.endpoint);resolve();}};
        peer.postMessage(nextData,bootstrapTransfers(nextData));
      });
      const ended=new Promise<void>(resolve=>broker.watch(nextPid,()=>resolve()));
      if(status===null)await broker.forceStop(pkg);else peer.postMessage({finish:status});
      await ended;
      const row=(await broker.workerSnapshots()).find(row=>row.pid===nextPid)!;
      if(!row.terminal?.record)throw new Error("missing canonical terminal record");
      const record=row.terminal.record;
      const result={expected:row.terminal.expected,reason:record.reason,status:record.status,error:"error" in row,copied:false};
      record.status=99;
      result.copied=(await broker.workerSnapshots()).find(row=>row.pid===nextPid)!.terminal!.record!.status!==99;
      terminals.push(result);peer.terminate();
    }
    const pendingAfterDeath = guestClockControl.pending();
    await guestClockControl.advanceBy(10);
    return {crash,terminals,exit,display:ready.display,controlled:ready.controlled,archive:ready.archive,origin:ready.bootTime===bootTime,identity:ready.identity,commands:ready.commands,
      wall:ticks[0]?.wall===wall+10,uptime:ticks.every(tick=>tick.now===start+10),ticks:ticks.map(tick=>tick.tick),advanced,pendingBeforeDeath,pendingAfterDeath,
      brokerTimer,pendingAfterAdvance:guestClockControl.pending()};
  } finally { workers.forEach(peer=>peer.terminate());for(const nextPid of [8203,8204,8205])broker.fail(nextPid,"exit fixture cleanup",NOT_CRASHED);broker.fail(pid,"clock fixture cleanup",NOT_CRASHED); packages.delete(pkg); }
}

export async function clipboardOwnership() {
  const broker = processBroker(), pkg = "test.clipboard.shared", foreign = "test.clipboard.other";
  const fileHooks = {prepare:vfs.prepare,flush:vfs.flush,onWrite:vfs.onWrite};
  broker.files.attach(8302,vfs);
  for (const [i, name] of [pkg, foreign].entries()) {
    const root = {name:"manifest",attrs:[{ns:"",name:"package",resId:0,type:TV.STRING,data:0,str:name}],children:[]};
    packages.set(name,new PackageRecord(root,new Resources(null,{}),`/data/app/${name}/base.apk`,16000+i,async()=>[]));
  }
  const entries = [pkg,pkg,foreign].map((name,i)=>broker.connect(name,name+":"+i,8301+i));
  broker.activities.setForeground(8301);
  let peerChanges = 0, peerChanged!: () => void;
  broker.ready(8302,stubEndpoint({clipboardChanged:async()=>{peerChanges++;peerChanged?.();}})); broker.ready(8303,stubEndpoint());
  const peers = [8302,8303].map(pid=>callProxy<BrokerCalls>(broker.brokerPort(pid),brokerMethods));
  let changes=0,changed!:()=>void,settingChanged!:()=>void,accountChanged!:()=>void,accountChanges=0;
  const settingChanges: string[][] = [];
  const {ask,worker}=brokerWorker(broker,8301,event=>{
    if(event.changed){changes++;changed?.();}
    if(event.accountsChanged){accountChanges++;accountChanged?.();}
    if(event.setting){settingChanges.push(event.setting);settingChanged?.();}
  });
  try {
    await ask("clipboardListen",true);await peers[0].endpoint.clipboardListen(true);
    const notification=new Promise<void>(resolve=>changed=resolve),peerNotification=new Promise<void>(resolve=>peerChanged=resolve);
    const source=await ask("write");await Promise.all([notification,peerNotification]);
    const read=await peers[0].endpoint.clipboardGet();read!.bytes[0]=7;
    const fresh=await peers[0].endpoint.clipboardGet();
    const denied=await peers[1].endpoint.clipboardGet();
    broker.activities.setForeground(8303);const foreground=await peers[1].endpoint.clipboardGet();broker.activities.setForeground(8302);
    await ask("clipboardListen",false);
    const cleared=new Promise<void>(resolve=>peerChanged=resolve);
    await peers[0].endpoint.clipboardSet(null);await cleared;
    const absent=await ask("clipboardGet");
    const written=new Promise<void>(resolve=>peerChanged=resolve);await ask("write");await written;
    await ask("settingsGet","global","webdroid_worker_setting");
    const settingNotice=new Promise<void>(resolve=>settingChanged=resolve);
    const settingsWritten=await ask("settingsPut","global","webdroid_worker_setting","shared");
    await settingNotice;
    const settingsRead=await peers[0].endpoint.settingsGet("global","webdroid_worker_setting");
    const rows=await peers[0].endpoint.settingsEntries("global");
    rows.find(([name])=>name==="webdroid_worker_setting")![1]="copied";
    const sameKey=await ask("settingsSsaid")===await peers[0].endpoint.settingsSsaid();
    broker.accounts.add({name:"worker-account",type:"test.worker",owner:foreign,password:"private-password",
      data:{private:"data"},tokens:{session:"visible-token"},visibility:{[pkg]:1}});
    const query={type:"test.worker",pkg};
    const summaries=await ask("accountList",query) as {name:string,type:string,id:number,visibility:Record<string,number>}[];
    const key={name:summaries[0].name,type:summaries[0].type,id:summaries[0].id};
    const publicOnly=!Object.keys(summaries[0]).some(k=>["password","data","tokens"].includes(k));
    summaries[0].visibility[pkg]=4;
    const exists=await ask("accountExists",key),cached=await ask("accountCached",key,"session") as {token:string};
    const deniedRead=await ask("accountRead",key) as {error:string};
    const deniedWrite=await ask("accountChange",{kind:"password",key,value:"replacement"}) as {error:string};
    const accountNotice=new Promise<void>(resolve=>accountChanged=resolve);
    broker.accounts.records.find(s=>s.id===key.id)!.name="renamed-account";
    broker.accounts.persist();await accountNotice;
    const renamed=await ask("accountCached",key,"session") as {account:{name:string},token:string};
    const permission="android.permission.POST_NOTIFICATIONS", extra="android.permission.CAMERA";
    const before=await ask("permissionCheck",pkg,[permission]);
    await ask("permissionGrant",pkg,[permission]);
    const grantRead=await peers[0].endpoint.permissionCheck(pkg,[permission]);grantRead[0]=false;
    const own=await ask("permissionCheck",pkg,[permission]);
    const foreignDenied=await ask("permissionGrant",foreign,[permission]) as {error:string};
    packages.get(foreign)!.grants.add("android.permission.GRANT_RUNTIME_PERMISSIONS");
    await peers[1].endpoint.permissionGrant(pkg,[extra]);
    const privileged=await ask("permissionCheck",pkg,[extra]);
    const prefName = pkg + ":worker", policyName = "android:notification-policy:" + foreign;
    const prefAck = await ask("preferenceChange", prefName, [{kind:"put",key:"array",value:["one"]}]);
    await peers[0].endpoint.preferenceChange(prefName, [{kind:"put",key:"other",value:9n}]);
    const prefCopy = await ask("preferenceRead",prefName,"array") as string[]; prefCopy.push("local");
    const prefFresh = await peers[0].endpoint.preferenceRead(prefName,"array");
    const prefKeys = await ask("preferenceKeys",prefName) as string[];
    const foreignPref = await ask("preferenceChange",foreign+":private",[{kind:"put",key:"secret",value:1}]) as {error:string};
    const emptyForeign = await ask("preferenceFiles",foreign) as {error:string};
    broker.preferences.open(policyName).set("delegate",pkg);
    const publicPolicy = await ask("preferenceRead",policyName,"delegate");
    const policyWrite = await ask("preferenceChange",policyName,[{kind:"remove",key:"delegate"}]) as {error:string};
    const prefFiles = await ask("preferenceFiles",pkg) as [string,[string,unknown][]][];
    const prefs = {ack:prefAck,fresh:prefFresh,keys:prefKeys,foreignDenied:!!foreignPref.error,emptyForeignDenied:!!emptyForeign.error,
      publicPolicy,policyDenied:!!policyWrite.error,files:prefFiles.map(([name])=>name)};
    await ask("filePrepare",pkg);
    const directory=`/data/data/${pkg}/databases`;
    const made=await ask("fileMkdir",directory),repeated=await ask("fileMkdir",directory);
    const ownerStat=await peers[0].endpoint.fileStat(directory);
    const remoteStat=await ask("fileStat",directory) as {value:{uid:number,gid:number,mode:number}};
    const metadata = remoteStat.value.uid === packages.get(pkg)!.uid && remoteStat.value.gid === packages.get(pkg)!.uid && (remoteStat.value.mode & 0o7777) === 0o755;
    remoteStat.value.uid = 0;
    const retainedMetadata = (await peers[0].endpoint.fileStat(directory)).value?.uid === packages.get(pkg)!.uid;
    const changedMode = await ask("fileSetAttributes",directory,{mode:0o700}) === 0 && ((await peers[0].endpoint.fileStat(directory)).value!.mode & 0o7777) === 0o700;
    await broker.files.flush();
    const {PrivateFiles} = await import("../../../src/shell/privatefiles.ts");
    const restarted = new PrivateFiles(), hooks = {prepare:vfs.prepare,flush:vfs.flush,onWrite:vfs.onWrite};
    let restoredMetadata = false;
    try {
      vfs.metadata.delete(directory);restarted.attach(8399,vfs);await restarted.prepare(pkg);
      const restored = vfs.attributes(directory,true);
      restoredMetadata = restored.uid === packages.get(pkg)!.uid && restored.gid === packages.get(pkg)!.uid && restored.mode === 0o700;
    } finally {restarted.detach(8399);Object.assign(vfs,hooks);}
    const listed=await ask("fileList",`/data/data/${pkg}`) as {value:string[]};
    listed.value.length=0;
    const freshList=await peers[0].endpoint.fileList(`/data/data/${pkg}`);
    const foreignPath=await ask("fileMkdir",`/data/data/${foreign}/denied`);
    // Drain the notification endpoint before death, so cleanup is not racing its reply.
    await (await entries[1].ready).activity({kind:"back"});
    worker.terminate();broker.fail(8301,"clipboard Worker ended",NOT_CRASHED);
    const survivor=await peers[0].endpoint.clipboardGet();
    const settingsSurvivor=await peers[0].endpoint.settingsGet("global","webdroid_worker_setting");
    const accountSurvivor=await peers[0].endpoint.accountCached(key,"session");
    const changesBefore=accountChanges;broker.accounts.persist();
    await peers[0].endpoint.accountExists(key);
    const cleaned=accountChanges===changesBefore;
    return {prefs,paths:{made,repeated,directory:((ownerStat.value?.mode ?? 0) & 0o170000) === 0o040000,copied:freshList.value?.includes("databases"),foreignPath,metadata,retainedMetadata,changedMode,restoredMetadata},permissions:{before,own,foreignDenied:!!foreignDenied.error,privileged},accounts:{publicOnly,exists,token:cached.token,deniedRead:!!deniedRead.error,deniedWrite:!!deniedWrite.error,
      renamed:renamed.account.name,survivor:accountSurvivor?.account.name,changes:accountChanges,cleaned},source,fresh:Array.from(fresh!.bytes),denied,foreground:Array.from(foreground!.bytes),absent,
      changes,peerChanges,survivor:Array.from(survivor!.bytes),
      settings:{written:settingsWritten,read:settingsRead,sameKey,changes:settingChanges,survivor:settingsSurvivor}};
  }finally{
    for(const client of peers)client.close();worker.terminate();
    for(const pid of [8301,8302,8303])broker.fail(pid,"clipboard fixture cleanup",NOT_CRASHED);
    for (let i=broker.accounts.records.length-1;i>=0;i--)
      if(broker.accounts.records[i].type==="test.worker")broker.accounts.records.splice(i,1);
    broker.accounts.persist();
    for(const path of [...vfs.dirs])if(path.startsWith(`/data/data/${pkg}`)||path.startsWith(`/data/user_de/0/${pkg}`))vfs.rmdir(path);
    broker.preferences.remove(pkg); broker.preferences.delete("android:notification-policy:"+foreign);
    broker.permissions.clear(pkg);broker.permissions.clear(foreign);
    packages.delete(pkg);packages.delete(foreign);
    await broker.files.flush();Object.assign(vfs,fileHooks);
  }
}

export async function storedClipboardRights() {
  const broker=processBroker(),pkg="test.clipboard.rights",pids=[8401,8402],path=`/data/data/${pkg}/retained.bin`;
  const manifest={name:"manifest",attrs:[{ns:"",name:"package",resId:0,type:TV.STRING,data:0,str:pkg}],children:[]};
  packages.set(pkg,new PackageRecord(manifest,new Resources(null,{}),`/data/app/${pkg}/base.apk`,18000,async()=>[]));
  vfs.mkdir("/data/data");
  for(const pid of pids)broker.connect(pkg,pkg+":"+pid,pid);
  broker.activities.setForeground(8402);
  const reader=callProxy<BrokerCalls>(broker.brokerPort(8402),brokerMethods),{ask,worker}=brokerWorker(broker,8401);
  const imported:number[]=[];
  try {
    await ask("fileMkdir",`/data/data/${pkg}`);
    const fd=(await ask("fileDescriptor",{kind:"open",path,flags:0x42}) as {result:number}).result;
    if(fd<0)throw new Error("Stored clipboard open failed: "+fd);
    await ask("fileDescriptor",{kind:"write",fd,bytes:Uint8Array.of(1,2,3,4)});
    await ask("fileDescriptor",{kind:"seek",fd,offset:0,whence:0});
    const deniedStage=(await ask("fileDescriptor",{kind:"stage",fd}) as {result:number}).result;
    const denied=await ask("pendingCreate",pkg,"broadcast",0,0,{bytes:new Uint8Array(24),objects:[[0,{descriptor:deniedStage}]]}) as {error?:string};
    const retired=(await ask("fileDescriptor",{kind:"stat",fd:deniedStage}) as {result:number}).result < 0;
    const staged=(await ask("fileDescriptor",{kind:"stage",fd}) as {result:number}).result;
    const published=await ask("clipboardSet",{bytes:new Uint8Array(24),objects:[[0,{descriptor:staged}]]}) as {error?:string}|undefined;
    if(published?.error)throw new Error(published.error);
    const candidate=(await ask("fileDescriptor",{kind:"stage",fd}) as {result:number}).result;
    const failure=await ask("clipboardSet",{bytes:new Uint8Array(48),objects:[[0,{descriptor:candidate}],[24,{descriptor:-1}]]}) as {error?:string};
    const replacementRejected=failure.error==="Invalid retained Parcel descriptor" &&
      (await ask("fileDescriptor",{kind:"stat",fd:candidate}) as {result:number}).result < 0;
    const has=await reader.endpoint.clipboardHas(),reads:number[]=[];
    for(let i=0;i<2;i++) {
      const data=await reader.endpoint.clipboardGet(),right=data!.objects[0][1];
      if(!right || !("descriptor" in right))throw new Error("Missing retained clipboard right");
      imported.push(right.descriptor);await reader.endpoint.fileDescriptor({kind:"take",fd:right.descriptor});
      reads.push((await reader.endpoint.fileDescriptor({kind:"read",fd:right.descriptor,length:1})).bytes![0]);
    }
    worker.terminate();broker.fail(8401,"stored rights sender ended",NOT_CRASHED);
    const data=await reader.endpoint.clipboardGet(),right=data!.objects[0][1];
    if(!right || !("descriptor" in right))throw new Error("Retained clipboard lost on sender death");
    imported.push(right.descriptor);await reader.endpoint.fileDescriptor({kind:"take",fd:right.descriptor});
    reads.push((await reader.endpoint.fileDescriptor({kind:"read",fd:right.descriptor,length:1})).bytes![0]);
    await reader.endpoint.clipboardSet(null);
    reads.push((await reader.endpoint.fileDescriptor({kind:"read",fd:imported[0],length:1})).bytes![0]);
    await reader.endpoint.fileDescriptor({kind:"pwrite",fd:imported[0],offset:0,bytes:Uint8Array.of(9)});
    return {has,cleared:!(await reader.endpoint.clipboardHas()),reads,backing:[...vfs.read(path)!],replacementRejected,pendingRejected:denied.error==="File descriptors passed in Intent" && retired};
  } finally {
    for(const fd of imported)await reader.endpoint.fileDescriptor({kind:"close",fd});
    reader.close();worker.terminate();
    for(const pid of pids)broker.fail(pid,"stored clipboard fixture cleanup",NOT_CRASHED);
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
      const entry=broker.connect(pkg,pkg+":"+i,pids[i]),channel=new MessageChannel();
      const client=callProxy(channel.port1,workerControlMethods);clients.push(client);
      Object.assign(entry,{worker:{url:location.origin+"/process-worker.js?pid="+entry.pid,control:client.endpoint,close:client.close}});
      await new Promise<void>(resolve=>{worker.onmessage=()=>resolve();worker.postMessage({port:channel.port2,mode,pid:entry.pid,pkg:entry.pkg,process:entry.process},[channel.port2]);});
    }
    const first=await broker.workerSnapshots(),second=await broker.workerSnapshots();
    const profiles=await broker.workerAotProfiles();
    const profileFailure=(pid:number)=>{const row=profiles.find(row=>row.pid===pid)!;return 'error' in row?row.error:null;};
    broker.activities.setForeground(8405);
    const blocked=await broker.visibleWorkerProcesses(30);
    const stillBlocked=await broker.visibleWorkersAlive(30);
    broker.activities.setForeground(8401);
    const live=await broker.visibleWorkersAlive(1000);
    const count=await new Promise<{hungCalls:number;aliveCalls:number}>(resolve=>{worker.onmessage=({data})=>resolve(data);worker.postMessage({count:true});});
    const hanging=broker.connect(pkg,pkg+":2",8403);
    const held=broker.workerSnapshots([hanging]);
    const publish=callProxy<BrokerCalls>(broker.brokerPort(hanging.pid),brokerMethods);clients.push(publish);
    const died=new Promise<void>(resolve=>broker.watch(hanging.pid,()=>resolve()));
    void Promise.resolve(publish.endpoint.processExited({pid:9999,uid:0,pkg:"foreign",process:"foreign",reason:1,status:0,
      importance:400,timestamp:Date.now(),description:null,state:null,tombstone:null,dialog:false})).catch(()=>{});
    await died;
    const terminal=(await held)[0].terminal!;
    const pendingTerminal={expected:terminal.expected,reason:terminal.record!.reason,status:terminal.record!.status,pid:terminal.record!.pid};
    broker.fail(8401,"actual diagnostic fixture exit",NOT_CRASHED);
    const ended=await broker.workerSnapshots();
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

/** A real Worker owns callbacks; only copied fixes cross the canonical browser location owner. */
export async function locationOwnership() {
  const broker = processBroker(), pkg = "test.location.owner", other = "test.location.denied";
  for (const [i,name] of [pkg,other].entries()) {
    const root = {name:"manifest",attrs:[{ns:"",name:"package",resId:0,type:TV.STRING,data:0,str:name}],children:[]};
    packages.set(name,new PackageRecord(root,new Resources(null,{}),`/data/app/${name}/base.apk`,17000+i,async()=>[]));
  }
  broker.permissions.grant(pkg,["android.permission.ACCESS_FINE_LOCATION"]);
  const entry = broker.connect(pkg,pkg,8501), denied = broker.connect(other,other,8502), peer = broker.connect(pkg,pkg+":peer",8503);
  const oldGeo = Object.getOwnPropertyDescriptor(navigator,"geolocation");
  let watched: PositionCallback | undefined, cleared = 0;
  Object.defineProperty(navigator,"geolocation",{configurable:true,value:{
    watchPosition(success:PositionCallback){watched=success;return 71;},clearWatch(){cleared++;},
  }});
  const worker = fixtureWorker("location"), endpoint = new MessageChannel(), control = new MessageChannel();
  const client = callProxy<LocationControl>(control.port1,["subscribe","remove","read","events"]);
  const deniedClient = callProxy<BrokerCalls>(broker.brokerPort(denied.pid),brokerMethods,[],error=>Object.assign(new Error(error.message??""),{javaClass:error.javaClass}));
  const peerClient = callProxy<BrokerCalls>(broker.brokerPort(peer.pid),brokerMethods);
  let peerEvents = 0;
  broker.ready(peer.pid,stubEndpoint({locationChanged:async()=>{peerEvents++;}}));
  const emit = (latitude:number) => watched!({coords:{latitude,longitude:2,accuracy:3,altitude:null,altitudeAccuracy:null,heading:null,speed:null},timestamp:Date.now()} as GeolocationPosition);
  const waitEvents = async(count:number)=>{
    for(let i=0;i<30;i++){const events=await client.endpoint.events();if(events.length===count)return events;await new Promise(r=>setTimeout(r,5));}
    return client.endpoint.events();
  };
  try {
    const reverse = broker.brokerPort(entry.pid);
    worker.postMessage({broker:reverse,endpoint:endpoint.port1,control:control.port2},[reverse,endpoint.port1,control.port2]);
    broker.readyPort(entry.pid,endpoint.port2);
    const available = await peerClient.endpoint.locationAvailable();
    const deniedRead = await deniedClient.endpoint.locationLast().catch(error=>error.message==="Location permission denied");
    await client.endpoint.subscribe();emit(12);await waitEvents(1);
    const copy = await client.endpoint.read() as {latitude:number}; copy.latitude=99;
    const copied = broker.location.last?.latitude===12;
    await client.endpoint.subscribe();
    await (await entry.ready).locationChanged(41,1,{kind:"fix",fix:{...broker.location.last!,latitude:99}});
    emit(24);const events=await waitEvents(2),stale=events.join(",")==="12,24";
    await client.endpoint.remove();const removed=cleared===1;
    await peerClient.endpoint.locationSubscribe(1,1,false,true);
    await client.endpoint.subscribe();broker.fail(entry.pid,"location fixture death",NOT_CRASHED);
    emit(48);for(let i=0;i<30&&!peerEvents;i++)await new Promise(r=>setTimeout(r,5));
    const peerSurvives=peerEvents>0;
    broker.fail(peer.pid,"location peer death",NOT_CRASHED);
    return {available,denied:deniedRead,events,copied,stale,removed,peerSurvives,deathCloses:cleared===2};
  } finally {
    for(const pid of [8501,8502,8503])broker.fail(pid,"location fixture cleanup",NOT_CRASHED);
    client.close();deniedClient.close();peerClient.close();worker.terminate();broker.permissions.clear(pkg);
    if(oldGeo)Object.defineProperty(navigator,"geolocation",oldGeo);else Reflect.deleteProperty(navigator,"geolocation");
  }
}

export async function imeOwnership() {
  const canvas = document.createElement("canvas"); document.body.append(canvas);
  const port = new MessageChannel(), owner = receiveIme(port.port1,canvas), inputs:string[]=[];
  let entered!:()=>void; const first = new Promise<void>(resolve=>entered=resolve);
  const worker=fixtureWorker("ime");
  worker.onmessage=({data})=>{if(data.input){inputs.push(data.input);if(data.input==='a')entered();}};
  const wait = async (ready:()=>boolean) => {const until=performance.now()+2000;while(!ready()){if(performance.now()>until)throw new Error("IME core deadline");await new Promise(resolve=>setTimeout(resolve,0));}};
  try {
    const forwarded=structuredClone({port:port.port2},{transfer:[port.port2]});
    worker.postMessage(forwarded,[forwarded.port]);
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
  }finally{owner.close();worker.terminate();canvas.remove();}
}
