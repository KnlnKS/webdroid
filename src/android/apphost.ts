import type { Resources, JTheme } from "./res";
import type { JLocaleList } from "./resnative";
import type { JObj } from "../jvm/runtime";

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
  application: JObj | null;
  /** the app's android.content.res.Resources: ours, or AOSP's over `res` */
  jresources: JObj;
  setApplicationNightMode: (mode: number) => void;
  /** LocaleManager.setApplicationLocales: persist the list and deliver the configuration change */
  setApplicationLocales: (locales: JLocaleList) => void;
}
export let appHost: AppHost | null = null;
export function setAppHost(h: AppHost | null) { appHost = h; }
