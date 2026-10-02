// IAccountManager, the TS half of AOSP's AccountManager: AccountManager, Account,
// AbstractAccountAuthenticator, AccountAuthenticatorResponse and AuthenticatorDescription run from
// bytecode, and accounts live in the broker's store, shared by every process. An operation an
// authenticator answers runs as an AccountManagerService session: bind the authenticator's
// service, call its IAccountAuthenticator with a response Stub, and relay what it reports.
import { JObj, rt, noops, declaredField } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import { newObj, scall, vcall } from "../jvm/natives/jlang";
import { boxInt } from "../jvm/natives/jbox";
import { toJsArray } from "../jvm/natives/jcoll";
import { appHost } from "./apphost";
import { PROCESS_PID, PROCESS_UID, reportUncaught } from "./os";
import { packages, qualifyComponent } from "./packages";
import { AccountStore, type StoredAccount } from "../shell/accounts";
import { attr, attrStr, parseAXML } from "./axml";
import { servicesMatching } from "./pm";
import { resString } from "./res";
import { asSystem, hostStub } from "./binder";
import { bindAsSystem } from "./runningservices";
import { mkComponentName } from "./intent";
import { deliverBroadcast } from "./server/broadcastqueue";

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
let accountStore = new AccountStore(), stopAccountUpdates = () => {};
/** AccountManagerService's broadcasts on a change, which AccountManager's listeners hear */
const CHANGED = ["android.accounts.action.VISIBLE_ACCOUNTS_CHANGED", "android.accounts.LOGIN_ACCOUNTS_CHANGED"];
function accountsChanged(): void {
  if (!appHost) return;
  for (const action of CHANGED) {
    void newObj("android/content/Intent", "(Ljava/lang/String;)V", action)
      .then((intent) => deliverBroadcast(intent, null, false, { code: 0, data: null, extras: null, aborted: false }, null)).catch(reportUncaught);
  }
}
export function useAccountStore(store: AccountStore): () => void {
  stopAccountUpdates(); accountStore = store;
  return stopAccountUpdates = store.watch(accountsChanged);
}
useAccountStore(accountStore);
const accounts = () => accountStore.records;
const persist = () => accountStore.persist();
const caller = () => appHost?.pkg ?? "";
const sameUid = (a: string, b: string) => packages.get(a) !== undefined && packages.get(a)?.uid === packages.get(b)?.uid;
function visible(s: StoredAccount, pkg = caller()): boolean {
  return sameUid(s.owner, pkg) || s.visibility[pkg] === 1 || s.visibility[pkg] === 2;
}
/** an account's visibility to `pkg`: its owner's uid always sees it */
const visibilityFor = (s: StoredAccount, pkg: string) => sameUid(s.owner, pkg) ? 1 : s.visibility[pkg] ?? 4;
const field = (account: JObj, name: string) => (account as unknown as Record<string, string>)[declaredField("android/accounts/Account", name)];
const stored = (account: JObj | null) => account ? accounts().find((s) => s.name === field(account, "name") && s.type === field(account, "type")) : undefined;
/** an account the caller manages: its authenticator is the caller's */
function owned(account: JObj | null): StoredAccount | undefined {
  if (!account) throw rt.mkThrowable("java/lang/IllegalArgumentException", "account is null");
  const type = field(account, "type"), owner = authenticatorFor(type)?.pkg;
  if (!owner || !sameUid(owner, caller())) throw rt.mkThrowable("java/lang/SecurityException", `uid ${PROCESS_UID} cannot manage accounts of type: ${type}`);
  return stored(account);
}
const javaAccount = (s: StoredAccount) => newObj("android/accounts/Account", "(Ljava/lang/String;Ljava/lang/String;)V", s.name, s.type);
const accountArray = async (list: StoredAccount[]) => jarray(await Promise.all(list.map(javaAccount)), "Landroid/accounts/Account;");
const byType = (type: string | null, pkg = caller()) => accountArray(accounts().filter((s) => (type === null || s.type === type) && visible(s, pkg)));
function drop(s: StoredAccount | undefined): number {
  const i = s ? accounts().indexOf(s) : -1;
  if (i < 0) return 0;
  accounts().splice(i, 1); persist();
  return 1;
}
async function bundle(values: Record<string, string | JObj | number | boolean>): Promise<JObj> {
  const b = await newObj("android/os/Bundle");
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") await vcall(b, "putString", "(Ljava/lang/String;Ljava/lang/String;)V", key, value);
    else if (typeof value === "number") await vcall(b, "putInt", "(Ljava/lang/String;I)V", key, value);
    else if (typeof value === "boolean") await vcall(b, "putBoolean", "(Ljava/lang/String;Z)V", key, +value);
    else await vcall(b, "putParcelableArray", "(Ljava/lang/String;[Landroid/os/Parcelable;)V", key, value);
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
  process?: (result: JObj) => Promise<JObj | SessionError>;
};
class SessionError { constructor(readonly code: number, readonly message: string) {} }
class JAccountSession extends JObj {
  response: JObj | null = null; options: SessionOptions = {}; unbind: () => Promise<void> = async () => {};
  /** the response to answer, and the session closed unless it waits on an activity */
  take(keepOpen: boolean): JObj | null {
    const response = this.response;
    if (!keepOpen) { this.response = null; void this.unbind().catch(reportUncaught); }
    return response;
  }
}
rt.register({ name: "webdroid/AccountSession", ctor: JAccountSession, sup: "android/accounts/IAccountAuthenticatorResponse$Stub",
  ifaces: ["android/os/IBinder$DeathRecipient"], methods: {
    "onResult(Landroid/os/Bundle;)V": async function (this: JAccountSession, result: JObj | null) {
      if (!this.response) return;
      if (!result) { const response = this.take(false); if (response) await fail(response, ERROR_INVALID_RESPONSE, "null bundle returned"); return; }
      const launch = !!this.options.expectActivityLaunch && !!await has(result, "intent");
      const processed = this.options.process ? await this.options.process(result) : result;
      const response = this.take(launch && !(processed instanceof SessionError));
      if (!response) return;
      if (processed instanceof SessionError) { await fail(response, processed.code, processed.message); return; }
      result = processed;
      if (!this.options.keepToken) await vcall(result, "remove", "(Ljava/lang/String;)V", "authtoken");
      await reply(response, result);
    },
    "onRequestContinued()V": () => {},
    "onError(ILjava/lang/String;)V": async function (this: JAccountSession, code: number, message: string | null) {
      const response = this.take(false);
      if (response) await fail(response, code, message ?? "");
    },
    "binderDied()V": async function (this: JAccountSession) {
      const response = this.take(false);
      if (response) await fail(response, ERROR_REMOTE, "disconnected");
    },
  } });
let nextSession = 1;
async function session(type: string, response: JObj, call: (authenticator: JObj, session: JAccountSession) => Promise<unknown>, options: SessionOptions = {}): Promise<void> {
  const owner = authenticatorFor(type);
  if (!owner) { await fail(response, ERROR_BAD_ARGUMENTS, "unknown account type"); return; }
  const s: JAccountSession = await newObj("webdroid/AccountSession");
  s.response = response; s.options = options;
  try {
    const { binder, unbind } = await bindAsSystem(await mkComponentName(owner.pkg, owner.cls), `account:${PROCESS_PID}:${nextSession++}`, "android.accounts.AccountAuthenticator");
    s.unbind = unbind;
    await vcall(binder, "linkToDeath", "(Landroid/os/IBinder$DeathRecipient;I)V", s, 0);
    const authenticator = await scall("android/accounts/IAccountAuthenticator$Stub", "asInterface", "(Landroid/os/IBinder;)Landroid/accounts/IAccountAuthenticator;", binder);
    await asSystem(() => call(authenticator, s));
  } catch (error) {
    reportUncaught(error);
    const lost = s.take(false);
    if (lost) await fail(lost, ERROR_REMOTE, "bind failure");
  }
}
/** the caller's identity, which AccountManagerService adds to what an authenticator is asked */
async function withCaller(options: JObj | null): Promise<JObj> {
  const b = options ?? await newObj("android/os/Bundle");
  await vcall(b, "putInt", "(Ljava/lang/String;I)V", "callerUid", PROCESS_UID);
  await vcall(b, "putInt", "(Ljava/lang/String;I)V", "callerPid", PROCESS_PID);
  return b;
}
/** an account's features, asked of its authenticator in a session of its own */
function hasFeatures(account: JObj, features: string[]): Promise<boolean> {
  return new Promise((resolve, reject) => {
    void newObj("webdroid/AccountFeatures").then((response: JAccountFeatures) => {
      response.settle = resolve;
      return session(field(account, "type"), response, (auth, s) =>
        vcall(auth, "hasFeatures", "(Landroid/accounts/IAccountAuthenticatorResponse;Landroid/accounts/Account;[Ljava/lang/String;)V", s, account, features));
    }).catch(reject);
  });
}
class JAccountFeatures extends JObj { settle: (has: boolean) => void = () => {}; }
rt.register({ name: "webdroid/AccountFeatures", ctor: JAccountFeatures, sup: "android/accounts/IAccountManagerResponse$Stub", methods: {
  "onResult(Landroid/os/Bundle;)V": async function (this: JAccountFeatures, result: JObj) {
    this.settle(!!await vcall(result, "getBoolean", "(Ljava/lang/String;Z)Z", "booleanResult", 0));
  },
  "onError(ILjava/lang/String;)V": function (this: JAccountFeatures) { this.settle(false); },
} });

const RESPONSE = "Landroid/accounts/IAccountManagerResponse;", AUTH = "Landroid/accounts/IAccountAuthenticatorResponse;";
const A = "Landroid/accounts/Account;", S = "Ljava/lang/String;", B = "Landroid/os/Bundle;";
rt.register({ name: "webdroid/AccountManagerService", ctor: class extends JObj {}, sup: "android/accounts/IAccountManager$Stub", methods: {
  [`getAccountsAsUser(${S}I${S})[${A}`]: (type: string | null) => byType(type),
  [`getAccountsForPackage(${S}I${S})[${A}`]: (pkg: string) => byType(null, pkg),
  [`getAccountsByTypeForPackage(${S}${S}${S})[${A}`]: (type: string | null, pkg: string) => {
    if (pkg !== caller() && !(type && sameUid(authenticatorFor(type)?.pkg ?? "", caller())))
      throw rt.mkThrowable("java/lang/SecurityException", `uid ${PROCESS_UID} cannot get accounts of other packages`);
    return byType(type, pkg);
  },
  "getAuthenticatorTypes(I)[Landroid/accounts/AuthenticatorDescription;": async () => jarray(await Promise.all(authenticators().map((a) =>
    newObj("android/accounts/AuthenticatorDescription", "(Ljava/lang/String;Ljava/lang/String;IIIIZ)V",
      a.type, a.pkg, a.label, a.icon, a.smallIcon, a.preferences, +a.customTokens))), "Landroid/accounts/AuthenticatorDescription;"),
  [`addAccountExplicitly(${A}${S}${B}${S})Z`]: (account: JObj, password: string | null, extras: JObj | null) => addExplicitly(account, password, extras, null),
  [`addAccountExplicitlyWithVisibility(${A}${S}${B}Ljava/util/Map;${S})Z`]: addExplicitly,
  [`removeAccountExplicitly(${A})Z`]: (account: JObj) => drop(owned(account)),
  [`accountAuthenticated(${A})Z`]: (account: JObj) => +!!owned(account),
  [`someUserHasAccount(${A})Z`]: (account: JObj) => +!!stored(account),
  [`hasAccountAccess(${A}${S}Landroid/os/UserHandle;)Z`]: (account: JObj, pkg: string) => { const s = stored(account); return +(!!s && visible(s, pkg)); },
  [`getPassword(${A})${S}`]: (account: JObj) => owned(account)?.password ?? null,
  // a new password invalidates every token issued under the old one
  [`setPassword(${A}${S})V`]: (account: JObj, password: string | null) => {
    const s = owned(account);
    if (s) { s.password = password; s.tokens = Object.create(null); persist(); }
  },
  [`clearPassword(${A})V`]: (account: JObj) => {
    const s = owned(account);
    if (s) { s.password = null; s.tokens = Object.create(null); persist(); }
  },
  [`getUserData(${A}${S})${S}`]: (account: JObj, key: string) => owned(account)?.data[key] ?? null,
  [`setUserData(${A}${S}${S})V`]: (account: JObj, key: string, value: string | null) => {
    const s = owned(account);
    if (!s) return;
    if (value == null) delete s.data[key]; else s.data[key] = value;
    persist();
  },
  [`peekAuthToken(${A}${S})${S}`]: (account: JObj, type: string) => owned(account)?.tokens[type] ?? null,
  [`setAuthToken(${A}${S}${S})V`]: (account: JObj, type: string, token: string | null) => {
    const s = owned(account);
    if (!s) return;
    if (token == null) delete s.tokens[type]; else s.tokens[type] = token;
    persist();
  },
  [`invalidateAuthToken(${S}${S})V`]: (type: string, token: string | null) => {
    for (const s of accounts()) for (const k of Object.keys(s.tokens)) if (s.type === type && s.tokens[k] === token) delete s.tokens[k];
    persist();
  },
  [`getPreviousName(${A})${S}`]: (account: JObj) => owned(account)?.previousName ?? null,
  [`getAccountVisibility(${A}${S})I`]: (account: JObj, pkg: string) => { const s = owned(account); return s ? visibilityFor(s, pkg) : 0; },
  [`setAccountVisibility(${A}${S}I)Z`]: (account: JObj, pkg: string, visibility: number) => {
    const s = owned(account);
    if (!s || !packages.has(pkg) || visibility < 0 || visibility > 4) return 0;
    if (visibility) s.visibility[pkg] = visibility; else delete s.visibility[pkg];
    persist(); return 1;
  },
  [`getPackagesAndVisibilityForAccount(${A})Ljava/util/Map;`]: async (account: JObj) => {
    const s = owned(account), map = await newObj("java/util/HashMap");
    for (const [pkg, visibility] of Object.entries(s?.visibility ?? {})) await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", pkg, boxInt(visibility));
    return map;
  },
  [`getAccountsAndVisibilityForPackage(${S}${S})Ljava/util/Map;`]: async (pkg: string, type: string | null) => {
    const map = await newObj("java/util/HashMap");
    for (const s of accounts()) if ((type === null || s.type === type) && sameUid(authenticatorFor(s.type)?.pkg ?? "", caller())) {
      await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", await javaAccount(s), boxInt(visibilityFor(s, pkg)));
    }
    return map;
  },
  // every process hears its own broadcast when the shared store changes
  ...noops(`registerAccountListener([${S}${S})V`, `unregisterAccountListener([${S}${S})V`, `onAccountAccessed(${S})V`),

  [`addAccount(${RESPONSE}${S}${S}[${S}Z${B})V`]: addAccount,
  [`addAccountAsUser(${RESPONSE}${S}${S}[${S}Z${B}I)V`]: addAccount,
  [`getAuthToken(${RESPONSE}${A}${S}ZZ${B})V`]: getAuthToken,
  [`getAuthTokenLabel(${RESPONSE}${S}${S})V`]: (response: JObj, type: string, tokenType: string) =>
    session(type, response, (auth, s) => vcall(auth, "getAuthTokenLabel", `(${AUTH}${S})V`, s, tokenType)),
  [`hasFeatures(${RESPONSE}${A}[${S}I${S})V`]: (response: JObj, account: JObj, features: string[]) =>
    session(field(account, "type"), response, (auth, s) => vcall(auth, "hasFeatures", `(${AUTH}${A}[${S})V`, s, account, features)),
  [`removeAccountAsUser(${RESPONSE}${A}ZI)V`]: (response: JObj, account: JObj, expectActivityLaunch: number) => {
    const s = owned(account);
    return session(field(account, "type"), response, (auth, r) => vcall(auth, "getAccountRemovalAllowed", `(${AUTH}${A})V`, r, account), {
      expectActivityLaunch: !!expectActivityLaunch,
      process: async (result) => {
        if (!await has(result, "intent") && await vcall(result, "getBoolean", "(Ljava/lang/String;)Z", "booleanResult")) drop(s);
        return result;
      },
    });
  },
  [`confirmCredentialsAsUser(${RESPONSE}${A}${B}ZI)V`]: (response: JObj, account: JObj, options: JObj | null, expectActivityLaunch: number) =>
    session(field(account, "type"), response, (auth, s) => vcall(auth, "confirmCredentials", `(${AUTH}${A}${B})V`, s, account, options),
      { expectActivityLaunch: !!expectActivityLaunch }),
  [`updateCredentials(${RESPONSE}${A}${S}Z${B})V`]: (response: JObj, account: JObj, tokenType: string | null, expectActivityLaunch: number, options: JObj | null) =>
    session(field(account, "type"), response, (auth, s) => vcall(auth, "updateCredentials", `(${AUTH}${A}${S}${B})V`, s, account, tokenType, options),
      { expectActivityLaunch: !!expectActivityLaunch }),
  [`editProperties(${RESPONSE}${S}Z)V`]: (response: JObj, type: string, expectActivityLaunch: number) =>
    session(type, response, (auth, s) => vcall(auth, "editProperties", `(${AUTH}${S})V`, s, type), { expectActivityLaunch: !!expectActivityLaunch }),
  [`getAccountsByFeatures(${RESPONSE}${S}[${S}${S})V`]: async (response: JObj, type: string, features: string[] | null) => {
    const matches: StoredAccount[] = [];
    for (const s of accounts()) if (s.type === type && visible(s) && (!features?.length || await hasFeatures(await javaAccount(s), features))) matches.push(s);
    await reply(response, await bundle({ accounts: await accountArray(matches) }));
  },
  [`renameAccount(${RESPONSE}${A}${S})V`]: async (response: JObj, account: JObj, name: string) => {
    const s = owned(account);
    if (s) { s.previousName = s.name; s.name = name; persist(); }
    await reply(response, await bundle(s ? { authAccount: s.name, accountType: s.type } : {}));
  },
} });
hostStub("account", "webdroid/AccountManagerService");

function addExplicitly(account: JObj, password: string | null, extras: JObj | null, visibility: JObj | null): Promise<number> {
  return (async () => {
    if (owned(account)) return 0;
    const data: Record<string, string> = Object.create(null);
    if (extras) for (const key of await toJsArray(await vcall(await vcall(extras, "keySet", "()Ljava/util/Set;"), "toArray", "()[Ljava/lang/Object;")) as string[]) {
      const value = await vcall(extras, "get", "(Ljava/lang/String;)Ljava/lang/Object;", key);
      if (value != null) data[key] = typeof value === "string" ? value : await vcall(value, "toString", "()Ljava/lang/String;");
    }
    const visibilities: Record<string, number> = Object.create(null);
    if (visibility) for (const entry of await toJsArray(await vcall(await vcall(visibility, "entrySet", "()Ljava/util/Set;"), "toArray", "()[Ljava/lang/Object;")) as JObj[]) {
      const pkg: string = await vcall(entry, "getKey", "()Ljava/lang/Object;");
      visibilities[pkg] = await vcall(await vcall(entry, "getValue", "()Ljava/lang/Object;"), "intValue", "()I");
    }
    accounts().push({ name: field(account, "name"), type: field(account, "type"), owner: authenticatorFor(field(account, "type"))!.pkg,
      password, data, tokens: Object.create(null), visibility: visibilities });
    persist();
    return 1;
  })();
}
async function addAccount(response: JObj, type: string, tokenType: string | null, features: string[] | null, expectActivityLaunch: number, options: JObj | null) {
  const withIdentity = await withCaller(options);
  return session(type, response, (auth, s) => vcall(auth, "addAccount", `(${AUTH}${S}${S}[${S}${B})V`, s, type, tokenType, features, withIdentity),
    { expectActivityLaunch: !!expectActivityLaunch });
}
/** a cached token answers at once unless the authenticator keeps its own; a new one is cached */
async function getAuthToken(response: JObj, account: JObj, tokenType: string, notifyOnFailure: number, expectActivityLaunch: number, options: JObj | null) {
  const type = field(account, "type"), custom = !!authenticatorFor(type)?.customTokens, s = stored(account);
  if (!s || !visible(s)) { await fail(response, ERROR_BAD_ARGUMENTS, "account doesn't exist"); return; }
  const cached = custom ? undefined : s.tokens[tokenType];
  if (cached !== undefined) { await reply(response, await bundle({ authtoken: cached, authAccount: s.name, accountType: s.type })); return; }
  const withIdentity = await withCaller(options);
  if (notifyOnFailure) await vcall(withIdentity, "putBoolean", "(Ljava/lang/String;Z)V", "notifyOnAuthFailure", 1);
  return session(type, response, (auth, r) => vcall(auth, "getAuthToken", `(${AUTH}${A}${S}${B})V`, r, account, tokenType, withIdentity), {
    expectActivityLaunch: !!expectActivityLaunch, keepToken: true,
    process: async (result) => {
      const token = await bundleString(result, "authtoken");
      if (token === null) return result;
      const name = await bundleString(result, "authAccount"), resultType = await bundleString(result, "accountType");
      if (!name || !resultType) return new SessionError(ERROR_INVALID_RESPONSE, "the type and name should not be empty");
      const target = !custom && accounts().find((a) => a.name === name && a.type === resultType);
      if (target) { target.tokens[tokenType] = token; persist(); }
      return result;
    },
  });
}
