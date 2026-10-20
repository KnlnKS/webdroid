// system_server's AccountManagerService over the broker's account store: AccountManager, Account,
// AbstractAccountAuthenticator, AccountAuthenticatorResponse and AuthenticatorDescription run from
// bytecode in the apps, which reach this one service by Binder. An operation an authenticator
// answers runs as a session: bind the authenticator's service, call its IAccountAuthenticator
// with a response Stub, and relay what it reports.
import { awaited, JObj, rt, noops, getDeclared, driven, type Gen } from "../jvm/runtime.ts";
import { jarray } from "../jvm/abi.ts";
import { newObj, scall, vcall, after } from "../jvm/natives/jentry.ts";
import { logUncaught, detached } from "../jvm/natives/jthrowable.ts";
import { boxInt } from "../jvm/natives/jbox.ts";
import { toJsArray } from "../jvm/natives/jcoll.ts";
import { packages, qualifyComponent, ownedBy, uidPackages } from "./packages.ts";
import { AccountStore, canonicalAccountCommands, type AccountAccess, type AccountAuthority, type AccountChange, type AccountKey, type AccountSummary, type StoredAccount } from "../shell/accounts.ts";
import { attr, attrStr, parseAXML } from "./axml.ts";
import { servicesMatching } from "./pm.ts";
import { resString } from "./res.ts";
import { asSystem, callingIdentity, hostService, type Caller } from "./binder.ts";
import { bindAsSystem } from "./server/activeservices.ts";
import { mkComponentName, newIntent } from "./intent.ts";
import { broadcastIntent } from "./server/broadcastqueue.ts";

type Authenticator = { type: string; pkg: string; cls: string; label: number; icon: number; smallIcon: number; preferences: number; customTokens: boolean };
/** the manifests' authenticator services, each described by its <account-authenticator> resource */
function authenticators(): Authenticator[] {
  const out: Authenticator[] = [];
  for (const { node, owner } of servicesMatching("android.accounts.AccountAuthenticator")) {
    if (!owner.enabled || attr(node, "enabled")?.data === 0) continue;
    const meta = node.children.find((md) => md.name === "meta-data" && attrStr(md, "name") === "android.accounts.AccountAuthenticator");
    const id = meta && attr(meta, "resource")?.data;
    const bytes = id ? owner.res.fileOf(id)?.bytes : null;
    if (!bytes) continue;
    const n = parseAXML(bytes), ref = (name: string) => attr(n, name)?.data ?? 0;
    out.push({
      // accountType is a literal or a @string reference; a reference has no string of its own
      type: attr(n, "accountType")?.str ?? resString(owner.res, ref("accountType")) ?? "", pkg: owner.pkg,
      cls: qualifyComponent(attrStr(node, "name") ?? "", owner.pkg), label: ref("label"), icon: ref("icon"),
      smallIcon: ref("smallIcon"), preferences: ref("accountPreferences"), customTokens: !!attr(n, "customTokens")?.data,
    });
  }
  return out;
}
const authenticatorFor = (type: string) => authenticators().find((a) => a.type === type);

// ── the store, and what a caller may see and change of it
let stopAccountUpdates = () => {};
/** AccountManagerService's broadcasts on a change, which AccountManager's listeners hear */
const CHANGED = ["android.accounts.action.VISIBLE_ACCOUNTS_CHANGED", "android.accounts.LOGIN_ACCOUNTS_CHANGED"];
function accountsChanged(): void {
  for (const action of CHANGED) asSystem(() => after(newIntent(action), (intent) => broadcastIntent(intent, [], false))).catch(logUncaught);
}
export function useAccountStore(store: AccountStore): () => void {
  stopAccountUpdates(); accountAccess = canonicalAccountCommands(store, accountAuthority);
  return stopAccountUpdates = store.watch(accountsChanged);
}
function accountAuthority(): AccountAuthority {
  const { uid } = callingIdentity();
  return { caller: caller(uid), authenticator: (type: string) => authenticatorFor(type)?.pkg, sameUid, known: (pkg: string) => packages.has(pkg),
    denied: (type: string): never => { throw rt.mkThrowable("java/lang/SecurityException", `uid ${uid} cannot manage accounts of type: ${type}`); } };
}
let accountAccess: AccountAccess;
/** the calling uid's package, as getPackageNameForUid picks one */
const caller = (uid = callingIdentity().uid) => uidPackages(uid)[0]?.pkg ?? "";
const sameUid = (a: string, b: string) => ownedBy(b, packages.get(a)?.uid ?? -1);
useAccountStore(new AccountStore());
/** an account's visibility to `pkg`: its owner's uid always sees it */
const visibilityFor = (s: AccountSummary, pkg: string) => sameUid(s.owner, pkg) ? 1 : s.visibility[pkg] ?? 4;
const field = (account: JObj, name: string) => getDeclared<string>(account, "android/accounts/Account", name);
const keyOf = (account: JObj): AccountKey => ({ name: field(account, "name"), type: field(account, "type") });
function owned(account: JObj | null): StoredAccount | null | Promise<StoredAccount | null> {
  if (!account) throw rt.mkThrowable("java/lang/IllegalArgumentException", "account is null");
  return accountAccess.accountRead(keyOf(account));
}
const javaAccount = (s: AccountKey) => newObj("android/accounts/Account", "(Ljava/lang/String;Ljava/lang/String;)V", s.name, s.type);
const accountArray = driven(function* (list: AccountSummary[]): Gen<JObj[]> {
  const out: JObj[] = [];
  for (const s of list) out.push(yield javaAccount(s));
  return jarray(out, "Landroid/accounts/Account;");
});
const byType = (type: string | null, pkg = caller()) => after(accountAccess.accountList({ type, pkg }), accountArray);
const changeOwned = (account: JObj, change: (key: AccountKey) => AccountChange) => after(owned(account), s => s ? accountAccess.accountChange(change(s)) : 0);
const drop = (s: StoredAccount | null) => s ? accountAccess.accountChange({ kind: "drop", key: s }) : 0;
const setPassword = (account: JObj, value: string | null) => changeOwned(account, key => ({ kind: "password", key, value }));
const setEntry = (account: JObj, field: "data" | "tokens", name: string, value: string | null) => changeOwned(account, key => ({ kind: "entry", key, field, name, value }));
function* bundle(values: Record<string, string | JObj | number | boolean>): Gen<JObj> {
  const b = yield newObj("android/os/Bundle");
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") yield vcall(b, "putString", "(Ljava/lang/String;Ljava/lang/String;)V", key, value);
    else if (typeof value === "number") yield vcall(b, "putInt", "(Ljava/lang/String;I)V", key, value);
    else if (typeof value === "boolean") yield vcall(b, "putBoolean", "(Ljava/lang/String;Z)V", key, +value);
    else yield vcall(b, "putParcelableArray", "(Ljava/lang/String;[Landroid/os/Parcelable;)V", key, value);
  }
  return b;
}

// ── sessions with an authenticator
const ERROR_REMOTE = 1, ERROR_INVALID_RESPONSE = 5, ERROR_BAD_ARGUMENTS = 7;
const reply = (response: JObj, result: JObj) => vcall(response, "onResult", "(Landroid/os/Bundle;)V", result);
const fail = (response: JObj, code: number, message: string) => vcall(response, "onError", "(ILjava/lang/String;)V", code, message);
const bundleString = (b: JObj, key: string): Promise<string | null> => vcall(b, "getString", "(Ljava/lang/String;)Ljava/lang/String;", key);
const has = (b: JObj, key: string): Promise<number> => vcall(b, "containsKey", "(Ljava/lang/String;)Z", key);
type SessionOptions = {
  /** the session stays open past an intent the caller will launch, for the activity's result */
  expectActivityLaunch?: boolean;
  /** only getAuthToken hands its caller the token */
  keepToken?: boolean;
  /** what AccountManagerService does with a result before relaying it, or the error it answers instead */
  process?: (result: JObj) => Gen<JObj | SessionError>;
};
class SessionError { readonly code: number; readonly message: string; constructor(code: number, message: string) { this.code = code; this.message = message; } }
class JAccountSession extends JObj {
  response: JObj | null = null; options: SessionOptions = {}; unbind: () => unknown = () => {};
  /** the response to answer, and the session closed unless it waits on an activity */
  take(keepOpen: boolean): JObj | null {
    const response = this.response;
    if (!keepOpen) { this.response = null; detached(this.unbind, logUncaught); }
    return response;
  }
}
rt.register({ name: "webdroid/AccountSession", ctor: JAccountSession, sup: "android/accounts/IAccountAuthenticatorResponse$Stub",
  ifaces: ["android/os/IBinder$DeathRecipient"], methods: {
    "onResult(Landroid/os/Bundle;)V": driven(function* (this: JAccountSession, result: JObj | null): Gen<void> {
      if (!this.response) return;
      if (!result) { const response = this.take(false); if (response) yield fail(response, ERROR_INVALID_RESPONSE, "null bundle returned"); return; }
      const launch = !!this.options.expectActivityLaunch && !!(yield* awaited(has(result, "intent")));
      const processed = this.options.process ? yield* this.options.process(result) : result;
      const response = this.take(launch && !(processed instanceof SessionError));
      if (!response) return;
      if (processed instanceof SessionError) { yield fail(response, processed.code, processed.message); return; }
      result = processed;
      if (!this.options.keepToken) yield vcall(result, "remove", "(Ljava/lang/String;)V", "authtoken");
      yield reply(response, result);
    }),
    "onRequestContinued()V": () => {},
    "onError(ILjava/lang/String;)V": function (this: JAccountSession, code: number, message: string | null) {
      const response = this.take(false);
      return response && fail(response, code, message ?? "");
    },
    "binderDied()V": function (this: JAccountSession) {
      const response = this.take(false);
      return response && fail(response, ERROR_REMOTE, "disconnected");
    },
  } });
let nextSession = 1;
const session = driven(function* (type: string, response: JObj, call: (authenticator: JObj, session: JAccountSession) => unknown, options: SessionOptions = {}): Gen<void> {
  const owner = authenticatorFor(type);
  if (!owner) { yield fail(response, ERROR_BAD_ARGUMENTS, "unknown account type"); return; }
  const s: JAccountSession = yield newObj("webdroid/AccountSession");
  s.response = response; s.options = options;
  try {
    const { binder, unbind } = yield* awaited(bindAsSystem(yield* awaited(mkComponentName(owner.pkg, owner.cls)), "account:" + nextSession++, "android.accounts.AccountAuthenticator"));
    s.unbind = unbind;
    yield vcall(binder, "linkToDeath", "(Landroid/os/IBinder$DeathRecipient;I)V", s, 0);
    const authenticator = yield scall("android/accounts/IAccountAuthenticator$Stub", "asInterface", "(Landroid/os/IBinder;)Landroid/accounts/IAccountAuthenticator;", binder);
    yield asSystem(() => call(authenticator, s));
  } catch (error) {
    logUncaught(error);
    const lost = s.take(false);
    if (lost) yield fail(lost, ERROR_REMOTE, "bind failure");
  }
});
/** the caller's identity, which AccountManagerService adds to what an authenticator is asked */
function* withCaller(options: JObj | null, { pid, uid }: Caller): Gen<JObj> {
  const b = options ?? (yield newObj("android/os/Bundle"));
  yield vcall(b, "putInt", "(Ljava/lang/String;I)V", "callerUid", uid);
  yield vcall(b, "putInt", "(Ljava/lang/String;I)V", "callerPid", pid);
  return b;
}
/** an account's features, asked of its authenticator in a session of its own */
function* hasFeatures(account: JObj, features: string[]): Gen<boolean> {
  const response: JAccountFeatures = yield newObj("webdroid/AccountFeatures");
  const settled = new Promise<boolean>((resolve) => { response.settle = resolve; });
  yield session(field(account, "type"), response, (auth, s) =>
    vcall(auth, "hasFeatures", "(Landroid/accounts/IAccountAuthenticatorResponse;Landroid/accounts/Account;[Ljava/lang/String;)V", s, account, features));
  return yield* awaited(settled);
}
class JAccountFeatures extends JObj { settle: (has: boolean) => void = () => {}; }
rt.register({ name: "webdroid/AccountFeatures", ctor: JAccountFeatures, sup: "android/accounts/IAccountManagerResponse$Stub", methods: {
  "onResult(Landroid/os/Bundle;)V": function (this: JAccountFeatures, result: JObj) {
    return after(vcall(result, "getBoolean", "(Ljava/lang/String;Z)Z", "booleanResult", 0), (has) => this.settle(!!has));
  },
  "onError(ILjava/lang/String;)V": function (this: JAccountFeatures) { this.settle(false); },
} });

const RESPONSE = "Landroid/accounts/IAccountManagerResponse;", AUTH = "Landroid/accounts/IAccountAuthenticatorResponse;";
const A = "Landroid/accounts/Account;", S = "Ljava/lang/String;", B = "Landroid/os/Bundle;";
hostService("account", "webdroid/AccountManagerService", "android/accounts/IAccountManager$Stub", {
  [`getAccountsAsUser(${S}I${S})[${A}`]: (type: string | null) => byType(type),
  [`getAccountsForPackage(${S}I${S})[${A}`]: (pkg: string) => byType(null, pkg),
  [`getAccountsByTypeForPackage(${S}${S}${S})[${A}`]: (type: string | null, pkg: string) => {
    const { uid } = callingIdentity();
    if (!ownedBy(pkg, uid) && !(type && ownedBy(authenticatorFor(type)?.pkg ?? null, uid)))
      throw rt.mkThrowable("java/lang/SecurityException", `uid ${uid} cannot get accounts of other packages`);
    return byType(type, pkg);
  },
  "getAuthenticatorTypes(I)[Landroid/accounts/AuthenticatorDescription;": driven(function* () {
    const out: JObj[] = [];
    for (const a of authenticators()) out.push(yield newObj("android/accounts/AuthenticatorDescription", "(Ljava/lang/String;Ljava/lang/String;IIIIZ)V",
      a.type, a.pkg, a.label, a.icon, a.smallIcon, a.preferences, +a.customTokens));
    return jarray(out, "Landroid/accounts/AuthenticatorDescription;");
  }),
  [`addAccountExplicitly(${A}${S}${B}${S})Z`]: (account: JObj, password: string | null, extras: JObj | null) => rt.drive(addExplicitly(account, password, extras, null)),
  [`addAccountExplicitlyWithVisibility(${A}${S}${B}Ljava/util/Map;${S})Z`]: driven(addExplicitly),
  [`removeAccountExplicitly(${A})Z`]: (account: JObj) => after(owned(account), drop),
  [`accountAuthenticated(${A})Z`]: (account: JObj) => after(owned(account), s => +!!s),
  [`someUserHasAccount(${A})Z`]: (account: JObj) => account ? after(accountAccess.accountExists(keyOf(account)), s => +s) : 0,
  [`hasAccountAccess(${A}${S}Landroid/os/UserHandle;)Z`]: (account: JObj, pkg: string) => account ? after(accountAccess.accountList({ type: field(account, "type"), pkg }), list => +list.some(s => s.name === field(account, "name"))) : 0,
  [`getPassword(${A})${S}`]: (account: JObj) => after(owned(account), s => s?.password ?? null),
  [`setPassword(${A}${S})V`]: setPassword,
  [`clearPassword(${A})V`]: (account: JObj) => setPassword(account, null),
  [`getUserData(${A}${S})${S}`]: (account: JObj, key: string) => after(owned(account), s => s?.data[key] ?? null),
  [`setUserData(${A}${S}${S})V`]: (account: JObj, key: string, value: string | null) => setEntry(account, "data", key, value),
  [`peekAuthToken(${A}${S})${S}`]: (account: JObj, type: string) => after(owned(account), s => s?.tokens[type] ?? null),
  [`setAuthToken(${A}${S}${S})V`]: (account: JObj, type: string, token: string | null) => setEntry(account, "tokens", type, token),
  [`invalidateAuthToken(${S}${S})V`]: (type: string, token: string | null) => accountAccess.accountChange({ kind: "invalidate", type, token }),
  [`getPreviousName(${A})${S}`]: (account: JObj) => after(owned(account), s => s?.previousName ?? null),
  [`getAccountVisibility(${A}${S})I`]: (account: JObj, pkg: string) => after(owned(account), s => s ? visibilityFor(s, pkg) : 0),
  [`setAccountVisibility(${A}${S}I)Z`]: (account: JObj, pkg: string, value: number) => changeOwned(account, key => ({ kind: "visibility", key, pkg, value })),
  [`getPackagesAndVisibilityForAccount(${A})Ljava/util/Map;`]: driven(function* (account: JObj) {
    const s = yield* awaited(owned(account)), map = yield newObj("java/util/HashMap");
    for (const [pkg, visibility] of Object.entries(s?.visibility ?? {})) yield vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", pkg, boxInt(visibility));
    return map;
  }),
  [`getAccountsAndVisibilityForPackage(${S}${S})Ljava/util/Map;`]: driven(function* (pkg: string, type: string | null) {
    const map = yield newObj("java/util/HashMap");
    for (const s of yield* awaited(accountAccess.accountList({ type, pkg, managed: true }))) {
      yield vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", yield javaAccount(s), boxInt(visibilityFor(s, pkg)));
    }
    return map;
  }),
  // every process hears the broadcasts a change sends
  ...noops(`registerAccountListener([${S}${S})V`, `unregisterAccountListener([${S}${S})V`, `onAccountAccessed(${S})V`),

  [`addAccount(${RESPONSE}${S}${S}[${S}Z${B})V`]: driven(addAccount),
  [`addAccountAsUser(${RESPONSE}${S}${S}[${S}Z${B}I)V`]: driven(addAccount),
  [`getAuthToken(${RESPONSE}${A}${S}ZZ${B})V`]: driven(getAuthToken),
  [`getAuthTokenLabel(${RESPONSE}${S}${S})V`]: (response: JObj, type: string, tokenType: string) =>
    session(type, response, (auth, s) => vcall(auth, "getAuthTokenLabel", `(${AUTH}${S})V`, s, tokenType)),
  [`hasFeatures(${RESPONSE}${A}[${S}I${S})V`]: (response: JObj, account: JObj, features: string[]) =>
    session(field(account, "type"), response, (auth, s) => vcall(auth, "hasFeatures", `(${AUTH}${A}[${S})V`, s, account, features)),
  [`removeAccountAsUser(${RESPONSE}${A}ZI)V`]: (response: JObj, account: JObj, expectActivityLaunch: number) => {
    return after(owned(account), s => session(field(account, "type"), response, (auth, r) => vcall(auth, "getAccountRemovalAllowed", `(${AUTH}${A})V`, r, account), {
      expectActivityLaunch: !!expectActivityLaunch,
      process: function* (result) {
        if (!(yield* awaited(has(result, "intent"))) && (yield vcall(result, "getBoolean", "(Ljava/lang/String;)Z", "booleanResult"))) yield* awaited(drop(s));
        return result;
      },
    }));
  },
  [`confirmCredentialsAsUser(${RESPONSE}${A}${B}ZI)V`]: (response: JObj, account: JObj, options: JObj | null, expectActivityLaunch: number) =>
    session(field(account, "type"), response, (auth, s) => vcall(auth, "confirmCredentials", `(${AUTH}${A}${B})V`, s, account, options),
      { expectActivityLaunch: !!expectActivityLaunch }),
  [`updateCredentials(${RESPONSE}${A}${S}Z${B})V`]: (response: JObj, account: JObj, tokenType: string | null, expectActivityLaunch: number, options: JObj | null) =>
    session(field(account, "type"), response, (auth, s) => vcall(auth, "updateCredentials", `(${AUTH}${A}${S}${B})V`, s, account, tokenType, options),
      { expectActivityLaunch: !!expectActivityLaunch }),
  [`editProperties(${RESPONSE}${S}Z)V`]: (response: JObj, type: string, expectActivityLaunch: number) =>
    session(type, response, (auth, s) => vcall(auth, "editProperties", `(${AUTH}${S})V`, s, type), { expectActivityLaunch: !!expectActivityLaunch }),
  [`getAccountsByFeatures(${RESPONSE}${S}[${S}${S})V`]: driven(function* (response: JObj, type: string, features: string[] | null) {
    const matches: AccountSummary[] = [];
    for (const s of yield* awaited(accountAccess.accountList({ type, pkg: caller() }))) if (!features?.length || (yield* hasFeatures(yield javaAccount(s), features))) matches.push(s);
    yield reply(response, yield* bundle({ accounts: yield* awaited(accountArray(matches)) }));
  }),
  [`renameAccount(${RESPONSE}${A}${S})V`]: driven(function* (response: JObj, account: JObj, name: string) {
    const s = yield* awaited(owned(account));
    const renamed = s && (yield* awaited(accountAccess.accountChange({ kind: "rename", key: s, name })));
    yield reply(response, yield* bundle(renamed ? { authAccount: name, accountType: s!.type } : {}));
  }),
});

function* addExplicitly(account: JObj, password: string | null, extras: JObj | null, visibility: JObj | null): Gen<number> {
  if (yield* awaited(owned(account))) return 0;
  const data: Record<string, string> = Object.create(null);
  if (extras) for (const key of (yield* awaited(toJsArray(yield vcall(extras, "keySet", "()Ljava/util/Set;")))) as string[]) {
    const value = yield vcall(extras, "get", "(Ljava/lang/String;)Ljava/lang/Object;", key);
    if (value != null) data[key] = typeof value === "string" ? value : yield vcall(value, "toString", "()Ljava/lang/String;");
  }
  const visibilities: Record<string, number> = Object.create(null);
  if (visibility) for (const entry of (yield* awaited(toJsArray(yield vcall(visibility, "entrySet", "()Ljava/util/Set;")))) as JObj[]) {
    const pkg: string = yield vcall(entry, "getKey", "()Ljava/lang/Object;");
    visibilities[pkg] = yield vcall(yield vcall(entry, "getValue", "()Ljava/lang/Object;"), "intValue", "()I");
  }
  return yield* awaited(accountAccess.accountChange({ kind: "add", account: { name: field(account, "name"), type: field(account, "type"), owner: authenticatorFor(field(account, "type"))!.pkg,
    password, data, tokens: Object.create(null), visibility: visibilities } }));
}
function* addAccount(response: JObj, type: string, tokenType: string | null, features: string[] | null, expectActivityLaunch: number, options: JObj | null): Gen<void> {
  const withIdentity = yield* withCaller(options, callingIdentity());
  yield session(type, response, (auth, s) => vcall(auth, "addAccount", `(${AUTH}${S}${S}[${S}${B})V`, s, type, tokenType, features, withIdentity),
    { expectActivityLaunch: !!expectActivityLaunch });
}
/** a cached token answers at once unless the authenticator keeps its own; a new one is cached */
function* getAuthToken(response: JObj, account: JObj, tokenType: string, notifyOnFailure: number, expectActivityLaunch: number, options: JObj | null): Gen<void> {
  const identity = callingIdentity(), type = field(account, "type"), custom = !!authenticatorFor(type)?.customTokens, cachedAccount = accountAccess.accountCached(keyOf(account), tokenType);
  if (!cachedAccount) { yield fail(response, ERROR_BAD_ARGUMENTS, "account doesn't exist"); return; }
  const s = cachedAccount.account, cached = custom ? undefined : cachedAccount.token;
  if (cached !== undefined) { yield reply(response, yield* bundle({ authtoken: cached, authAccount: s.name, accountType: s.type })); return; }
  const withIdentity = yield* withCaller(options, identity);
  if (notifyOnFailure) yield vcall(withIdentity, "putBoolean", "(Ljava/lang/String;Z)V", "notifyOnAuthFailure", 1);
  yield session(type, response, (auth, r) => vcall(auth, "getAuthToken", `(${AUTH}${A}${S}${B})V`, r, account, tokenType, withIdentity), {
    expectActivityLaunch: !!expectActivityLaunch, keepToken: true,
    process: function* (result) {
      const token = yield* awaited(bundleString(result, "authtoken"));
      if (token === null) return result;
      const name = yield* awaited(bundleString(result, "authAccount")), resultType = yield* awaited(bundleString(result, "accountType"));
      if (!name || !resultType) return new SessionError(ERROR_INVALID_RESPONSE, "the type and name should not be empty");
      if (!custom) yield* awaited(accountAccess.accountChange({ kind: "cache", key: { name, type: resultType }, authenticatorType: type, tokenType, token }));
      return result;
    },
  });
}
