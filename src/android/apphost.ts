import type { Resources, JTheme } from "./res";
import type { JApplication, JActivity } from "./app";
import type { JResources } from "./resnative";
import type { JIntent, ActivityResultTarget } from "./intent";

export type ActivityLaunch = { caller: { pkg: string; cls: string } | null; result?: ActivityResultTarget; remoteId?: number };

/** Host bundle shared by all contexts of the app */
export interface AppHost {
  res: Resources;
  theme: JTheme;
  pkg: string;
  /** the apk's file name under apks/ — what the dev server's /asset route keys on */
  apkFile: string;
  appLabel: string;
  themeResId: number;
  iconRes: number;
  zip: Record<string, Uint8Array>;
  /** the names of the config/feature splits installed beside the base, empty for a plain apk */
  splits: string[];
  application: JApplication | null;
  jresources: JResources;
  statusBarColor: number;
  navBarColor: number;
  launch: (component: string, intent: JIntent | null, options?: ActivityLaunch) => Promise<void>;
  /** the pause/resume a modal system window (the permission dialog) leaves behind */
  roundTrip: (activity: JActivity) => Promise<void>;
  finishActivity: (activity: JActivity) => void;
  recreateActivity: (activity: JActivity) => void;
  setRequestedOrientation: (activity: JActivity, orientation: number) => void;
  currentActivity: () => JActivity | null;
  invalidateOptionsMenu: (activity: JActivity) => void;
}
export let appHost: AppHost | null = null;
export function setAppHost(h: AppHost | null) { appHost = h; }
export function jclsNameOf(o: unknown): string {
  return ((o as any)?.constructor?.$i?.name ?? "unknown").replace(/\//g, ".");
}
