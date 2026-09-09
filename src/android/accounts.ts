import { JObj, rt, type NativeSpec } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import { defineException, stringHash, vcall } from "../jvm/natives/jlang";
import { appHost } from "./apphost";
import { attr, parseAXML } from "./axml";
import { onMain } from "./mainloop";
import { servicesMatching } from "./pm";
import type { JBundle } from "./os";
import { resString } from "./res";

class JAccount extends JObj { name = ""; type = ""; }

rt.register({
  name: "android/accounts/Account", ctor: JAccount, ifaces: ["android/os/Parcelable"],
  fields: { name: "name", type: "type" },
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": function (this: JAccount, name: string | null, type: string | null) {
      if (!name || !type) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Account name and type must not be empty");
      this.name = name; this.type = type;
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

// ── the account database: one per package, persisted like preferences so a login survives a reload
type Stored = { name: string; type: string; password: string | null; data: Record<string, string>; tokens: Record<string, string> };
let db: Stored[] | null = null;
const key = () => "wd:accounts:" + (appHost?.pkg ?? "");
function accounts(): Stored[] {
  if (!db) {
    try { db = JSON.parse(globalThis.localStorage?.getItem(key()) ?? "[]"); } catch { db = []; }
  }
  return db!;
}
function persist() {
  try { globalThis.localStorage?.setItem(key(), JSON.stringify(db)); } catch { /* quota */ }
  for (const l of listeners) void onMain(() => vcall(l, "onAccountsUpdated", "([Landroid/accounts/Account;)V", allAccounts()));
}
const find = (a: JAccount | null) => accounts().find((s) => s.name === a?.name && s.type === a?.type);
const toJ = (s: Stored) => { const a = new JAccount(); a.name = s.name; a.type = s.type; return a; };
const accountArray = (list: Stored[]) => jarray(list.map(toJ), "Landroid/accounts/Account;");
const allAccounts = () => accountArray(accounts());
const byType = (type: string | null) => accountArray(accounts().filter((s) => type === null || s.type === type));
const listeners = new Set<unknown>();
function remove(a: JAccount): number {
  const i = accounts().findIndex((s) => s.name === a.name && s.type === a.type);
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
  const host = appHost!, out: JAuthenticatorDescription[] = [];
  for (const { meta } of servicesMatching("android.accounts.AccountAuthenticator")) {
    const id = meta.map.get("android.accounts.AccountAuthenticator");
    const bytes = typeof id === "number" ? host.res.fileOf(id)?.bytes : null;
    if (!bytes) continue;
    const n = parseAXML(bytes), d = new JAuthenticatorDescription();
    const ref = (name: string) => attr(n, name)?.data ?? 0;
    d.type = resString(host.res, ref("accountType")) ?? "";
    d.packageName = host.pkg;
    d.labelId = ref("label"); d.iconId = ref("icon"); d.smallIconId = ref("smallIcon"); d.accountPreferencesId = ref("accountPreferences");
    d.customTokens = attr(n, "customTokens")?.data ? 1 : 0;
    out.push(d);
  }
  return out;
}

class JAccountManager extends JObj {}
let manager: JAccountManager | null = null;
const statics: Record<string, unknown> = {
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
  [`getAccountsByTypeForPackage(${S}${S})[${ACC}`]: byType,
  [`getAccountsByTypeAndFeatures(${S}[${S}${CB}${H})${F}`]: (type: string, _f: unknown, cb: unknown) => future(byType(type), cb),
  [`addAccountExplicitly(${ACC}${S}Landroid/os/Bundle;)Z`]: (a: JAccount, password: string | null, extras: JBundle | null) => {
    if (find(a)) return 0;
    const data: Record<string, string> = {};
    for (const [k, v] of extras?.map ?? []) if (v != null) data[k] = String(v);
    accounts().push({ name: a.name, type: a.type, password, data, tokens: {} });
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
  [`setPassword(${ACC}${S})V`]: (a: JAccount, p: string | null) => { const s = find(a); if (s) { s.password = p; persist(); } },
  [`clearPassword(${ACC})V`]: (a: JAccount) => { const s = find(a); if (s) { s.password = null; persist(); } },
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
  [`addOnAccountsUpdatedListener(Landroid/accounts/OnAccountsUpdateListener;${H}Z)V`]: (l: unknown, _h: unknown, now: number) => {
    listeners.add(l);
    if (now) void onMain(() => vcall(l, "onAccountsUpdated", "([Landroid/accounts/Account;)V", allAccounts()));
  },
  [`addOnAccountsUpdatedListener(Landroid/accounts/OnAccountsUpdateListener;${H}Z[${S})V`]: (l: unknown, _h: unknown, now: number) => {
    listeners.add(l);
    if (now) void onMain(() => vcall(l, "onAccountsUpdated", "([Landroid/accounts/Account;)V", allAccounts()));
  },
  "removeOnAccountsUpdatedListener(Landroid/accounts/OnAccountsUpdateListener;)V": (l: unknown) => { listeners.delete(l); },
  [`notifyAccountAuthenticated(${ACC})Z`]: () => 1,
};
rt.register({ name: "android/accounts/AccountManager", ctor: JAccountManager, statics, methods });
