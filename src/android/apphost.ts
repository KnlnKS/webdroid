import type { Resources } from "./res";
import type { JLocaleList } from "./resnative";

/** Host bundle shared by all contexts of the app */
export interface AppHost {
  res: Resources;
  pkg: string;
  assetKey: string;
  zip: Record<string, Uint8Array>;
  /** the names of the config/feature splits installed beside the base, empty for a plain apk */
  splits: string[];
  setApplicationNightMode: (mode: number) => void;
  /** LocaleManager.setApplicationLocales: persist the list and deliver the configuration change */
  setApplicationLocales: (locales: JLocaleList) => void;
}
export let appHost: AppHost | null = null;
export function setAppHost(h: AppHost | null) { appHost = h; }
