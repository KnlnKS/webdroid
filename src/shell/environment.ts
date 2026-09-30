export const processEnv: Record<string, string> = Object.assign(Object.create(null), {
  PATH: "/sbin:/vendor/bin:/system/sbin:/system/bin:/system/xbin", HOME: "/data",
  ANDROID_BOOTLOGO: "1", ANDROID_ROOT: "/system", ANDROID_ASSETS: "/system/app", ANDROID_DATA: "/data", ANDROID_STORAGE: "/storage",
  ANDROID_ART_ROOT: "/apex/com.android.art", ANDROID_I18N_ROOT: "/apex/com.android.i18n", ANDROID_TZDATA_ROOT: "/apex/com.android.tzdata",
  EXTERNAL_STORAGE: "/sdcard", ASEC_MOUNTPOINT: "/mnt/asec", LOOP_MOUNTPOINT: "/mnt/obb", TMPDIR: "/data/local/tmp",
});
