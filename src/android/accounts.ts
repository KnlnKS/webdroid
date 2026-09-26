import { JObj, rt, type NativeSpec, driven, type Gen } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import { defineException, stringHash, vcall, curThread, mainThread, boxInt, newObj } from "../jvm/natives/jlang";
import { appHost } from "./apphost";
import { onMain } from "./mainloop";
import { PROCESS_UID, bundleBox, bundlePrimitive, type JHandler, type JBundle } from "./os";
import { packages } from "./packages";
import { AccountStore, type StoredAccount } from "../shell/accounts";
import { JParcel, parcelCreator } from "./parcel";
import { authenticators } from "./authenticator";
import { accountFuture, type JAccountFuture } from "./accountfuture";
import { accountOptions, requestAccount } from "./accountrequest";

class JAccount extends JObj { name = ""; type = ""; accessId: string | null = null; }
function initAccount(this: JAccount, name: string | null, type: string | null, accessId: string | null = null) {
  if (!name || !type) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Account name and type must not be empty");
  this.name = name; this.type = type; this.accessId = accessId;
}

rt.register({
  name: "android/accounts/Account", ctor: JAccount, ifaces: ["android/os/Parcelable"],
  fields: ["name", "type"],
  statics: { get CREATOR() { return parcelCreator("android/accounts/Account", async p => {
    const name = await vcall(p, "readString", "()Ljava/lang/String;"), type = await vcall(p, "readString", "()Ljava/lang/String;");
    const account = new JAccount(); initAccount.call(account, name, type, await vcall(p, "readString", "()Ljava/lang/String;")); return account;
  }); } },
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": initAccount,
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V": initAccount,
    "getAccessId()Ljava/lang/String;": function (this: JAccount) { return this.accessId; },
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JAccount, p: JParcel): Gen {
      for (const value of [this.name, this.type, this.accessId]) (yield vcall(p, "writeString", "(Ljava/lang/String;)V", value));
    }),
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

const unsupported = () => { throw rt.mkThrowable("android/accounts/AuthenticatorException", "Account operation is unavailable"); };
const boolResult = (b: JBundle) => {
  if (!b.map.has("booleanResult")) throw rt.mkThrowable("android/accounts/AuthenticatorException", "Missing boolean result");
  return bundleBox(bundlePrimitive(b.map.get("booleanResult"), "Z", 0), "Z");
};
function features(a: JAccount, values: string[], cb: unknown, handler: JHandler | null): JAccountFuture {
  if (!a || !values) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Account and features are required");
  return requestAccount({ type: a.type, method: "hasFeatures", args: [a, values], callback: cb, handler, convert: boolResult });
}
function accountsWithFeatures(type: string, values: string[] | null, cb: unknown, handler: JHandler | null): JAccountFuture {
  if (!type) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Account type is required");
  const list = byType(type);
  if (!values?.length) return accountFuture(cb, handler, list);
  const future = accountFuture(cb, handler), matches: JAccount[] = [];
  let active: JAccountFuture | null = null;
  future.cleanup = () => { active?.finish({ kind: "canceled" }); };
  void (async () => {
    try {
      for (const account of list) {
        if (!future.pending) return;
        active = features(account, values, null, null); await active.done();
        if (bundlePrimitive(await active.result(), "Z", 0)) matches.push(account);
      }
      future.finish({ kind: "result", value: jarray(matches, "Landroid/accounts/Account;") });
    } catch (error) { future.finish({ kind: "error", error }); }
  })();
  return future;
}
function authToken(a: JAccount, type: string, options: JBundle | null, activity: unknown, cb: unknown, handler: JHandler | null): JAccountFuture {
  if (!a || !type) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Account and token type are required");
  return requestAccount({ type: a.type, method: "getAuthToken", args: [a, type, accountOptions(options)], activity, callback: cb, handler,
    convert: result => {
      if (result.map.has("authtoken") && (result.map.get("authAccount") !== a.name || result.map.get("accountType") !== a.type))
        throw rt.mkThrowable("android/accounts/AuthenticatorException", "Token account does not match request");
      return result;
    } });
}
function removeAccount(a: JAccount, activity: unknown, cb: unknown, handler: JHandler | null, boolean: boolean): JAccountFuture {
  const stored = find(a);
  return requestAccount({ type: a.type, method: "getAccountRemovalAllowed", args: [a], activity, callback: cb, handler, convert: result => {
    if (!result.map.has("intent") && bundlePrimitive(boolResult(result), "Z", 0)) {
      const index = stored ? accounts().indexOf(stored) : -1;
      if (index >= 0) { accounts().splice(index, 1); persist(); }
    }
    return boolean ? boolResult(result) : result;
  } });
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
  [`getAccountsByTypeAndFeatures(${S}[${S}${CB}${H})${F}`]: accountsWithFeatures,
  [`hasFeatures(${ACC}[${S}${CB}${H})${F}`]: features,
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
  [`removeAccount(${ACC}${CB}${H})${F}`]: (a: JAccount, cb: unknown, h: JHandler | null) => removeAccount(a, null, cb, h, true),
  [`removeAccount(${ACC}Landroid/app/Activity;${CB}${H})${F}`]: (a: JAccount, act: unknown, cb: unknown, h: JHandler | null) => removeAccount(a, act, cb, h, false),
  [`renameAccount(${ACC}${S}${CB}${H})${F}`]: (a: JAccount, name: string, cb: unknown, h: JHandler | null) => {
    const s = find(a);
    if (s) { s.name = name; persist(); }
    return accountFuture(cb, h, s ? toJ(s) : null);
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
  [`blockingGetAuthToken(${ACC}${S}Z)${S}`]: driven(function* (a: JAccount, type: string): Gen  {
    if (curThread === mainThread) throw rt.mkThrowable("java/lang/IllegalStateException", "AccountManager cannot block the main thread");
    const thread = curThread, result = (yield authToken(a, type, null, null, null, null).result(undefined, thread));
    return ((yield vcall(result, "getString", "(Ljava/lang/String;)Ljava/lang/String;", "authtoken"))) ?? null;
  }),
  [`getAuthToken(${ACC}${S}Landroid/os/Bundle;Landroid/app/Activity;${CB}${H})${F}`]: authToken,
  [`getAuthToken(${ACC}${S}Landroid/os/Bundle;Z${CB}${H})${F}`]: (a: JAccount, type: string, o: JBundle | null, _notify: number, cb: unknown, h: JHandler | null) => authToken(a, type, o, null, cb, h),
  [`getAuthToken(${ACC}${S}Z${CB}${H})${F}`]: (a: JAccount, type: string, _notify: number, cb: unknown, h: JHandler | null) => authToken(a, type, null, null, cb, h),
  [`getAuthTokenByFeatures(${S}${S}[${S}Landroid/app/Activity;Landroid/os/Bundle;Landroid/os/Bundle;${CB}${H})${F}`]: unsupported,
  [`addAccount(${S}${S}[${S}Landroid/os/Bundle;Landroid/app/Activity;${CB}${H})${F}`]: (type: string, token: string | null, features: string[] | null, options: JBundle | null, activity: unknown, callback: unknown, handler: JHandler | null) => {
    if (!type) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Account type is required");
    return requestAccount({ type, method: "addAccount", args: [type, token, features, accountOptions(options)], activity, callback, handler });
  },
  [`confirmCredentials(${ACC}Landroid/os/Bundle;Landroid/app/Activity;${CB}${H})${F}`]: (a: JAccount, options: JBundle | null, activity: unknown, callback: unknown, handler: JHandler | null) =>
    requestAccount({ type: a.type, method: "confirmCredentials", args: [a, accountOptions(options)], activity, callback, handler }),
  [`updateCredentials(${ACC}${S}Landroid/os/Bundle;Landroid/app/Activity;${CB}${H})${F}`]: (a: JAccount, token: string, options: JBundle | null, activity: unknown, callback: unknown, handler: JHandler | null) =>
    requestAccount({ type: a.type, method: "updateCredentials", args: [a, token, accountOptions(options)], activity, callback, handler }),
  [`editProperties(${S}Landroid/app/Activity;${CB}${H})${F}`]: (type: string, activity: unknown, callback: unknown, handler: JHandler | null) =>
    requestAccount({ type, method: "editProperties", args: [type], activity, callback, handler }),
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
  [`getAccountsAndVisibilityForPackage(${S}${S})Ljava/util/Map;`]: driven(function* (pkg: string, type: string | null): Gen  {
    const result = (yield newObj("java/util/HashMap"));
    for (const account of accounts()) if (owns(account) && (type === null || account.type === type)) {
      const visibility = packages.get(account.owner)?.uid === packages.get(pkg)?.uid ? 1 : account.visibility[pkg] ?? 4;
      (yield vcall(result, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", toJ(account), boxInt(visibility)));
    }
    return result;
  }),
  [`notifyAccountAuthenticated(${ACC})Z`]: (a: JAccount) => +!!find(a),
};
rt.register({ name: "android/accounts/AccountManager", ctor: JAccountManager, statics, methods });
