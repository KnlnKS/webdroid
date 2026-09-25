import { rt } from "../jvm/runtime";
import { jarray, mangleStaticField } from "../jvm/abi";
import { vcall } from "../jvm/natives/jlang";
import type { JBundle } from "./os";
import { type JParcel, readInt, readLong, readString, readString8, writeInt, writeLong, writeString, writeString8 } from "./parcel";
import { readText, writeText } from "./text";

type ParcelInfo = Record<string, unknown>;
type Kind = "int" | "long" | "string" | "strings" | "ints" | "text" | "bundle" | "sparse" | "typed" | "typedArray" | "applicationInfo" | "signingInfo" | "optionalString" | "nullableBoolean" | "stringSet" | "uuid" | "stringMap";
type Field = readonly [Kind, string, unknown?, string?];

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
const packageFields: readonly Field[] = [
  ["string", "packageName"], ["strings", "splitNames"], ["int", "versionCode"], ["int", "versionCodeMajor", 0],
  ["string", "versionName"], ["int", "baseRevisionCode", 0], ["ints", "splitRevisionCodes"],
  ["string", "sharedUserId"], ["int", "sharedUserLabel", 0], ["applicationInfo", "applicationInfo"],
  ["long", "firstInstallTime"], ["long", "lastUpdateTime"], ["ints", "gids"],
  ["typedArray", "activities", null, "android/content/pm/ActivityInfo"],
  ["typedArray", "receivers", null, "android/content/pm/ActivityInfo"],
  ["typedArray", "services", null, "android/content/pm/ServiceInfo"],
  ["typedArray", "providers", null, "android/content/pm/ProviderInfo"],
  ["typedArray", "instrumentation", null, "android/content/pm/InstrumentationInfo"],
  ["typedArray", "permissions", null, "android/content/pm/PermissionInfo"],
  ["strings", "requestedPermissions"], ["ints", "requestedPermissionsFlags"],
  ["typedArray", "signatures", null, "android/content/pm/Signature"],
  ["typedArray", "configPreferences", null, "android/content/pm/ConfigurationInfo"],
  ["typedArray", "reqFeatures", null, "android/content/pm/FeatureInfo"],
  ["typedArray", "featureGroups", null, "android/content/pm/FeatureGroupInfo"],
  ["typedArray", "attributions", null, "android/content/pm/Attribution"],
  ["int", "installLocation", -1], ["int", "isStub", 0], ["int", "coreApp", 0], ["int", "requiredForAllUsers", 0],
  ["string", "restrictedAccountType"], ["string", "requiredAccountType"], ["string", "overlayTarget"],
  ["string", "overlayCategory"], ["int", "overlayPriority", 0], ["int", "mOverlayIsStatic", 0],
  ["int", "compileSdkVersion", 0], ["string", "compileSdkVersionCodename"], ["signingInfo", "signingInfo"],
  ["int", "isApex", 0], ["int", "isActiveApex", 0], ["long", "mArchiveTimeMillis", 0n],
  ["optionalString", "mApexPackageName"],
];

async function writeField(parcel: JParcel, kind: Kind, value: unknown, flags: number): Promise<void> {
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
    case "ints": {
      const items = value as ArrayLike<number> | null;
      writeInt(parcel, items?.length ?? -1);
      if (items) for (let i = 0; i < items.length; i++) writeInt(parcel, items[i]);
      return;
    }
    case "sparse":
    case "typed":
      if (value != null) throw rt.mkThrowable("java/lang/UnsupportedOperationException", `ApplicationInfo parcel ${kind}`);
      writeInt(parcel, -1); return;
    case "typedArray": {
      const items = value as unknown[] | null;
      writeInt(parcel, items?.length ?? -1);
      if (items) for (const item of items) {
        writeInt(parcel, item == null ? 0 : 1);
        if (item != null) await vcall(item, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, flags);
      }
      return;
    }
    case "applicationInfo":
      writeInt(parcel, value == null ? 0 : 1);
      if (value != null) await writeApplicationInfo(parcel, value as ParcelInfo, flags);
      return;
    case "signingInfo":
      writeInt(parcel, value == null ? 0 : 1);
      if (value != null) await vcall(value, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, flags);
      return;
    case "optionalString":
      writeInt(parcel, value == null ? 0 : 1);
      if (value != null) writeString8(parcel, value as string);
      return;
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

async function readField(parcel: JParcel, kind: Kind, type?: string): Promise<unknown> {
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
    case "ints": {
      const count = readInt(parcel);
      if (count < 0) return null;
      const items = new Int32Array(count);
      for (let i = 0; i < count; i++) items[i] = readInt(parcel);
      return items;
    }
    case "sparse":
    case "typed": {
      if (readInt(parcel) >= 0) throw rt.mkThrowable("java/lang/UnsupportedOperationException", `ApplicationInfo parcel ${kind}`);
      return null;
    }
    case "typedArray": {
      const count = readInt(parcel);
      if (count < 0) return null;
      if (!type) throw new Error("Parcelable array type missing");
      const ctor = rt.link(type).ctor as Record<string, unknown>;
      const creator = ctor[mangleStaticField("CREATOR")];
      if (!creator) throw rt.mkThrowable("android/os/BadParcelableException", `Missing CREATOR for ${type}`);
      const items: unknown[] = [];
      for (let i = 0; i < count; i++) items.push(readInt(parcel) ? await vcall(creator, "createFromParcel", "(Landroid/os/Parcel;)Ljava/lang/Object;", parcel) : null);
      return jarray(items, `L${type};`);
    }
    case "applicationInfo": {
      if (!readInt(parcel)) return null;
      const info = rt.make("android/content/pm/ApplicationInfo") as ParcelInfo;
      await readApplicationInfo(parcel, info);
      return info;
    }
    case "signingInfo": {
      if (!readInt(parcel)) return null;
      const ctor = rt.link("android/content/pm/SigningInfo").ctor as Record<string, unknown>;
      const creator = ctor[mangleStaticField("CREATOR")];
      if (!creator) throw rt.mkThrowable("android/os/BadParcelableException", "Missing SigningInfo CREATOR");
      return vcall(creator, "createFromParcel", "(Landroid/os/Parcel;)Ljava/lang/Object;", parcel);
    }
    case "optionalString": return readInt(parcel) ? readString8(parcel) : null;
    case "nullableBoolean": {
      const value = readInt(parcel);
      if (value === 1) return null;
      if (value === -1) return 1;
      if (value === 0) return 0;
      throw rt.mkThrowable("java/lang/IllegalStateException", "Malformed nullable Boolean");
    }
    case "stringSet": {
      const count = readInt(parcel);
      if (count <= 0) return null;
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

export async function writeApplicationInfo(parcel: JParcel, info: ParcelInfo, flags = 0): Promise<void> {
  for (const [kind, name, fallback] of fields) await writeField(parcel, kind, info[name] === undefined ? fallback : info[name], flags);
}

export async function readApplicationInfo(parcel: JParcel, info: ParcelInfo): Promise<void> {
  for (const [kind, name] of fields) info[name] = await readField(parcel, kind);
}

export async function writePackageInfo(parcel: JParcel, info: ParcelInfo, flags = 0): Promise<void> {
  for (const [kind, name, fallback] of packageFields) {
    let value = info[name] === undefined ? fallback : info[name];
    if (value === undefined && name === "versionCode") value = Number(BigInt(info.longVersionCode as bigint ?? 0n) & 0xffff_ffffn);
    if (name === "versionCodeMajor" && info[name] === undefined) value = BigInt(info.longVersionCode as bigint ?? 0n) >> 32n;
    await writeField(parcel, kind, value, flags);
  }
}

export async function readPackageInfo(parcel: JParcel, info: ParcelInfo): Promise<void> {
  for (const [kind, name, , type] of packageFields) info[name] = await readField(parcel, kind, type);
  info.longVersionCode = BigInt.asIntN(64, BigInt(info.versionCode as number >>> 0) | BigInt(info.versionCodeMajor as number) << 32n);
}
