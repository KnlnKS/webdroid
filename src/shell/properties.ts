// System properties, one store for Java's SystemProperties and native libc: the reference build's
// (platform-properties.ts) under the identity of the phone it reports being (device-properties.ts),
// what follows from the native tier, and the live device profile's (config.ts). Any other property
// is ABSENT, so its reader gets its own default: what a device that has not set one reports, rather
// than a made-up answer a library will branch on.
import { device } from "./config.ts";
import { DEVICE_PROPERTIES } from "./device-properties.ts";
import { PLATFORM_PROPERTIES } from "./platform-properties.ts";
import { utf8 } from "../jvm/abi.ts";

/** The ABIs the device runs, most-preferred first, which are those the native tier executes
 *  (src/native/loader.ts): arm64 and 32-bit arm, as on a device whose ro.zygote is zygote64_32.
 *  The phone is arm64 only; armeabi-v7a apps run here, so the lists are this device's. */
export const ABIS_64: readonly string[] = ["arm64-v8a"], ABIS_32: readonly string[] = ["armeabi-v7a", "armeabi"];
const abiLists = (prefix: string) => ({
  [`${prefix}abilist`]: [...ABIS_64, ...ABIS_32].join(","), [`${prefix}abilist32`]: ABIS_32.join(","), [`${prefix}abilist64`]: ABIS_64.join(","),
});
// Maps, so a key such as "constructor" is not a property
const fixed = new Map(Object.entries({
  // ART's 32-bit target, unless the build names one, configured as the build configures arm64's
  "dalvik.vm.isa.arm.variant": PLATFORM_PROPERTIES["dalvik.vm.isa.arm64.variant"],
  "dalvik.vm.isa.arm.features": PLATFORM_PROPERTIES["dalvik.vm.isa.arm64.features"],
  ...PLATFORM_PROPERTIES,
  ...DEVICE_PROPERTIES,
  "ro.zygote": "zygote64_32", "ro.product.cpu.abi": ABIS_64[0],
  ...abiLists("ro.product.cpu."), ...abiLists("ro.system.product.cpu."), ...abiLists("ro.vendor.product.cpu."),
  // PackageInstaller.Session writes through the staged file's descriptor (AOSP's revocable-fd
  // mode) rather than over a FileBridge socket, which needs a server thread there is none of
  "fw.revocable_fd": "true",
  // a product without a camera disables cameraserver, so CameraManager lists no camera
  "config.disable_cameraservice": "true",
}));
const live = new Map(Object.entries({
  "persist.sys.timezone": () => device.timezone,
  // DisplayMetrics.DENSITY_DEVICE
  "ro.sf.lcd_density": () => String(device.densityDpi),
}));

export const hasProperty = (key: string): boolean => live.has(key) || fixed.has(key);
export const propertyValue = (key: string): string | null => live.get(key)?.() ?? fixed.get(key) ?? null;
/** bionic's bound on a value, its terminator included */
export const PROP_VALUE_MAX = 92;

/** prop_info handles for a libc that serves lookups itself (the ARM32 HLE): one per property, at
 *  an address the caller allocates once */
const handleKeys = new Map<number, string>(), keyHandles = new Map<string, number>();
export function propertyHandle(key: string, allocate: (key: string) => number): number {
  if (!hasProperty(key)) return 0;
  let at = keyHandles.get(key);
  if (!at) { keyHandles.set(key, at = allocate(key)); handleKeys.set(at, key); }
  return at;
}
export const propertyKey = (handle: number): string | null => handleKeys.get(handle) ?? null;

/** The path bionic maps read-only when it is a file: init's single, pre-split property area. */
export const PROPERTY_AREA_PATH = "/dev/__properties__";

// prop_area.cpp: a 128-byte header, then a trie of prop_bt nodes (one per dotted name segment,
// siblings a binary search tree ordered by length then bytes) whose leaves point at prop_info
// records; offsets are from the end of the header, objects 4-byte aligned
const HEADER = 128, PROP_AREA_MAGIC = 0x504f5250, PROP_AREA_VERSION = 0xfc6ed0ab;
const BT_PROP = 4, BT_LEFT = 8, BT_RIGHT = 12, BT_CHILDREN = 16, BT_NAME = 20, INFO_NAME = 4 + PROP_VALUE_MAX;
const LONG_FLAG = 1 << 16, LONG_ERROR_SIZE = 56, LONG_LEGACY_ERROR = utf8.enc.encode("Must use __system_property_read_callback() to read");

/** every property, as bionic's ContextsPreSplit reads /dev/__properties__ */
export function propertyArea(): Uint8Array {
  const entries = [...new Set([...fixed.keys(), ...live.keys()])].map((key) => [utf8.enc.encode(key), utf8.enc.encode(propertyValue(key)!)] as const);
  // at most a node per segment, a record per key and a long value, each padded by under 4 bytes
  const bound = entries.reduce((n, [k, v]) => n + (k.filter((c) => c === 46).length + 1) * (BT_NAME + 4) + 2 * k.length + INFO_NAME + 4 +
    (v.length < PROP_VALUE_MAX ? 0 : v.length + 4), BT_NAME);
  const bytes = new Uint8Array(HEADER + bound), view = new DataView(bytes.buffer);
  let used = BT_NAME;
  const alloc = (n: number) => { const off = used; used += (n + 3) & ~3; return off; };
  const u32 = (off: number) => view.getUint32(HEADER + off, true);
  const set32 = (off: number, v: number) => view.setUint32(HEADER + off, v, true);
  const nameOf = (bt: number) => bytes.subarray(HEADER + bt + BT_NAME, HEADER + bt + BT_NAME + u32(bt));
  const compare = (a: Uint8Array, b: Uint8Array) => {
    if (a.length !== b.length) return a.length - b.length;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  };
  /** the node named `segment` among `parent`'s children, added where the search ends */
  const child = (parent: number, segment: Uint8Array): number => {
    let link = parent + BT_CHILDREN;
    for (let bt = u32(link); bt; bt = u32(link)) {
      const order = compare(segment, nameOf(bt));
      if (!order) return bt;
      link = bt + (order < 0 ? BT_LEFT : BT_RIGHT);
    }
    const bt = alloc(BT_NAME + segment.length + 1);
    set32(bt, segment.length);
    bytes.set(segment, HEADER + bt + BT_NAME);
    set32(link, bt);
    return bt;
  };
  for (const [key, value] of entries) {
    let bt = 0, start = 0;
    for (let dot = key.indexOf(46); ; dot = key.indexOf(46, start)) {
      bt = child(bt, key.subarray(start, dot < 0 ? key.length : dot));
      if (dot < 0) break;
      start = dot + 1;
    }
    const info = alloc(INFO_NAME + key.length + 1);
    bytes.set(key, HEADER + info + INFO_NAME);
    if (value.length < PROP_VALUE_MAX) {
      set32(info, value.length << 24);                                 // serial: the value's length, generation 0
      bytes.set(value, HEADER + info + 4);
    } else {
      // a long (ro.) value follows its record, which holds the error a legacy read gets and the
      // value's offset from the record
      const at = alloc(value.length + 1);
      bytes.set(value, HEADER + at);
      set32(info, LONG_LEGACY_ERROR.length << 24 | LONG_FLAG);
      bytes.set(LONG_LEGACY_ERROR, HEADER + info + 4);
      set32(info + 4 + LONG_ERROR_SIZE, at - info);
    }
    set32(bt + BT_PROP, info);
  }
  view.setUint32(0, used, true);
  view.setUint32(4, entries.length, true);                          // the area's serial, which each add bumps
  view.setUint32(8, PROP_AREA_MAGIC, true);
  view.setUint32(12, PROP_AREA_VERSION, true);
  return bytes.subarray(0, HEADER + used);
}
