import { JObj, rt } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { unbox } from "../jvm/natives/jbox";
import { JUri, mkUri } from "./net";
import { mkCursor } from "./sqlite";
import { mkPfd, parcelFileDescriptorData, writeParcelFileDescriptor } from "./os";
import { JParcel } from "./parcel";
import { exportParcel, importParcel, withCallingIdentity, type ParcelData, type Caller } from "./binder";
import { attachProvider, providerTransport, providerOperations } from "./contentresolver";
import { resolveProvider, exported, componentProcess, authoritiesOf } from "./pm";
import { appHost } from "./apphost";

type Value = { kind: "uri"; value: string } | { kind: "value"; data: ParcelData }
  | { kind: "pfd"; bytes: Uint8Array; token: number | null; closed?: boolean };
export type ProviderRequest = { authority: string; name: string; desc: string; args: Value[]; access?: "read" | "write" };
export type ProviderReply = { kind: "cursor"; columns: string[]; rows: Value[][] } | { kind: "value"; value: Value };
type ProviderCall = (pkg: string, process: string, request: ProviderRequest) => Promise<ProviderReply>;
export async function encodeProviderValue(value: unknown): Promise<Value> {
  if (value instanceof JUri) return { kind: "uri", value: value.uri };
  const pfd = parcelFileDescriptorData(value);
  if (pfd) return { kind: "pfd", bytes: pfd.bytes, token: null };
  const p = new JParcel();
  await vcall(p, "writeValue", "(Ljava/lang/Object;)V", value);
  return { kind: "value", data: exportParcel(p) };
}
let providerPfds = 0;
export async function decodeProviderValue(value: Value, writeback: ((bytes: Uint8Array, closed?: boolean) => unknown) | null = null): Promise<unknown> {
  if (value.kind === "uri") return mkUri(value.value);
  // a writable descriptor gets a file for its writes, which the writeback takes on the last close
  if (value.kind === "pfd") return mkPfd(value.bytes.slice(), writeback, writeback ? `provider:${++providerPfds}` : undefined);
  return vcall(importParcel(value.data), "readValue", "(Ljava/lang/ClassLoader;)Ljava/lang/Object;", null);
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
      const raw = unbox(value);
      return desc.endsWith("I") && raw !== undefined ? raw : value;
    }
    return mkCursor(result.columns, await Promise.all(result.rows.map((row) => Promise.all(row.map((value) => decodeProviderValue(value))))));
  },
])) });
export function connectProviders(call: ProviderCall): void {
  providerTransport.acquire = async (component) => {
    rt.link("webdroid/RemoteContentProvider");
    const provider = new JRemoteProvider(); provider.pkg = component.owner.pkg; provider.process = componentProcess(component);
    provider.authority = authoritiesOf(component.node)[0]!; provider.call = call; return provider;
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
  const component = resolveProvider(request.authority);
  const host = appHost;
  if (!component || !host?.application || component.owner.pkg !== host.pkg) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Provider unavailable: " + request.authority);
  if (!exported(component) && component.owner.uid !== caller.uid) throw rt.mkThrowable("java/lang/SecurityException", "Provider is not exported");
  const provider = await attachProvider(host.application, component);
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
