import { JObj, rt } from "../jvm/runtime";

rt.register({
  name: "android/app/admin/DevicePolicyManager", ctor: class extends JObj {},
  methods: {
    "getCameraDisabled(Landroid/content/ComponentName;)Z": () => 0,
    "isAdminActive(Landroid/content/ComponentName;)Z": () => 0,
    "isDeviceOwnerApp(Ljava/lang/String;)Z": () => 0,
    "isProfileOwnerApp(Ljava/lang/String;)Z": () => 0,
    "getActiveAdmins()Ljava/util/List;": () => null,
  },
});
