export const processEnv: Record<string, string> = Object.assign(Object.create(null), {
  PATH: "/sbin:/vendor/bin:/system/sbin:/system/bin:/system/xbin", LD_LIBRARY_PATH: "/vendor/lib:/system/lib", HOME: "/data",
  ANDROID_BOOTLOGO: "1", ANDROID_ROOT: "/system", ANDROID_ASSETS: "/system/app", ANDROID_DATA: "/data", ANDROID_STORAGE: "/storage",
  EXTERNAL_STORAGE: "/sdcard", ASEC_MOUNTPOINT: "/mnt/asec", LOOP_MOUNTPOINT: "/mnt/obb", TMPDIR: "/data/local/tmp",
});
