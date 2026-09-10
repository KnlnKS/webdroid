import { JObj, rt } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { JUri, mkUri } from "./net";
import { JContentValues, mkCursor } from "./sqlite";
import { JBundle } from "./os";
import { JParcel } from "./parcel";
import { exportParcel, importParcel, withCallingIdentity, type ParcelData, type Caller } from "./binder";
import { attachProvider, providerTransport } from "./contentresolver";
import { getPM } from "./pm";
import { appHost } from "./apphost";

type Value = { kind: "uri"; value: string } | { kind: "values" | "value"; data: ParcelData };
export type ProviderRequest = { authority: string; name: string; desc: string; args: Value[] };
export type ProviderReply = { kind: "cursor"; columns: string[]; rows: Value[][] } | { kind: "value"; value: Value };
export type ProviderCall = (pkg: string, process: string, request: ProviderRequest) => Promise<ProviderReply>;
async function encode(value: unknown): Promise<Value> {
  if (value instanceof JUri) return { kind: "uri", value: value.uri };
  const p = new JParcel(), values = value instanceof JContentValues;
  if (value instanceof JContentValues) { const bundle = new JBundle(); bundle.map = new Map([...value.data.m.values()].map((e) => [String(e.k), e.v])); value = bundle; }
  await vcall(p, "writeValue", "(Ljava/lang/Object;)V", value);
  return { kind: values ? "values" : "value", data: exportParcel(p) };
}
async function decode(value: Value): Promise<unknown> {
  if (value.kind === "uri") return mkUri(value.value);
  const decoded: unknown = await vcall(importParcel(value.data), "readValue", "(Ljava/lang/ClassLoader;)Ljava/lang/Object;", null);
  if (value.kind !== "values") return decoded;
  if (!(decoded instanceof JBundle)) throw rt.mkThrowable("android/os/BadParcelableException", "Expected ContentValues");
  const values = new JContentValues(); values.data.m = new Map([...decoded.map].map(([k, v]) => [k, { k, v }])); return values;
}
const operations = {
  query: "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
  insert: "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;",
  update: "(Landroid/net/Uri;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I",
  delete: "(Landroid/net/Uri;Ljava/lang/String;[Ljava/lang/String;)I",
  getType: "(Landroid/net/Uri;)Ljava/lang/String;",
  call: "(Ljava/lang/String;Ljava/lang/String;Landroid/os/Bundle;)Landroid/os/Bundle;",
};
class JRemoteProvider extends JObj { pkg = ""; process = ""; authority = ""; call!: ProviderCall; }
rt.register({ name: "webdroid/RemoteContentProvider", ctor: JRemoteProvider, methods: Object.fromEntries(Object.entries(operations).map(([name, desc]) => [name + desc,
  async function (this: JRemoteProvider, ...args: unknown[]) {
    const result = await this.call(this.pkg, this.process, { authority: this.authority, name, desc, args: await Promise.all(args.map(encode)) });
    if (result.kind === "value") {
      const value = await decode(result.value);
      return desc.endsWith("I") && value instanceof JObj && "v" in value ? value.v : value;
    }
    return mkCursor(result.columns, await Promise.all(result.rows.map((row) => Promise.all(row.map(decode)))));
  },
])) });
export function connectProviders(call: ProviderCall): void {
  providerTransport.acquire = async (info) => {
    rt.link("webdroid/RemoteContentProvider");
    const provider = new JRemoteProvider(); provider.pkg = info.packageName; provider.process = info.processName ?? info.packageName;
    provider.authority = info.authority.split(";")[0]; provider.call = call; return provider;
  };
}
export async function receiveProvider(request: ProviderRequest, caller: Caller): Promise<ProviderReply> {
  if (!Object.entries(operations).some(([name, desc]) => name === request.name && desc === request.desc)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown provider operation");
  const info = await vcall(getPM(), "resolveContentProvider", "(Ljava/lang/String;I)Landroid/content/pm/ProviderInfo;", request.authority, 128);
  const host = appHost;
  if (!info || !host?.application || info.packageName !== host.pkg) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Provider unavailable: " + request.authority);
  if (!info.exported && info.applicationInfo.uid !== caller.uid) throw rt.mkThrowable("java/lang/SecurityException", "Provider is not exported");
  const provider = await attachProvider(host.application, info);
  return withCallingIdentity(caller, async () => {
    const value = await vcall(provider, request.name, request.desc, ...await Promise.all(request.args.map(decode)));
    if (request.name !== "query" || !value) return { kind: "value", value: await encode(value) };
    const columns: string[] = await vcall(value, "getColumnNames", "()[Ljava/lang/String;"), rows: Value[][] = [];
    try {
      while (await vcall(value, "moveToNext", "()Z")) {
        const row: Value[] = [];
        for (let i = 0; i < columns.length; i++) {
          const type = await vcall(value, "getType", "(I)I", i);
          const cell = type === 0 ? null : type === 1 ? await vcall(value, "getLong", "(I)J", i) : type === 2 ? await vcall(value, "getDouble", "(I)D", i)
            : type === 4 ? await vcall(value, "getBlob", "(I)[B", i) : await vcall(value, "getString", "(I)Ljava/lang/String;", i);
          row.push(await encode(cell));
        }
        rows.push(row);
      }
    } finally { await vcall(value, "close", "()V"); }
    return { kind: "cursor", columns: [...columns], rows };
  });
}
