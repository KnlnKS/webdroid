import { expect, test } from "bun:test";
import { newObj, vcall } from "../jvm/natives/jlang";
import "../natives";
import type { AppHost } from "./apphost";

test("Account equality and hash include the name and account type", async () => {
  const account = await newObj("android/accounts/Account", "(Ljava/lang/String;Ljava/lang/String;)V", "a", "b");
  expect(account.name).toBe("a");
  expect(account.type).toBe("b");
  for (const [name, type, equal] of [["a", "b", 1], ["a", "c", 0], ["c", "b", 0]]) {
    const other = await newObj("android/accounts/Account", "(Ljava/lang/String;Ljava/lang/String;)V", name, type);
    expect(await vcall(account, "equals", "(Ljava/lang/Object;)Z", other)).toBe(equal);
  }
  expect(await vcall(account, "equals", "(Ljava/lang/Object;)Z", null)).toBe(0);
  expect(await vcall(account, "hashCode", "()I")).toBe(19442);
  expect(await vcall(account, "toString", "()Ljava/lang/String;")).toBe("Account {name=a, type=b}");
});

test("Account rejects empty or null names and types", async () => {
  for (const [name, type] of [["", "type"], [null, "type"], ["name", ""], ["name", null]]) {
    await expect(newObj("android/accounts/Account", "(Ljava/lang/String;Ljava/lang/String;)V", name, type)).rejects.toThrow();
  }
});

test("account ownership protects credentials while explicit visibility exposes only identity", async () => {
  const { AccountStore } = await import("../shell/accounts"), { useAccountStore } = await import("./accounts");
  const { packages, PackageRecord } = await import("./packages"), { Resources } = await import("./res");
  const { PROCESS_PID, PROCESS_UID, setProcessIdentity } = await import("./os");
  const { appHost, setAppHost } = await import("./apphost");
  const store = new AccountStore(), names = ["test.accounts.owner", "test.accounts.client"];
  store.records.splice(0, store.records.length, { name: "fixture", type: "test.account", owner: names[0], password: null, data: {}, tokens: {}, visibility: {} });
  const stop = useAccountStore(store), originalHost = appHost, pid = PROCESS_PID, uid = PROCESS_UID;
  for (const [i, pkg] of names.entries()) packages.set(pkg, new PackageRecord({ name: "manifest", attrs: [{ name: "package", ns: "", resId: 0, type: 3, data: 0, str: pkg }], children: [] }, new Resources(null, {}), "/" + pkg, 27000 + i, async () => []));
  const manager = await newObj("android/accounts/AccountManager"), account = await newObj("android/accounts/Account", "(Ljava/lang/String;Ljava/lang/String;)V", "fixture", "test.account");
  try {
    setAppHost({ ...originalHost, pkg: names[0] } as AppHost); setProcessIdentity(pid, 27000);
    await vcall(manager, "setUserData", "(Landroid/accounts/Account;Ljava/lang/String;Ljava/lang/String;)V", account, "test", "value");
    expect((await vcall(manager, "getAccounts", "()[Landroid/accounts/Account;")).length).toBe(1);
    expect(await vcall(manager, "setAccountVisibility", "(Landroid/accounts/Account;Ljava/lang/String;I)Z", account, names[1], 1)).toBe(1);
    setAppHost({ ...originalHost, pkg: names[1] } as AppHost); setProcessIdentity(pid, 27001);
    const visible = await vcall(manager, "getAccounts", "()[Landroid/accounts/Account;");
    expect(visible.length).toBe(1); expect(visible[0].name).toBe("fixture");
    await expect(vcall(manager, "getUserData", "(Landroid/accounts/Account;Ljava/lang/String;)Ljava/lang/String;", account, "test")).rejects.toThrow();
    await expect(vcall(manager, "getPassword", "(Landroid/accounts/Account;)Ljava/lang/String;", account)).rejects.toThrow();
    await expect(vcall(manager, "removeAccountExplicitly", "(Landroid/accounts/Account;)Z", account)).rejects.toThrow();
    await expect(vcall(manager, "setAuthToken", "(Landroid/accounts/Account;Ljava/lang/String;Ljava/lang/String;)V", account, "scope", "fixture")).rejects.toThrow();
    setAppHost({ ...originalHost, pkg: names[0] } as AppHost); setProcessIdentity(pid, 27000);
    expect(await vcall(manager, "getUserData", "(Landroid/accounts/Account;Ljava/lang/String;)Ljava/lang/String;", account, "test")).toBe("value");
    expect(await vcall(manager, "setAccountVisibility", "(Landroid/accounts/Account;Ljava/lang/String;I)Z", account, names[1], 4)).toBe(1);
    setAppHost({ ...originalHost, pkg: names[1] } as AppHost); setProcessIdentity(pid, 27001);
    expect((await vcall(manager, "getAccounts", "()[Landroid/accounts/Account;")).length).toBe(0);
    packages.delete(names[0]); packages.delete(names[1]);
    expect((await vcall(manager, "getAccounts", "()[Landroid/accounts/Account;")).length).toBe(0);
  } finally {
    stop(); useAccountStore(new AccountStore()); setAppHost(originalHost); setProcessIdentity(pid, uid);
    for (const pkg of names) packages.delete(pkg);
  }
});
