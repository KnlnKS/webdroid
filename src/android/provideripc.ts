import { JObj, rt } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { JUri, mkUri } from "./net";
import { JContentValues, mkCursor } from "./sqlite";
import { JBundle, mkPfd, parcelFileDescriptorData, writeParcelFileDescriptor } from "./os";
import { JParcel } from "./parcel";
import { exportParcel, importParcel, withCallingIdentity, type ParcelData, type Caller } from "./binder";
import { attachProvider, providerTransport, providerOperations } from "./contentresolver";
import { getPM } from "./pm";
import { appHost } from "./apphost";

type Value = { kind: "uri"; value: string } | { kind: "values" | "value"; data: ParcelData }
  | { kind: "pfd"; bytes: Uint8Array; token: number | null; closed?: boolean };
export type ProviderRequest = { authority: string; name: string; desc: string; args: Value[]; access?: "read" | "write" };
export type ProviderReply = { kind: "cursor"; columns: string[]; rows: Value[][] } | { kind: "value"; value: Value };
type ProviderCall = (pkg: string, process: string, request: ProviderRequest) => Promise<ProviderReply>;
export async function encodeProviderValue(value: unknown): Promise<Value> {
  if (value instanceof JUri) return { kind: "uri", value: value.uri };
  const pfd = parcelFileDescriptorData(value);
  if (pfd) return { kind: "pfd", bytes: pfd.bytes, token: null };
  const p = new JParcel(), values = value instanceof JContentValues;
  if (value instanceof JContentValues) { const bundle = new JBundle(); bundle.map = new Map([...value.data.m.values()].map((e) => [String(e.k), e.v])); value = bundle; }
  await vcall(p, "writeValue", "(Ljava/lang/Object;)V", value);
  return { kind: values ? "values" : "value", data: exportParcel(p) };
}
export async function decodeProviderValue(value: Value, writeback: ((bytes: Uint8Array, closed?: boolean) => unknown) | null = null): Promise<unknown> {
  if (value.kind === "uri") return mkUri(value.value);
  if (value.kind === "pfd") return mkPfd(value.bytes.slice(), writeback);
  const decoded: unknown = await vcall(importParcel(value.data), "readValue", "(Ljava/lang/ClassLoader;)Ljava/lang/Object;", null);
  if (value.kind !== "values") return decoded;
  if (!(decoded instanceof JBundle)) throw rt.mkThrowable("android/os/BadParcelableException", "Expected ContentValues");
  const values = new JContentValues(); values.data.m = new Map([...decoded.map].map(([k, v]) => [k, { k, v }])); return values;
}
class JRemoteProvider extends JObj { pkg = ""; process = ""; authority = ""; call!: ProviderCall; }
rt.register({ name: "webdroid/RemoteContentProvider", ctor: JRemoteProvider, methods: Object.fromEntries(Object.entries(providerOperations).map(([name, desc]) => [name + desc,
  async function (this: JRemoteProvider, ...args: unknown[]) {
    const access = name === "openFile" ? (typeof args[1] === "string" && args[1].includes("w") ? "write" : "read") : undefined;
    const result = await this.call(this.pkg, this.process, { authority: this.authority, name, desc, args: await Promise.all(args.map(encodeProviderValue)), access });
    if (result.kind === "value") {
      const encoded = result.value;
      const remote = encoded.kind === "pfd" && encoded.token !== null
        ? (bytes: Uint8Array, closed?: boolean) => this.call(this.pkg, this.process, { authority: this.authority, name: "$writeFile", desc: "", args: [{ kind: "pfd", token: encoded.token, bytes, closed }], access: "write" })
        : null;
      const value = await decodeProviderValue(result.value, remote);
      return desc.endsWith("I") && value instanceof JObj && "v" in value ? value.v : value;
    }
    return mkCursor(result.columns, await Promise.all(result.rows.map((row) => Promise.all(row.map((value) => decodeProviderValue(value))))));
  },
])) });
export function connectProviders(call: ProviderCall): void {
  providerTransport.acquire = async (info) => {
    rt.link("webdroid/RemoteContentProvider");
    const provider = new JRemoteProvider(); provider.pkg = info.packageName; provider.process = info.processName ?? info.packageName;
    provider.authority = info.authority.split(";")[0]; provider.call = call; return provider;
  };
}
let nextFileToken = 1;
const openFiles = new Map<number, { descriptor: unknown; callerPid: number; authority: string }>();
export async function receiveProvider(request: ProviderRequest, caller: Caller): Promise<ProviderReply> {
  if (request.name === "$writeFile") {
    const value = request.args[0];
    if (value?.kind !== "pfd" || value.token === null) throw rt.mkThrowable("java/lang/SecurityException", "Invalid provider file token");
    const opened = openFiles.get(value.token);
    if (!opened || opened.callerPid !== caller.pid || opened.authority !== request.authority) throw rt.mkThrowable("java/lang/SecurityException", "Invalid provider file token");
    await writeParcelFileDescriptor(opened.descriptor, value.bytes, value.closed);
    if (value.closed) openFiles.delete(value.token);
    return { kind: "value", value: await encodeProviderValue(null) };
  }
  if (!Object.entries(providerOperations).some(([name, desc]) => name === request.name && desc === request.desc)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown provider operation");
  const info = await vcall(getPM(), "resolveContentProvider", "(Ljava/lang/String;I)Landroid/content/pm/ProviderInfo;", request.authority, 128);
  const host = appHost;
  if (!info || !host?.application || info.packageName !== host.pkg) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Provider unavailable: " + request.authority);
  if (!info.exported && info.applicationInfo.uid !== caller.uid) throw rt.mkThrowable("java/lang/SecurityException", "Provider is not exported");
  const provider = await attachProvider(host.application, info);
  const args = await Promise.all(request.args.map(value => decodeProviderValue(value)));
  return withCallingIdentity(caller, async () => {
    const value = await vcall(provider, request.name, request.desc, ...args);
    if (request.name !== "query" || !value) {
      const encoded = await encodeProviderValue(value);
      if (request.name === "openFile" && encoded.kind === "pfd" && parcelFileDescriptorData(value)?.writable) {
        encoded.token = nextFileToken++;
        openFiles.set(encoded.token, { descriptor: value, callerPid: caller.pid, authority: request.authority });
      }
      return { kind: "value", value: encoded };
    }
    const columns: string[] = await vcall(value, "getColumnNames", "()[Ljava/lang/String;"), rows: Value[][] = [];
    try {
      while (await vcall(value, "moveToNext", "()Z")) {
        const row: Value[] = [];
        for (let i = 0; i < columns.length; i++) {
          const type = await vcall(value, "getType", "(I)I", i);
          const cell = type === 0 ? null : type === 1 ? await vcall(value, "getLong", "(I)J", i) : type === 2 ? await vcall(value, "getDouble", "(I)D", i)
            : type === 4 ? await vcall(value, "getBlob", "(I)[B", i) : await vcall(value, "getString", "(I)Ljava/lang/String;", i);
          row.push(await encodeProviderValue(cell));
        }
        rows.push(row);
      }
    } finally { await vcall(value, "close", "()V"); }
    return { kind: "cursor", columns: [...columns], rows };
  });
}
