// bun tests/fixtures/remote-provider.ts: another process's provider as the
// activity manager hands it out and AOSP's ContentProviderProxy reaches it, as one JSON object. The
// "other process" is this realm behind a loopback binder transport that renames its binders' pid.
const W = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
await import(W + "/tests/platform");
const { rt, JObj, declaredField } = await import(W + "/src/jvm/runtime");
await import(W + "/src/natives");
const { newObj, vcall } = await import(W + "/src/jvm/natives/jlang");
const { setAppHost } = await import(W + "/src/android/apphost");
const { testAppHost, loadPlatform } = await import(W + "/tests/java");
const { packages, PackageRecord, packageUid } = await import(W + "/src/android/packages");
const { Resources } = await import(W + "/src/android/res");
const { TV } = await import(W + "/src/android/axml");
const { setProcessIdentity, setProcessName, mkPfd, parcelFileDescriptorData, writeParcelFileDescriptor } = await import(W + "/src/android/os");
const { hostedService, binderTransport, receiveTransaction, importBinder, exportBinder } = await import(W + "/src/android/binder");
const { providerProcesses } = await import(W + "/src/android/server/am");
const { mkUri } = await import(W + "/src/android/net");
const { startMainLooper } = await import(W + "/src/android/mainloop");
const { box } = await import(W + "/src/jvm/natives/jbox");
type JObj = InstanceType<typeof JObj>;
type Handle = { pid: number; id: number };
type Data = { bytes: Uint8Array; objects: [number, Handle | { bytes: Uint8Array; writer: Handle | null } | null][] };
console.warn = () => {};

const CLIENT = "org.webdroid.test.client", OWNER = "org.webdroid.test.owner", AUTHORITY = OWNER + ".data", HERE = 4322, REMOTE = 4400;
const attr = (name: string, str: string | null, data = 0) => ({ name, str, ns: "", resId: 0, type: str === null ? TV.INT_DEC : TV.STRING, data });
const manifest = (pkg: string, providers: { name: string; attrs: ReturnType<typeof attr>[]; children: [] }[]) => ({ name: "manifest", attrs: [attr("package", pkg)], children: [
  { name: "uses-sdk", attrs: [attr("minSdkVersion", null, 21), attr("targetSdkVersion", null, 35)], children: [] },
  { name: "application", attrs: [], children: providers },
] });
const install = (pkg: string, providers: Parameters<typeof manifest>[1] = []) => {
  const record = new PackageRecord(manifest(pkg, providers) as never, new Resources(null, {}), `/${pkg}.apk`, packageUid(pkg), async () => [new Uint8Array([1])]);
  packages.set(pkg, record);
  return record;
};
const S = "Ljava/lang/String;", AS = "Landroid/content/AttributionSource;", URI = "Landroid/net/Uri;", SIGNAL = "Landroid/os/ICancellationSignal;";

const written: string[] = [];
rt.register({ name: "webdroid/test/Provider", ctor: class extends JObj {}, sup: "android/content/ContentProviderNative", methods: {
  "getProviderName()Ljava/lang/String;": () => OWNER + ".Data",
  [`query(${AS}${URI}[${S}Landroid/os/Bundle;${SIGNAL})Landroid/database/Cursor;`]: async () => {
    const cursor = await newObj("android/database/MatrixCursor", `([${S})V`, ["key", "value"]);
    for (const row of [["a", 1n], ["b", null]]) await vcall(cursor, "addRow", "([Ljava/lang/Object;)V", row.map((v) => typeof v === "bigint" ? box("J", v) : v));
    return cursor;
  },
  [`openFile(${AS}${URI}${S}${SIGNAL})Landroid/os/ParcelFileDescriptor;`]: () =>
    mkPfd(new TextEncoder().encode("hello"), (bytes: Uint8Array, closed?: boolean) => { written.push(`${new TextDecoder().decode(bytes)} ${!!closed}`); }),
} });

rt.linkNatives();
// framework-res: CursorWindow sizes itself from Resources.getSystem()
await loadPlatform();
await startMainLooper();
const client = install(CLIENT), owner = install(OWNER, [{ name: "provider", attrs: [attr("name", ".Data"), attr("authorities", AUTHORITY), attr("exported", "true")], children: [] }]);
setProcessIdentity(HERE, client.uid); setProcessName(CLIENT);
setAppHost(testAppHost(client));

// the owner's process: its published binder, reached through the broker's transport with the
// caller's identity; binders it hands back are its own, so they cross as REMOTE's
const rename = (data: Data, from: number, to: number): Data => {
  const swap = (h: Handle | null) => h && h.pid === from ? { ...h, pid: to } : h;
  return { ...data, objects: data.objects.map(([at, o]) => [at, o && "bytes" in o ? { ...o, writer: swap(o.writer) } : swap(o)]) };
};
binderTransport.alive = () => true;
binderTransport.transact = async (request: { handle: Handle; code: number; flags: number; data: Data }) => {
  const reply = await receiveTransaction({ ...request, handle: { pid: HERE, id: request.handle.id }, data: rename(request.data, REMOTE, HERE) }, { pid: HERE, uid: client.uid });
  return { ...reply, data: rename(reply.data, HERE, REMOTE) };
};
const provider = await newObj("webdroid/test/Provider");
const asked: string[] = [];
providerProcesses.get = async (pkg: string, process: string, authority: string) => {
  asked.push(`${pkg} ${process} ${authority}`);
  return importBinder({ pid: REMOTE, id: exportBinder(provider)!.id });
};

const am = await hostedService("activity") as JObj, out: Record<string, unknown> = { owner: owner.uid !== client.uid };
const holder = await vcall(am, "getContentProvider", `(Landroid/app/IApplicationThread;${S}${S}IZ)Landroid/app/ContentProviderHolder;`, null, CLIENT, AUTHORITY, 0, 1);
const remote = Reflect.get(holder, declaredField("android/app/ContentProviderHolder", "provider")) as JObj;
out.asked = asked;
out.proxy = (remote.constructor as { $i?: { name: string } }).$i?.name;
const source = await newObj("android/content/AttributionSource", "(IILjava/lang/String;Ljava/lang/String;)V", client.uid, HERE, CLIENT, null);
const uri = await mkUri(`content://${AUTHORITY}/rows`);

// the rows cross in a CursorWindow beside an IBulkCursor binder
const cursor = await vcall(remote, "query", `(${AS}${URI}[${S}Landroid/os/Bundle;${SIGNAL})Landroid/database/Cursor;`, source, uri, null, null, null);
const rows: unknown[] = [];
while (await vcall(cursor, "moveToNext", "()Z")) rows.push([await vcall(cursor, "getString", `(I)${S}`, 0), await vcall(cursor, "isNull", "(I)Z", 1) ? null : await vcall(cursor, "getLong", "(I)J", 1)].map(String));
out.columns = [...await vcall(cursor, "getColumnNames", `()[${S}`) as string[]];
out.rows = rows;
await vcall(cursor, "close", "()V");

// a writable descriptor crosses as its bytes, and its writes return to the provider's on close
const pfd = await vcall(remote, "openFile", `(${AS}${URI}${S}${SIGNAL})Landroid/os/ParcelFileDescriptor;`, source, uri, "rw", null);
out.read = new TextDecoder().decode(parcelFileDescriptorData(pfd)!.bytes);
await writeParcelFileDescriptor(pfd, new TextEncoder().encode("bye"));
await vcall(pfd, "close", "()V");
out.written = written;
console.log(JSON.stringify(out));
process.exit(0);
