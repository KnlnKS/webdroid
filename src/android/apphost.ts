import type { Resources, JTheme } from "./res";
import type { JApplication, JActivity } from "./app";
import type { JLocaleList } from "./resnative";
import type { JObj } from "../jvm/runtime";
import type { JIntent, ActivityResultTarget } from "./intent";

export type ActivityLaunch = { caller: { pkg: string; cls: string } | null; result?: ActivityResultTarget; remoteId?: number; activityId?: number; taskId?: number };

/** Host bundle shared by all contexts of the app */
export interface AppHost {
  res: Resources;
  theme: JTheme;
  pkg: string;
  assetKey: string;
  appLabel: string;
  themeResId: number;
  iconRes: number;
  zip: Record<string, Uint8Array>;
  /** the names of the config/feature splits installed beside the base, empty for a plain apk */
  splits: string[];
  application: JApplication | null;
  /** the app's android.content.res.Resources: ours, or AOSP's over `res` */
  jresources: JObj;
  launch: (component: string, intent: JIntent | null, options?: ActivityLaunch) => Promise<void>;
  /** the pause/resume a modal system window (the permission dialog) leaves behind */
  roundTrip: (activity: JActivity) => Promise<void>;
  finishActivity: (activity: JActivity) => void;
  recreateActivity: (activity: JActivity) => void;
  /** Activity.moveTaskToBack: the task leaves the screen until the app is brought back */
  moveTaskToBack: () => void;
  setRequestedOrientation: (activity: JActivity, orientation: number) => void;
  setApplicationNightMode: (mode: number) => void;
  /** LocaleManager.setApplicationLocales: persist the list and deliver the configuration change */
  setApplicationLocales: (locales: JLocaleList) => void;
  currentActivity: () => JActivity | null;
  /** every live activity, bottom of the stack first */
  activities: () => JActivity[];
  finishTask: (taskId: number) => void;
  /** Activity.finishAffinity: this activity and those below it in its task that share its affinity */
  finishAffinity: (activity: JActivity) => void;
  invalidateOptionsMenu: (activity: JActivity) => void;
}
export let appHost: AppHost | null = null;
export function setAppHost(h: AppHost | null) { appHost = h; }
export function jclsNameOf(o: unknown): string {
  return ((o as any)?.constructor?.$i?.name ?? "unknown").replace(/\//g, ".");
}
