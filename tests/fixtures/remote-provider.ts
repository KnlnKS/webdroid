// pnpm ts tests/fixtures/remote-provider.ts: another process's provider as the
// activity manager hands it out and AOSP's ContentProviderProxy reaches it, as one JSON object. The
// "other process" is this realm behind a loopback binder transport that renames its binders' pid.
import "../../tests/platform.ts";
import "../../src/natives.ts";
import { rt, JObj, declaredField } from "../../src/jvm/runtime.ts";
import { classNameOf, newObj, vcall, scall } from "../../src/jvm/natives/jentry.ts";
import { setAppHost } from "../../src/android/apphost.ts";
import { testAppHost, fixtureDeadline, loadPlatform } from "../../tests/java.ts";
import { packages, PackageRecord, packageUid } from "../../src/android/packages.ts";
import { emptyApk } from "../../src/android/res.ts";
import { TV } from "../../src/android/axml.ts";
import { setProcessIdentity, setProcessName, mkPfd, pfdContents } from "../../src/android/os.ts";
import { hostedService, binderTransport, receiveTransaction, importBinder, exportBinder, type ParcelData } from "../../src/android/binder.ts";
import { providerProcesses } from "../../src/android/server/am.ts";
import { mkUri } from "../../src/android/net.ts";
import { startMainLooper } from "../../src/android/mainloop.ts";
import { box } from "../../src/jvm/natives/jbox.ts";
console.warn = () => {};
fixtureDeadline();

const CLIENT = "org.webdroid.test.client", OWNER = "org.webdroid.test.owner", AUTHORITY = OWNER + ".data", HERE = 4322, REMOTE = 4400;
const attr = (name: string, str: string | null, data = 0) => ({ name, str, ns: "", resId: 0, type: str === null ? TV.INT_DEC : TV.STRING, data });
const manifest = (pkg: string, providers: { name: string; attrs: ReturnType<typeof attr>[]; children: [] }[]) => ({ name: "manifest", attrs: [attr("package", pkg)], children: [
  { name: "uses-sdk", attrs: [attr("minSdkVersion", null, 21), attr("targetSdkVersion", null, 35)], children: [] },
  { name: "application", attrs: [], children: providers },
] });
const install = (pkg: string, providers: Parameters<typeof manifest>[1] = []) => {
  const record = new PackageRecord(manifest(pkg, providers) as never, emptyApk(), `/${pkg}.apk`, packageUid(pkg), async () => [new Uint8Array([1])]);
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
    mkPfd(new TextEncoder().encode("hello"), (bytes: Uint8Array) => { written.push(new TextDecoder().decode(bytes)); }),
} });

// framework-res: CursorWindow sizes itself from Resources.getSystem()
await loadPlatform();
await startMainLooper();
const client = install(CLIENT), owner = install(OWNER, [{ name: "provider", attrs: [attr("name", ".Data"), attr("authorities", AUTHORITY), attr("exported", "true")], children: [] }]);
setProcessIdentity(HERE, client.uid); setProcessName(CLIENT);
setAppHost(testAppHost(client));

// the owner's process: its published binder, reached through the broker's transport with the
// caller's identity; binders it hands back are its own, so they cross as REMOTE's
const rename = (data: ParcelData, from: number, to: number): ParcelData => {
  const swap = <T>(h: T): T => h && typeof h === "object" && "pid" in h && h.pid === from ? { ...h, pid: to } : h;
  return { ...data, objects: data.objects.map(([at, o]) => [at, o && "bytes" in o ? { ...o, writer: swap(o.writer) } : swap(o)]) };
};
binderTransport.alive = () => true;
binderTransport.transact = async (request: Parameters<typeof binderTransport.transact>[0]) => {
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
out.proxy = classNameOf(remote);
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
out.read = new TextDecoder().decode(await pfdContents(pfd) ?? undefined);
const fd = await vcall(pfd, "getFileDescriptor", "()Ljava/io/FileDescriptor;");
await scall("android/system/Os", "ftruncate", "(Ljava/io/FileDescriptor;J)V", fd, 0n);
await vcall(await newObj("java/io/FileOutputStream", "(Ljava/io/FileDescriptor;)V", fd), "write", "([B)V", Int8Array.from(new TextEncoder().encode("bye")));
await vcall(pfd, "close", "()V");
for (let tries = 0; !written.length && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
out.written = written;
console.log(JSON.stringify(out));
process.exit(0);
