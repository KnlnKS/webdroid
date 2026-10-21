// An app's data, by the owners that keep it. Clearing it is installd's clearAppData with the
// per-package state ActivityManager and PackageManager reset beside it (clearApplicationUserData);
// removing the package (uninstall, the shell's reset) clears it, then also takes its install state
// and what the system keeps for it while it is installed.
import type { Receiver } from "./broker-contract.ts";
import type { processBroker } from "./processes.ts";
import type { ParcelData } from "../android/binder.ts";
import { webData } from "../android/webstorage.ts";
import { keystoreData } from "../android/keystore.ts";
import { uriGrantData } from "../android/server/urigrants.ts";
import { exitRecordData, REASON_USER_REQUESTED } from "../android/server/appexitinfo.ts";
import { jobData } from "../android/job.ts";
import { shortcutData } from "../android/shortcuts.ts";
import { installData, knownUid, packages } from "../android/packages.ts";
import { installedPath } from "../android/pm.ts";
import { forgetPackage } from "./packages.ts";

type Broker = ReturnType<typeof processBroker>;
/** clearApplicationUserData's terms: `fromApp` (the app cleared itself) keeps its notification
 *  channels, and `keepState` its notification state and URI grants */
export type DataClear = { fromApp: boolean; keepState: boolean };
/** an owner of per-package state: what a data clear takes (`uid` when the package has one), what the
 *  package's removal takes besides, and the packages it keeps state for */
export type PackageState = {
  clear?(pkg: string, uid: number | undefined, how: DataClear): unknown;
  remove?(pkg: string): unknown;
  packages?(): Iterable<string> | Promise<Iterable<string>>;
};
/** in the order they clear: what is keyed by uid first, files and web data last */
const owners = (broker: Broker): PackageState[] => [
  broker.alarms, jobData, shortcutData, keystoreData, broker.notifications, uriGrantData, broker.permissions, broker.preferences,
  { clear: async (pkg) => (await broker.cookies(pkg)).remove(), remove: async (pkg) => (await broker.cookies(pkg)).forget(),
    packages: async () => (await import("./webcookies.ts")).WebCookies.packages() },
  broker.files, webData, broker.intents, broker.accounts, exitRecordData, installData,
];

export async function clearAppData(broker: Broker, pkg: string, how: DataClear): Promise<void> {
  const uid = packages.get(pkg)?.uid ?? knownUid(pkg);
  await Promise.all(owners(broker).map((owner) => owner.clear?.(pkg, uid, how)));
}
/** a removed package's data and the state kept for it while installed */
export async function removePackageData(broker: Broker, pkg: string): Promise<void> {
  await clearAppData(broker, pkg, { fromApp: false, keepState: false });
  await Promise.all(owners(broker).map((owner) => owner.remove?.(pkg)));
}

/** what happens to a package's data: clearApplicationUserData's clear, or its removal with the package */
export type PackageDataChange = ({ kind: "clear" } & DataClear) | { kind: "remove" };
/** the package stops (its processes die and its services go), then its data is cleared, or it is
 *  removed with its installed archive; then `broadcasts` go out */
export async function changePackageData(broker: Broker, pkg: string, change: PackageDataChange, broadcasts: { data: ParcelData; targets: Receiver[] }[]): Promise<void> {
  if (change.kind === "clear") {
    await broker.forceStop(pkg, { reason: REASON_USER_REQUESTED, description: `stop ${pkg} due to clear data` });
    await clearAppData(broker, pkg, change);
  } else {
    await broker.forceStop(pkg);
    await broker.packageRemoved(pkg);
    await removePackageData(broker, pkg);
    await forgetPackage(installedPath(pkg));
  }
  for (const { data, targets } of broadcasts) await broker.broadcast(null, data, targets, [], false);
}

/** every package some owner keeps state for */
export async function packagesWithData(broker: Broker): Promise<string[]> {
  return [...new Set((await Promise.all(owners(broker).map(async (owner) => [...await owner.packages?.() ?? []]))).flat())];
}
