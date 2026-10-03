// An app's data, by the owners that keep it. Clearing it is installd's clearAppData with the
// per-package state ActivityManager and PackageManager reset beside it (clearApplicationUserData);
// removing the package (uninstall, the shell's reset) also takes its install state and what the
// system keeps for it while it is installed.
import type { processBroker } from "./processes";
import { clearWebData } from "../android/webstorage";
import { clearKeystore } from "../android/keystore";
import { clearPersistedGrants } from "../android/urigrants";
import { forgetLegacySnapshots } from "../android/sqlite";
import { forgetExitRecords, REASON_USER_REQUESTED } from "../android/server/appexitinfo";
import { forgetInstall, knownUid, packages } from "../android/packages";
import { installedPath } from "../android/pm";
import { forgetPackage } from "./packages";

type Broker = ReturnType<typeof processBroker>;
/** the platform's preference files of a package that a data clear keeps: DeviceIdleController's
 *  allowlist (ActivityTaskManager's per-app night mode and locales go, onPackageDataCleared) */
const KEPT_ON_CLEAR = new Set(["__system_power"]);
const preferenceFiles = (broker: Broker, pkg: string) => broker.preferences.names(pkg + ":");

/** clearApplicationUserData after the force stop: `fromApp` (the app cleared itself) keeps its
 *  notification channels, and `keepState` its notification state and URI grants */
export async function clearAppData(broker: Broker, pkg: string, fromApp: boolean, keepState = false): Promise<void> {
  const uid = packages.get(pkg)?.uid ?? knownUid(pkg);
  if (uid !== undefined) {
    broker.alarms.removeForUid(uid);
    clearKeystore(uid);
  }
  if (!keepState) {
    broker.notifications.clearData(pkg, fromApp);
    clearPersistedGrants(pkg);
  }
  broker.permissions.revoke(pkg);
  for (const name of preferenceFiles(broker, pkg)) if (!KEPT_ON_CLEAR.has(name.slice(pkg.length + 1))) broker.preferences.remove(name);
  forgetLegacySnapshots(["/data/data/", "/data/user/0/", "/data/user_de/0/"].map((root) => root + pkg));
  (await broker.cookies(pkg)).remove();
  await Promise.all([broker.files.clearPackage(pkg), clearWebData(pkg)]);
}

/** a removed package's data and the state kept for it while installed: its senders, the accounts its
 *  authenticator kept, exit records and install state */
export async function removePackageData(broker: Broker, pkg: string): Promise<void> {
  await clearAppData(broker, pkg, false);
  broker.intents.cancelPackage(pkg);
  broker.accounts.removePackage(pkg);
  for (const name of preferenceFiles(broker, pkg)) broker.preferences.remove(name);
  (await broker.cookies(pkg)).forget();
  forgetExitRecords(pkg);
  forgetInstall(pkg);
}

/** what happens to a package's data: clearApplicationUserData's clear, or its removal with the package */
export type PackageDataChange = { kind: "clear"; fromApp: boolean; keepState: boolean } | { kind: "remove" };
/** the package stops (its processes die and its services go), then its data is cleared, or it is
 *  removed with its installed archive */
export async function changePackageData(broker: Broker, pkg: string, change: PackageDataChange): Promise<void> {
  if (change.kind === "clear") {
    await broker.forceStop(pkg, { reason: REASON_USER_REQUESTED, description: `stop ${pkg} due to clear data` });
    return clearAppData(broker, pkg, change.fromApp, change.keepState);
  }
  await broker.forceStop(pkg);
  await broker.packageRemoved(pkg);
  await removePackageData(broker, pkg);
  await forgetPackage(installedPath(pkg));
}

/** every package some owner keeps state for: those installed, and those named by persisted state */
export function packagesWithData(broker: Broker): string[] {
  const names = new Set([...packages.keys(), ...broker.accounts.records.map((s) => s.owner)]);
  const storage = globalThis.localStorage;
  for (let i = 0; storage && i < storage.length; i++) {
    const pkg = /^wd:(?:install|permissions|exit-info|web-cookies|prefs):([^:]+)/.exec(storage.key(i)!)?.[1];
    if (pkg) names.add(pkg);
  }
  return [...names];
}
