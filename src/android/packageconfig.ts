// ActivityTaskManager's per-package configuration (PackageConfigPersister): the night mode
// UiModeManager.setApplicationNightMode and the locales LocaleManager.setApplicationLocales give a
// package, which its processes start with. The package's own processes write it, and a data clear
// takes it (onPackageDataCleared).
import { persisted } from "../shell/device-storage.ts";
import type { PackageState } from "../shell/packagedata.ts";

/** MODE_NIGHT_NO (1) or MODE_NIGHT_YES (2), and the locales' language tags joined by commas */
export type PackageConfig = { night?: number; locales?: string };
const saved = persisted<PackageConfig>("wd:package-config:", (value) => {
  if (!value || typeof value !== "object") return null;
  const { night, locales } = value as Record<string, unknown>;
  return { ...typeof night === "number" ? { night } : {}, ...typeof locales === "string" ? { locales } : {} };
});
export const packageConfig = (pkg: string): PackageConfig => saved.get(pkg) ?? {};
export const setPackageConfig = (pkg: string, change: PackageConfig): void => { saved.set(pkg, { ...packageConfig(pkg), ...change }); };
export const packageConfigData: PackageState = { clear(pkg) { saved.remove(pkg); }, packages: () => saved.packages() };
