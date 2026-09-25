import { rt } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import type { JBundle } from "./os";
import { type JParcel, readInt, readLong, readString, readString8, writeInt, writeLong, writeString, writeString8 } from "./parcel";
import { readText, writeText } from "./text";

type ParcelInfo = Record<string, unknown>;
type Kind = "int" | "long" | "string" | "strings" | "text" | "bundle" | "sparse" | "typed" | "nullableBoolean" | "stringSet" | "uuid" | "stringMap";
type Field = readonly [Kind, string, unknown?];

// Android 15 PackageItemInfo and ApplicationInfo parcel field order, including fields not yet exposed to apps.
const baseFields: readonly Field[] = [
  ["string", "name"], ["string", "packageName"], ["int", "labelRes"], ["text", "nonLocalizedLabel"],
  ["int", "icon"], ["int", "logo", 0], ["bundle", "metaData"], ["int", "banner", 0],
  ["int", "showUserIcon", -10000], ["int", "isArchived", 0],
];
const appFields: readonly Field[] = [
  ["string", "taskAffinity"], ["string", "permission"], ["string", "processName"], ["string", "className"],
  ["int", "theme"], ["int", "flags"], ["int", "privateFlags", 0], ["int", "privateFlagsExt", 0],
  ["int", "requiresSmallestWidthDp", 0], ["int", "compatibleWidthLimitDp", 0], ["int", "largestWidthLimitDp", 0],
  ["uuid", "storageUuid"], ["string", "scanSourceDir"], ["string", "scanPublicSourceDir"],
  ["string", "sourceDir"], ["string", "publicSourceDir"], ["strings", "splitNames"],
  ["strings", "splitSourceDirs"], ["strings", "splitPublicSourceDirs"], ["sparse", "splitDependencies"],
  ["string", "nativeLibraryDir"], ["string", "secondaryNativeLibraryDir"], ["string", "nativeLibraryRootDir"],
  ["int", "nativeLibraryRootRequiresIsa", 0], ["string", "primaryCpuAbi"], ["string", "secondaryCpuAbi"],
  ["strings", "resourceDirs"], ["strings", "overlayPaths"], ["string", "seInfo"], ["string", "seInfoUser"],
  ["strings", "sharedLibraryFiles"], ["typed", "sharedLibraryInfos"], ["typed", "optionalSharedLibraryInfos"],
  ["string", "dataDir"], ["string", "deviceProtectedDataDir"], ["string", "credentialProtectedDataDir"],
  ["int", "uid"], ["int", "minSdkVersion"], ["int", "targetSdkVersion"], ["long", "longVersionCode", 0n],
  ["int", "enabled"], ["int", "enabledSetting", 0], ["int", "installLocation", 0],
  ["string", "manageSpaceActivityName"], ["string", "backupAgentName"], ["int", "descriptionRes", 0],
  ["int", "uiOptions", 0], ["int", "fullBackupContent", 0], ["int", "dataExtractionRulesRes", 0],
  ["int", "crossProfile", 0], ["int", "networkSecurityConfigRes", 0], ["int", "category"],
  ["int", "targetSandboxVersion", 0], ["string", "classLoaderName"], ["strings", "splitClassLoaderNames"],
  ["int", "compileSdkVersion", 0], ["string", "compileSdkVersionCodename"], ["string", "appComponentFactory"],
  ["int", "iconRes", 0], ["int", "roundIconRes", 0], ["int", "mHiddenApiPolicy", -1],
  ["int", "hiddenUntilInstalled", 0], ["string", "zygotePreloadName"], ["int", "gwpAsanMode", -1],
  ["int", "memtagMode", -1], ["int", "nativeHeapZeroInitialized", -1],
  ["nullableBoolean", "requestRawExternalStorageAccess"], ["long", "createTimestamp", 0n],
  ["stringMap", "mAppClassNamesByProcess"], ["int", "localeConfigRes", 0],
  ["int", "allowCrossUidActivitySwitchFromBelow", 0], ["stringSet", "mKnownActivityEmbeddingCerts"],
];
const fields = [...baseFields, ...appFields];

async function writeField(parcel: JParcel, kind: Kind, value: unknown): Promise<void> {
  switch (kind) {
    case "int": writeInt(parcel, Number(value ?? 0)); return;
    case "long": writeLong(parcel, BigInt((value ?? 0) as bigint | number)); return;
    case "string": writeString8(parcel, (value as string | null) ?? null); return;
    case "text": await writeText(value ?? null, parcel); return;
    case "bundle": await vcall(parcel, "writeBundle", "(Landroid/os/Bundle;)V", value ?? null); return;
    case "strings": {
      const items = value as string[] | null;
      writeInt(parcel, items?.length ?? -1);
      if (items) for (const item of items) writeString8(parcel, item);
      return;
    }
    case "sparse":
    case "typed":
      if (value != null) throw rt.mkThrowable("java/lang/UnsupportedOperationException", `ApplicationInfo parcel ${kind}`);
      writeInt(parcel, -1); return;
    case "nullableBoolean": writeInt(parcel, value == null ? 1 : value ? -1 : 0); return;
    case "stringSet": {
      const items = value as Set<string> | null;
      writeInt(parcel, items?.size ?? -1);
      if (items) for (const item of items) writeString(parcel, item);
      return;
    }
    case "stringMap": {
      const entries = value as Map<string, string> | null;
      writeInt(parcel, entries?.size ?? 0);
      if (entries) for (const [key, item] of entries) { writeString(parcel, key); writeString(parcel, item); }
      return;
    }
    case "uuid": {
      const uuid = value as { mostSignificantBits: bigint; leastSignificantBits: bigint } | null;
      writeInt(parcel, uuid ? 1 : 0);
      if (uuid) { writeLong(parcel, uuid.mostSignificantBits); writeLong(parcel, uuid.leastSignificantBits); }
    }
  }
}

async function readField(parcel: JParcel, kind: Kind): Promise<unknown> {
  switch (kind) {
    case "int": return readInt(parcel);
    case "long": return readLong(parcel);
    case "string": return readString8(parcel);
    case "text": return readText(parcel);
    case "bundle": return vcall(parcel, "readBundle", "()Landroid/os/Bundle;") as Promise<JBundle | null>;
    case "strings": {
      const count = readInt(parcel);
      if (count < 0) return null;
      const items: (string | null)[] = [];
      for (let i = 0; i < count; i++) items.push(readString8(parcel));
      return items;
    }
    case "sparse":
    case "typed": {
      if (readInt(parcel) >= 0) throw rt.mkThrowable("java/lang/UnsupportedOperationException", `ApplicationInfo parcel ${kind}`);
      return null;
    }
    case "nullableBoolean": {
      const value = readInt(parcel);
      if (value === 1) return null;
      if (value === -1) return 1;
      if (value === 0) return 0;
      throw rt.mkThrowable("java/lang/IllegalStateException", "Malformed nullable Boolean");
    }
    case "stringSet": {
      const count = readInt(parcel);
      const items = new Set<string>();
      for (let i = 0; i < count; i++) items.add(readString(parcel)!);
      return items;
    }
    case "stringMap": {
      const count = readInt(parcel);
      if (count <= 0) return null;
      const items = new Map<string, string>();
      for (let i = 0; i < count; i++) items.set(readString(parcel)!, readString(parcel)!);
      return items;
    }
    case "uuid": return readInt(parcel) ? { mostSignificantBits: readLong(parcel), leastSignificantBits: readLong(parcel) } : null;
  }
}

export async function writeApplicationInfo(parcel: JParcel, info: ParcelInfo): Promise<void> {
  for (const [kind, name, fallback] of fields) await writeField(parcel, kind, info[name] === undefined ? fallback : info[name]);
}

export async function readApplicationInfo(parcel: JParcel, info: ParcelInfo): Promise<void> {
  for (const [kind, name] of fields) info[name] = await readField(parcel, kind);
}
