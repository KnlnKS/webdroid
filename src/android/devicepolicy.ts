import { JObj, rt, stubs } from "../jvm/runtime";

rt.register({
  name: "android/app/admin/DevicePolicyManager", ctor: class extends JObj {},
  methods: {
    ...stubs(0, "getCameraDisabled(Landroid/content/ComponentName;)Z", "isAdminActive(Landroid/content/ComponentName;)Z",
      "isDeviceOwnerApp(Ljava/lang/String;)Z", "isProfileOwnerApp(Ljava/lang/String;)Z"),
    ...stubs(null, "getActiveAdmins()Ljava/util/List;"),
  },
});
