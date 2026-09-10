import { JObj, rt, type NativeSpec, maySuspend } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import { defineException, stringHash, vcall } from "../jvm/natives/jlang";
import { appHost } from "./apphost";
import { attr, attrStr, parseAXML } from "./axml";
import { onMain } from "./mainloop";
import { servicesMatching } from "./pm";
import { PROCESS_UID, type JBundle } from "./os";
import { packages } from "./packages";
import { AccountStore, type StoredAccount } from "../shell/accounts";
import { resString } from "./res";
import { JParcel, parcelCreator } from "./parcel";

class JAccount extends JObj { name = ""; type = ""; accessId: string | null = null; }
function initAccount(this: JAccount, name: string | null, type: string | null, accessId: string | null = null) {
  if (!name || !type) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Account name and type must not be empty");
  this.name = name; this.type = type; this.accessId = accessId;
}

rt.register({
  name: "android/accounts/Account", ctor: JAccount, ifaces: ["android/os/Parcelable"],
  fields: { name: "name", type: "type" },
  statics: { get CREATOR() { return parcelCreator("android/accounts/Account", async p => {
    const name = await vcall(p, "readString", "()Ljava/lang/String;"), type = await vcall(p, "readString", "()Ljava/lang/String;");
    const account = new JAccount(); initAccount.call(account, name, type, await vcall(p, "readString", "()Ljava/lang/String;")); return account;
  }); } },
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": initAccount,
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V": initAccount,
    "getAccessId()Ljava/lang/String;": function (this: JAccount) { return this.accessId; },
    "writeToParcel(Landroid/os/Parcel;I)V": async function (this: JAccount, p: JParcel) {
      for (const value of [this.name, this.type, this.accessId]) await vcall(p, "writeString", "(Ljava/lang/String;)V", value);
    },
    "equals(Ljava/lang/Object;)Z": function (this: JAccount, other: unknown) {
      return other instanceof JAccount && this.name === other.name && this.type === other.type ? 1 : 0;
    },
    "hashCode()I": function (this: JAccount) { return (Math.imul(527 + stringHash(this.name), 31) + stringHash(this.type)) | 0; },
    "toString()Ljava/lang/String;": function (this: JAccount) { return `Account {name=${this.name}, type=${this.type}}`; },
    "describeContents()I": () => 0,
  },
});

for (const [name, sup] of [["android/accounts/AccountsException", "java/lang/Exception"], ["android/accounts/AuthenticatorException", "android/accounts/AccountsException"],
  ["android/accounts/OperationCanceledException", "android/accounts/AccountsException"], ["android/accounts/NetworkErrorException", "android/accounts/AccountsException"]]) defineException(name, sup);

for (const i of ["android/accounts/AccountManagerFuture", "android/accounts/AccountManagerCallback", "android/accounts/OnAccountsUpdateListener"]) rt.register({ name: i, ctor: class extends JObj {} });

let accountStore = new AccountStore(), stopAccountUpdates = () => {};
export function useAccountStore(store: AccountStore): () => void {
  stopAccountUpdates(); accountStore = store;
  return stopAccountUpdates = store.watch(() => {
    for (const l of listeners) void onMain(() => vcall(l, "onAccountsUpdated", "([Landroid/accounts/Account;)V", allAccounts()));
  });
}
useAccountStore(accountStore);
const accounts = () => accountStore.records;
const persist = () => accountStore.persist();
const owns = (s: StoredAccount) => packages.get(s.owner)?.uid === PROCESS_UID;
function visible(s: StoredAccount, pkg = appHost?.pkg ?? ""): boolean {
  const owner = packages.get(s.owner), caller = packages.get(pkg);
  return !!owner && !!caller && (owner.uid === caller.uid || s.visibility[pkg] === 1 || s.visibility[pkg] === 2);
}
function find(a: JAccount | null): StoredAccount | undefined {
  const stored = accounts().find(s => s.name === a?.name && s.type === a?.type);
  if (stored && !owns(stored)) throw rt.mkThrowable("java/lang/SecurityException", "Caller does not own this account type");
  return stored;
}
const toJ = (s: StoredAccount) => { const a = new JAccount(); a.name = s.name; a.type = s.type; return a; };
const accountArray = (list: StoredAccount[]) => { rt.link("android/accounts/Account"); return jarray(list.map(toJ), "Landroid/accounts/Account;"); };
const allAccounts = () => accountArray(accounts().filter(s => visible(s)));
const byType = (type: string | null, pkg = appHost?.pkg ?? "") => accountArray(accounts().filter(s => (type === null || s.type === type) && visible(s, pkg)));
const listeners = new Set<unknown>();
function remove(a: JAccount): number {
  const stored = find(a), i = stored ? accounts().indexOf(stored) : -1;
  if (i < 0) return 0;
  accounts().splice(i, 1); persist();
  return 1;
}

/** an operation's outcome, delivered to the callback on the main looper as AccountManager does */
class JAccountFuture extends JObj { value: unknown = null; }
function future(value: unknown, cb: unknown): JAccountFuture {
  const f = new JAccountFuture();
  f.value = value;
  if (cb) void onMain(() => vcall(cb, "run", "(Landroid/accounts/AccountManagerFuture;)V", f));
  return f;
}
rt.register({
  name: "webdroid/AccountFuture", ctor: JAccountFuture, ifaces: ["android/accounts/AccountManagerFuture"],
  methods: {
    "getResult()Ljava/lang/Object;": function (this: JAccountFuture) { return this.value; },
    "getResult(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;": function (this: JAccountFuture) { return this.value; },
    "isDone()Z": () => 1,
    "isCancelled()Z": () => 0,
    "cancel(Z)Z": () => 0,
  },
});
const bundle = (entries: Record<string, unknown>) => {
  const b = new (rt.link("android/os/Bundle").ctor)() as JBundle;
  for (const [k, v] of Object.entries(entries)) b.map.set(k, v);
  return b;
};
/** an operation that needs an authenticator UI or the network: nothing here answers it */
const unsupported = () => { throw rt.mkThrowable("android/accounts/AuthenticatorException", "no authenticator"); };

class JAuthenticatorDescription extends JObj {
  type = ""; packageName = ""; labelId = 0; iconId = 0; smallIconId = 0; accountPreferencesId = 0; customTokens = 0;
}
rt.register({
  name: "android/accounts/AuthenticatorDescription", ctor: JAuthenticatorDescription, ifaces: ["android/os/Parcelable"],
  fields: { type: "type", packageName: "packageName", labelId: "labelId", iconId: "iconId", smallIconId: "smallIconId", accountPreferencesId: "accountPreferencesId", customTokens: "customTokens" },
  methods: { "describeContents()I": () => 0 },
});
/** the manifest's authenticator services, each described by its <account-authenticator> resource */
function authenticators(): JAuthenticatorDescription[] {
  rt.link("android/accounts/AuthenticatorDescription");
  const out: JAuthenticatorDescription[] = [];
  for (const { meta, owner } of servicesMatching("android.accounts.AccountAuthenticator")) {
    const id = meta.map.get("android.accounts.AccountAuthenticator");
    const bytes = typeof id === "number" ? owner.res.fileOf(id)?.bytes : null;
    if (!bytes) continue;
    const n = parseAXML(bytes), d = new JAuthenticatorDescription();
    const ref = (name: string) => attr(n, name)?.data ?? 0;
    d.type = attrStr(n, "accountType") ?? resString(owner.res, ref("accountType")) ?? "";
    d.packageName = owner.pkg;
    d.labelId = ref("label"); d.iconId = ref("icon"); d.smallIconId = ref("smallIcon"); d.accountPreferencesId = ref("accountPreferences");
    d.customTokens = attr(n, "customTokens")?.data ? 1 : 0;
    out.push(d);
  }
  return out;
}

class JAccountManager extends JObj {}
let manager: JAccountManager | null = null;
const statics: Record<string, unknown> = {
  VISIBILITY_UNDEFINED: 0, VISIBILITY_VISIBLE: 1, VISIBILITY_USER_MANAGED_VISIBLE: 2, VISIBILITY_NOT_VISIBLE: 3, VISIBILITY_USER_MANAGED_NOT_VISIBLE: 4,
  ERROR_CODE_REMOTE_EXCEPTION: 1, ERROR_CODE_NETWORK_ERROR: 3, ERROR_CODE_CANCELED: 4, ERROR_CODE_INVALID_RESPONSE: 5, ERROR_CODE_UNSUPPORTED_OPERATION: 6,
  ERROR_CODE_BAD_ARGUMENTS: 7, ERROR_CODE_BAD_REQUEST: 8, ERROR_CODE_BAD_AUTHENTICATION: 9,
  KEY_ACCOUNT_NAME: "authAccount", KEY_ACCOUNT_TYPE: "accountType", KEY_AUTHTOKEN: "authtoken", KEY_INTENT: "intent", KEY_PASSWORD: "password", KEY_ACCOUNTS: "accounts",
  KEY_ACCOUNT_AUTHENTICATOR_RESPONSE: "accountAuthenticatorResponse", KEY_ACCOUNT_MANAGER_RESPONSE: "accountManagerResponse", KEY_AUTHENTICATOR_TYPES: "authenticator_types",
  KEY_AUTH_FAILED_MESSAGE: "authFailedMessage", KEY_AUTH_TOKEN_LABEL: "authTokenLabelKey", KEY_BOOLEAN_RESULT: "booleanResult", KEY_ERROR_CODE: "errorCode", KEY_ERROR_MESSAGE: "errorMessage",
  KEY_USERDATA: "userdata", KEY_CALLER_UID: "callerUid", KEY_CALLER_PID: "callerPid", KEY_ANDROID_PACKAGE_NAME: "androidPackageName", LOGIN_ACCOUNTS_CHANGED_ACTION: "android.accounts.LOGIN_ACCOUNTS_CHANGED",
};

const ACC = "Landroid/accounts/Account;", CB = "Landroid/accounts/AccountManagerCallback;", H = "Landroid/os/Handler;", F = "Landroid/accounts/AccountManagerFuture;", S = "Ljava/lang/String;";
const methods: NativeSpec["methods"] = {
  "static get(Landroid/content/Context;)Landroid/accounts/AccountManager;": () => manager ??= new JAccountManager(),
  [`getAccounts()[${ACC}`]: allAccounts,
  [`getAccountsByType(${S})[${ACC}`]: byType,
  [`getAccountsByTypeForPackage(${S}${S})[${ACC}`]: (type: string, pkg: string) => {
    if (pkg !== appHost?.pkg && !authenticators().some(d => d.type === type && packages.get(d.packageName)?.uid === PROCESS_UID))
      throw rt.mkThrowable("java/lang/SecurityException", "Caller does not own this account type");
    return byType(type, pkg);
  },
  [`getAccountsByTypeAndFeatures(${S}[${S}${CB}${H})${F}`]: (type: string, features: string[] | null, cb: unknown) => features?.length ? unsupported() : future(byType(type), cb),
  [`addAccountExplicitly(${ACC}${S}Landroid/os/Bundle;)Z`]: (a: JAccount, password: string | null, extras: JBundle | null) => {
    const owner = authenticators().find(d => d.type === a.type)?.packageName;
    if (!owner || packages.get(owner)?.uid !== PROCESS_UID) throw rt.mkThrowable("java/lang/SecurityException", "Caller does not own this account type");
    if (find(a)) return 0;
    const data: Record<string, string> = Object.create(null);
    for (const [k, v] of extras?.map ?? []) if (v != null) data[k] = String(v);
    accounts().push({ name: a.name, type: a.type, owner, password, data, tokens: Object.create(null), visibility: Object.create(null) });
    persist();
    return 1;
  },
  [`removeAccountExplicitly(${ACC})Z`]: remove,
  [`removeAccount(${ACC}${CB}${H})${F}`]: (a: JAccount, cb: unknown) => future(bundle({ booleanResult: remove(a) }), cb),
  [`removeAccount(${ACC}Landroid/app/Activity;${CB}${H})${F}`]: (a: JAccount, _act: unknown, cb: unknown) => future(bundle({ booleanResult: remove(a) }), cb),
  [`renameAccount(${ACC}${S}${CB}${H})${F}`]: (a: JAccount, name: string, cb: unknown) => {
    const s = find(a);
    if (s) { s.name = name; persist(); }
    return future(s ? toJ(s) : null, cb);
  },
  [`getUserData(${ACC}${S})${S}`]: (a: JAccount, k: string) => find(a)?.data[k] ?? null,
  [`setUserData(${ACC}${S}${S})V`]: (a: JAccount, k: string, v: string | null) => {
    const s = find(a);
    if (!s) return;
    if (v == null) delete s.data[k]; else s.data[k] = v;
    persist();
  },
  [`getPassword(${ACC})${S}`]: (a: JAccount) => find(a)?.password ?? null,
  [`setPassword(${ACC}${S})V`]: (a: JAccount, p: string | null) => { const s = find(a); if (s) { s.password = p; s.tokens = Object.create(null); persist(); } },
  [`clearPassword(${ACC})V`]: (a: JAccount) => { const s = find(a); if (s) { s.password = null; s.tokens = Object.create(null); persist(); } },
  [`peekAuthToken(${ACC}${S})${S}`]: (a: JAccount, type: string) => find(a)?.tokens[type] ?? null,
  [`setAuthToken(${ACC}${S}${S})V`]: (a: JAccount, type: string, token: string | null) => {
    const s = find(a);
    if (!s) return;
    if (token == null) delete s.tokens[type]; else s.tokens[type] = token;
    persist();
  },
  [`invalidateAuthToken(${S}${S})V`]: (type: string, token: string | null) => {
    for (const s of accounts()) for (const k of Object.keys(s.tokens)) if (s.type === type && s.tokens[k] === token) delete s.tokens[k];
    persist();
  },
  [`blockingGetAuthToken(${ACC}${S}Z)${S}`]: (a: JAccount, type: string) => find(a)?.tokens[type] ?? unsupported(),
  [`getAuthToken(${ACC}${S}Landroid/os/Bundle;Landroid/app/Activity;${CB}${H})${F}`]: (a: JAccount, type: string, _o: unknown, _act: unknown, cb: unknown) =>
    future(bundle({ authAccount: a.name, accountType: a.type, authtoken: find(a)?.tokens[type] ?? unsupported() }), cb),
  [`getAuthToken(${ACC}${S}Landroid/os/Bundle;Z${CB}${H})${F}`]: (a: JAccount, type: string, _o: unknown, _n: number, cb: unknown) =>
    future(bundle({ authAccount: a.name, accountType: a.type, authtoken: find(a)?.tokens[type] ?? unsupported() }), cb),
  [`getAuthTokenByFeatures(${S}${S}[${S}Landroid/app/Activity;Landroid/os/Bundle;Landroid/os/Bundle;${CB}${H})${F}`]: unsupported,
  [`addAccount(${S}${S}[${S}Landroid/os/Bundle;Landroid/app/Activity;${CB}${H})${F}`]: unsupported,
  "getAuthenticatorTypes()[Landroid/accounts/AuthenticatorDescription;": () => jarray(authenticators(), "Landroid/accounts/AuthenticatorDescription;"),
  [`addOnAccountsUpdatedListener(Landroid/accounts/OnAccountsUpdateListener;${H}Z)V`]: maySuspend((l: unknown, _h: unknown, now: number) => {
    listeners.add(l);
    if (now) void onMain(() => vcall(l, "onAccountsUpdated", "([Landroid/accounts/Account;)V", allAccounts()));
  }),
  [`addOnAccountsUpdatedListener(Landroid/accounts/OnAccountsUpdateListener;${H}Z[${S})V`]: maySuspend((l: unknown, _h: unknown, now: number) => {
    listeners.add(l);
    if (now) void onMain(() => vcall(l, "onAccountsUpdated", "([Landroid/accounts/Account;)V", allAccounts()));
  }),
  "removeOnAccountsUpdatedListener(Landroid/accounts/OnAccountsUpdateListener;)V": (l: unknown) => { listeners.delete(l); },
  [`setAccountVisibility(${ACC}${S}I)Z`]: (a: JAccount, pkg: string, visibility: number) => {
    if (visibility < 0 || visibility > 4) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid account visibility");
    const stored = find(a);
    if (!stored || !packages.has(pkg)) return 0;
    if (visibility) stored.visibility[pkg] = visibility; else delete stored.visibility[pkg];
    persist(); return 1;
  },
  [`getAccountVisibility(${ACC}${S})I`]: (a: JAccount, pkg: string) => {
    const stored = find(a);
    return stored ? packages.get(stored.owner)?.uid === packages.get(pkg)?.uid ? 1 : stored.visibility[pkg] ?? 4 : 0;
  },
  [`notifyAccountAuthenticated(${ACC})Z`]: (a: JAccount) => +!!find(a),
};
rt.register({ name: "android/accounts/AccountManager", ctor: JAccountManager, statics, methods });
