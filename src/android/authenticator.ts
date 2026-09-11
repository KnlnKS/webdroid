import { JObj, rt } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { mangleStaticField } from "../jvm/abi";
import { JBinder, callingIdentity, withCallingIdentity } from "./binder";
import { JParcel, parcelCreator, readInt, readString, writeInt, writeString } from "./parcel";
import { JBundle, bundleBox } from "./os";
import { packages, qualifyComponent } from "./packages";
import { attr, attrStr, parseAXML } from "./axml";
import { servicesMatching } from "./pm";
import { resString } from "./res";

export const AUTHENTICATOR = "android.accounts.IAccountAuthenticator", AUTH_RESPONSE = "android.accounts.IAccountAuthenticatorResponse";
const S = "Ljava/lang/String;", A = "Landroid/accounts/Account;", B = "Landroid/os/Bundle;";
export const authenticatorMethods = [
  ["addAccount", [S, S, "[" + S, B]], ["confirmCredentials", [A, B]], ["getAuthToken", [A, S, B]],
  ["getAuthTokenLabel", [S]], ["updateCredentials", [A, S, B]], ["editProperties", [S]],
  ["hasFeatures", [A, "[" + S]], ["getAccountRemovalAllowed", [A]], ["getAccountCredentialsForCloning", [A]],
  ["addAccountFromCredentials", [A, B]], ["startAddAccountSession", [S, S, "[" + S, B]],
  ["startUpdateCredentialsSession", [A, S, B]], ["finishSession", [S, B]], ["isCredentialsUpdateSuggested", [A, S]],
] as const;

class JAuthenticatorResponse extends JObj { binder: JObj | null = null; }
function responseFor(binder: JObj | null): JAuthenticatorResponse {
  rt.link("android/accounts/AccountAuthenticatorResponse");
  const response = new JAuthenticatorResponse(); response.binder = binder; return response;
}
async function sendResponse(response: JAuthenticatorResponse, code: number, result: JBundle | null, error = 0, message: string | null = null): Promise<void> {
  rt.link("android/os/Parcel");
  const p = new JParcel(); await vcall(p, "writeInterfaceToken", "(Ljava/lang/String;)V", AUTH_RESPONSE);
  if (code === 1) { writeInt(p, +!!result); if (result) await vcall(p, "writeBundle", "(Landroid/os/Bundle;)V", result); }
  else if (code === 3) { writeInt(p, error); writeString(p, message); }
  try {
    if (response.binder) await vcall(response.binder, "transact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z", code, p, null, 1);
  } catch (error) { if (!rt.iof(error, "android/os/RemoteException")) throw error; }
}
rt.register({ name: "android/accounts/IAccountAuthenticatorResponse", ctor: class extends JObj {}, ifaces: ["android/os/IInterface"] });
rt.register({ name: "android/accounts/AccountAuthenticatorResponse", ctor: JAuthenticatorResponse, ifaces: ["android/os/Parcelable"],
  statics: { get CREATOR() { return parcelCreator("android/accounts/AccountAuthenticatorResponse", async p => responseFor(await vcall(p, "readStrongBinder", "()Landroid/os/IBinder;"))); } },
  methods: {
    "<init>(Landroid/accounts/IAccountAuthenticatorResponse;)V": async function (this: JAuthenticatorResponse, response: unknown) {
      this.binder = await vcall(response, "asBinder", "()Landroid/os/IBinder;");
    },
    "onResult(Landroid/os/Bundle;)V": async function (this: JAuthenticatorResponse, result: JBundle | null) { await sendResponse(this, 1, result); },
    "onRequestContinued()V": async function (this: JAuthenticatorResponse) { await sendResponse(this, 2, null); },
    "onError(ILjava/lang/String;)V": async function (this: JAuthenticatorResponse, code: number, message: string | null) { await sendResponse(this, 3, null, code, message); },
    "writeToParcel(Landroid/os/Parcel;I)V": async function (this: JAuthenticatorResponse, p: JParcel) { await vcall(p, "writeStrongBinder", "(Landroid/os/IBinder;)V", this.binder); },
    "describeContents()I": () => 0,
  },
});

class JAuthenticator extends JObj { binder: JAuthenticatorBinder | null = null; }
class JAuthenticatorBinder extends JBinder { authenticator!: JAuthenticator; }
rt.register({ name: "webdroid/AccountAuthenticatorBinder", ctor: JAuthenticatorBinder, sup: "android/os/Binder", methods: {
  "onTransact(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": async function (this: JAuthenticatorBinder, code: number, p: JParcel, reply: JParcel | null) {
    if (code === 0x5f4e5446 && reply) { writeString(reply, AUTHENTICATOR); return 1; }
    const method = authenticatorMethods[code - 1]; if (!method) return 0;
    const caller = callingIdentity();
    if (caller.uid !== 1000 && ![...packages.values()].some(pkg => pkg.uid === caller.uid && pkg.grants.has("android.permission.ACCOUNT_MANAGER")))
      throw rt.mkThrowable("java/lang/SecurityException", "Caller lacks ACCOUNT_MANAGER");
    await vcall(p, "enforceInterface", "(Ljava/lang/String;)V", AUTHENTICATOR);
    const response = responseFor(await vcall(p, "readStrongBinder", "()Landroid/os/IBinder;"));
    const [name, types] = method, args: unknown[] = [];
    for (const type of types) {
      if (type === S) args.push(readString(p));
      else if (type === "[" + S) args.push(await vcall(p, "createStringArray", "()[Ljava/lang/String;"));
      else if (type === B) args.push(readInt(p) ? await vcall(p, "readBundle", "()Landroid/os/Bundle;") : null);
      else args.push(await vcall(p, "readTypedObject", "(Landroid/os/Parcelable$Creator;)Ljava/lang/Object;", rt.link("android/accounts/Account").ctor[mangleStaticField("CREATOR")]));
    }
    try {
      let result: JBundle | null;
      if (name === "getAuthTokenLabel") {
        const label = await withCallingIdentity(caller, () => vcall(this.authenticator, name, "(" + S + ")" + S, ...args));
        rt.link("android/os/Bundle"); result = new JBundle(); result.map.set("authTokenLabelKey", label);
      } else result = await withCallingIdentity(caller, () => vcall(this.authenticator, name, "(Landroid/accounts/AccountAuthenticatorResponse;" + types.join("") + ")" + B, response, ...args));
      if (result) await sendResponse(response, 1, result);
    } catch (error) {
      const code = rt.iof(error, "android/accounts/NetworkErrorException") ? 3 : rt.iof(error, "java/lang/UnsupportedOperationException") ? 6 : rt.iof(error, "java/lang/IllegalArgumentException") ? 7 : 1;
      await sendResponse(response, 3, null, code, "Authenticator request failed");
    }
    return 1;
  },
} });
rt.register({ name: "android/accounts/AbstractAccountAuthenticator", ctor: JAuthenticator, methods: {
  "<init>(Landroid/content/Context;)V": function () {},
  "getIBinder()Landroid/os/IBinder;": function (this: JAuthenticator) {
    if (!this.binder) {
      rt.link("webdroid/AccountAuthenticatorBinder");
      this.binder = new JAuthenticatorBinder(); this.binder.authenticator = this; this.binder.descriptor = AUTHENTICATOR;
    }
    return this.binder;
  },
  "getAccountRemovalAllowed(Landroid/accounts/AccountAuthenticatorResponse;Landroid/accounts/Account;)Landroid/os/Bundle;": () => {
    rt.link("android/os/Bundle"); const b = new JBundle(); b.map.set("booleanResult", bundleBox(1, "Z")); return b;
  },
  ...Object.fromEntries(authenticatorMethods.slice(8).map(([name, args]) => [name + "(Landroid/accounts/AccountAuthenticatorResponse;" + args.join("") + ")" + B,
    () => { throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Authenticator session operation"); }])),
} });

class JAuthenticatorDescription extends JObj {
  type = ""; packageName = ""; component = ""; process = ""; labelId = 0; iconId = 0; smallIconId = 0; accountPreferencesId = 0; customTokens = 0;
}
rt.register({
  name: "android/accounts/AuthenticatorDescription", ctor: JAuthenticatorDescription, ifaces: ["android/os/Parcelable"],
  fields: ["type", "packageName", "labelId", "iconId", "smallIconId", "accountPreferencesId", "customTokens"],
  methods: { "describeContents()I": () => 0 },
});
/** the manifest's authenticator services, each described by its <account-authenticator> resource */
export function authenticators(): JAuthenticatorDescription[] {
  rt.link("android/accounts/AuthenticatorDescription");
  const out: JAuthenticatorDescription[] = [];
  for (const { node, meta, owner } of servicesMatching("android.accounts.AccountAuthenticator")) {
    if (!owner.enabled || attr(node, "enabled")?.data === 0) continue;
    const id = meta.map.get("android.accounts.AccountAuthenticator");
    const bytes = typeof id === "number" ? owner.res.fileOf(id)?.bytes : null;
    if (!bytes) continue;
    const n = parseAXML(bytes), d = new JAuthenticatorDescription();
    const ref = (name: string) => attr(n, name)?.data ?? 0;
    d.type = attrStr(n, "accountType") ?? resString(owner.res, ref("accountType")) ?? "";
    d.packageName = owner.pkg; d.process = owner.process(node);
    d.component = qualifyComponent(attrStr(node, "name") ?? "", owner.pkg);
    d.labelId = ref("label"); d.iconId = ref("icon"); d.smallIconId = ref("smallIcon"); d.accountPreferencesId = ref("accountPreferences");
    d.customTokens = attr(n, "customTokens")?.data ? 1 : 0;
    out.push(d);
  }
  return out;
}
