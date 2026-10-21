import type { Locales } from "./configuration.ts";

/** Host bundle shared by all contexts of the app */
export interface AppHost {
  pkg: string;
  assetKey: string;
  zip: Record<string, Uint8Array>;
  /** the names of the config/feature splits installed beside the base, empty for a plain apk */
  splits: string[];
  setApplicationNightMode: (mode: number) => void | Promise<void>;
  /** LocaleManager.setApplicationLocales: persist the list and deliver the configuration change */
  setApplicationLocales: (locales: Locales) => void | Promise<void>;
}
export let appHost: AppHost | null = null;
export function setAppHost(h: AppHost | null) { appHost = h; }
/** the app this realm runs, which owns what its WebViews keep */
export function runningApp(): AppHost {
  if (!appHost) throw new Error("No app is running");
  return appHost;
}
