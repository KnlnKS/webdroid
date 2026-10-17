// IDevicePolicyManager, under AOSP's DevicePolicyManager: DevicePolicyManagerService runs on every
// device, but this one lacks FEATURE_DEVICE_ADMIN, so it answers as with mHasFeature false (decoded
// from the reference AVD's services.jar): no admin, owner or policy is ever in force.
import { JObj, rt } from "../jvm/runtime.ts";
import { staticField } from "../jvm/natives/jentry.ts";
import { hostStub } from "./binder.ts";

const CN = "Landroid/content/ComponentName;";
rt.register({ name: "webdroid/DevicePolicyManagerService", ctor: class extends JObj {}, sup: "android/app/admin/IDevicePolicyManager$Stub", methods: {
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
} });
hostStub("device_policy", "webdroid/DevicePolicyManagerService");
