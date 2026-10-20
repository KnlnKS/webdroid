// IDevicePolicyManager, under AOSP's DevicePolicyManager: DevicePolicyManagerService runs on every
// device, but this one lacks FEATURE_DEVICE_ADMIN, so it answers as with mHasFeature false (decoded
// from the reference AVD's services.jar): no admin, owner or policy is ever in force.
import { staticField } from "../jvm/natives/jentry.ts";
import { hostService } from "./binder.ts";

const CN = "Landroid/content/ComponentName;";
hostService("device_policy", "webdroid/DevicePolicyManagerService", "android/app/admin/IDevicePolicyManager$Stub", {
  [`isAdminActive(${CN}I)Z`]: () => 0,
  "getActiveAdmins(I)Ljava/util/List;": () => staticField("java/util/Collections", "EMPTY_LIST"),
  [`getCameraDisabled(${CN}Ljava/lang/String;IZ)Z`]: () => 0,
  [`getScreenCaptureDisabled(${CN}IZ)Z`]: () => 0,
  [`getKeyguardDisabledFeatures(${CN}IZ)I`]: () => 0,
  [`getPasswordQuality(${CN}IZ)I`]: () => 0,
  [`getProfileOwnerAsUser(I)${CN}`]: () => null,
  [`getDeviceOwnerComponent(Z)${CN}`]: () => null,
  [`getDeviceOwnerComponentOnUser(I)${CN}`]: () => null,
  "isOrganizationOwnedDeviceWithManagedProfile()Z": () => 0,
});
