// Pull the real android: framework off the reference device and prove the two halves match.
//
//   pnpm gen-framework                 # pull from a connected device/emulator, run its recorders, then verify
//   pnpm gen-framework --verify        # verify what is already in vendor/aosp
//   pnpm gen-framework --only a,b      # run only the RECORDERS named (fonts and identity run only so)
//   pnpm gen-framework --only identity [--image url]  # the identity properties and uname of a phone's
//                                      factory image, by default the Pixel 9's (no device needed)
//
// framework.jar carries android.* and com.android.internal.* as bytecode; framework-res.apk
// carries the resource table those classes' R ids were compiled against. Neither is usable
// without the other: com.android.internal.R.styleable.* are int[] built in <clinit>, and the
// index constants beside them (R.styleable.View_background = 13) are already inlined into the
// framework's own bytecode. Take the pair from one build and the ids agree by construction;
// synthesise either half and they do not.
//
// The reference AVD (tests/e2e/setup-avd.sh) is also what records tests/e2e/golden, so the
// bytecode we run and the screenshots we score against come from the same platform build.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cli } from "./args.ts";
import { tempDir } from "./java.ts";
import { setTimeout } from "node:timers/promises";
import { unzipSync } from "fflate";
import { constObject, writeGenerated } from "./lib.ts";
import { loadDexes } from "./dexes.ts";
import { bootTier } from "./tier.ts";
import "../src/natives.ts";
import { descToName } from "../src/jvm/abi.ts";
import { insnLen } from "../src/jvm/opcodes.ts";
import { PLATFORM_JARS, PLATFORM_DATA, BOOT_JAR_PATHS, SHARED_LIBRARIES } from "../src/jvm/bootclasspath.ts";
import { SYSTEM_PACKAGES } from "../src/shell/system-packages.ts";
import { Arsc } from "../src/android/arsc.ts";
import { postScriptName } from "../src/android/sfnt.ts";
import { adb, asRoot, pull, runDex } from "./adb.ts";
import { nodeCommand } from "./node.ts";
import { buildFixed, identity, recordIdentity, writeProperties } from "./identity.ts";

const OUT = "vendor/aosp";
const JAR = `${OUT}/framework.jar`, RES = `${OUT}/framework-res.apk`;
/** where the device's FontManagerService keeps the font files it installs */
const UPDATED_FONTS = "/data/fonts/files/";
/** a device file mirrored under vendor/aosp, at its device path unless `dst` names another */
const mirror = (src: string, dst = src.slice(1)) => pull(src, `${OUT}/${dst}`);
type Libraries = typeof SHARED_LIBRARIES;
const oneLine = (list: string[]) => JSON.stringify(list, null, 1).replace(/\n\s*/g, " ");
const writeBootClasspath = (jars: string[], bootJars: string[], data: Record<string, number>, libraries: Libraries) => writeGenerated("src/jvm/bootclasspath.ts",
  " from the reference device's BOOTCLASSPATH.",
  `/** the platform class path under vendor/aosp, in class-path order */\nexport const PLATFORM_JARS = ${oneLine(jars)};\n` +
  `/** where each of those jars lives on the device */\nexport const BOOT_JAR_PATHS = ${oneLine(bootJars)};\n` +
  `/** the ICU and time zone files, fonts and their updates, hyphenation patterns and bionic's libraries, by device path (mirrored under vendor/aosp), with their sizes */\n` +
  `export const PLATFORM_DATA: Record<string, number> = ${JSON.stringify(data)};\n` +
  `/** the shared libraries by name, with the ones each loads first */\n` +
  `export const SHARED_LIBRARIES: Record<string, { path: string; dependencies: string[] }> = ${JSON.stringify(libraries)};\n`,
  `${jars.length} jars, ${Object.keys(data).length} files`);

/** the device's runDex probe `java`, whose output is the fixture `fixture` (and whose dex `keep` keeps) */
const probe = (java: string, fixture: string, keep?: string) => async () => {
  const out = runDex(`scripts/${java}.java`, { android: true, keep });
  writeFileSync(fixture, out + "\n");
  console.log(`${fixture}: ${out.split("\n").length} lines`);
};
/** What the reference device records besides the pull, by the name --only takes, each writing its generated source or fixture. `boots` boots the class
 *  path, which a pull rewrites, so after one it runs in a process of its own; `named` runs only when named (a pull records the fonts, and identity
 *  reads a factory image rather than the device). */
const RECORDERS: Record<string, { record: () => Promise<unknown>; boots?: true; named?: true }> = {
  overlays: { record: recordDeviceOverlays },
  compat: { record: recordCompatChanges },
  osConstants: { record: recordOsConstants },
  charsets: { record: recordCharsets },
  input: { record: recordInputDevices },
  properties: { record: recordProperties },
  // VectorDrawableProbe's cases, which fwtest and the browser test compare against
  vector: { record: probe("VectorDrawableProbe", "tests/fixtures/vector-drawable.txt") },
  // InputProbe's lines, which fwtest compares its dex's run against our input natives with
  inputProbe: { record: probe("InputProbe", "tests/fixtures/input-probe.txt", "tests/fixtures/InputProbe.dex") },
  textLayout: { record: recordTextLayouts },
  settings: { record: recordSettings, boots: true },
  fonts: { record: recordFonts, named: true },
  identity: { record: () => recordIdentity(opts.image, /^sdk (\d+)$/m.exec(readFileSync(`${OUT}/build.txt`, "utf8"))![1]), named: true },
};
const usage = "pnpm gen-framework [--verify | --only name,...] [--image url]";
const { values: opts } = cli(usage, { verify: { type: "boolean" }, only: { type: "string" },
  image: { type: "string", default: "https://dl.google.com/dl/android/aosp/tokay-ap3a.241005.015-factory-88013873.zip" } });
if (opts.only) {
  const names = opts.only.split(",");
  for (const name of names) if (!RECORDERS[name]) { console.error(`no recorder ${name}: ${Object.keys(RECORDERS).join(", ")}\nusage: ${usage}`); process.exit(2); }
  for (const name of names) await RECORDERS[name].record();
  process.exit(0);
}
if (!opts.verify) {
  adb("wait-for-device");
  for (let i = 0; adb("shell", "getprop", "sys.boot_completed") !== "1"; i++) {
    if (i > 90) throw new Error("device never reported sys.boot_completed — boot it with `pnpm e2e:boot`");
    await setTimeout(2000);
  }
  const fingerprint = adb("shell", "getprop", "ro.build.fingerprint");
  console.log(`pulling from ${fingerprint}`);
  // the whole BOOTCLASSPATH, in its order: framework.jar keeps its own path, the rest go to boot/
  const bootJars = adb("shell", "echo", "$BOOTCLASSPATH").split(":").filter(Boolean);
  const jars: string[] = [];
  for (const src of bootJars) {
    const name = src.slice(src.lastIndexOf("/") + 1), dst = name === "framework.jar" ? name : `boot/${name}`;
    await mirror(src, dst);
    jars.push(dst);
  }
  await mirror("/system/framework/framework-res.apk", "framework-res.apk");
  await mirror("/system/etc/preloaded-classes", "preloaded-classes");
  // ART's boot image profile as text: the framework methods the platform measured hot.
  // Only root may run profman.
  await asRoot();
  adb("shell", `/apex/com.android.art/bin/profman --profile-file=/system/etc/boot-image.prof ${bootJars.map((j) => `--apk=${j} --dex-location=${j}`).join(" ")}` +
    " --dump-classes-and-methods > /data/local/tmp/boot-image-profile.txt");
  await mirror("/data/local/tmp/boot-image-profile.txt", "boot-image-profile.txt");
  // ICU data, the time zone module's files, the system fonts and their configuration, the
  // hyphenation patterns, and bionic's libraries, at their device paths
  const data: Record<string, number> = {};
  const { DEVICE_LIBS } = await import("../src/native/bionic.ts");
  const files = adb("shell", "find", "/apex/com.android.i18n/etc", "/apex/com.android.tzdata/etc", "/system/fonts", "/system/usr/hyphen-data", "-type", "f").split(/\s+/);
  for (const src of [...files, "/system/etc/fonts.xml", "/system/etc/font_fallback.xml", ...DEVICE_LIBS]) data[src] = await mirror(src);
  Object.assign(data, await recordFontUpdates());
  // the libraries <uses-library> names: SystemConfig's <library> jars under /system, mirrored too
  const libraries: Libraries = {};
  for (const [, attrs] of adb("shell", "cat /system/etc/permissions/*.xml").matchAll(/<library\b([^>]*)>/g)) {
    const at = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
    const name = at("name"), path = at("file");
    if (!name || !path?.startsWith("/system/") || !path.endsWith(".jar")) continue;
    data[path] = await mirror(path);
    libraries[name] = { path, dependencies: at("dependency")?.split(":") ?? [] };
  }
  writeFileSync(`${OUT}/build.txt`, `${fingerprint}\nsdk ${adb("shell", "getprop", "ro.build.version.sdk")}\n`);
  const recorders = Object.entries(RECORDERS).filter(([, { named }]) => !named);
  for (const [, { record, boots }] of recorders) if (!boots) await record();
  writeBootClasspath(jars, bootJars, data, libraries);
  // the class path just written is loaded apart from the one this process imported
  for (const [name, { boots }] of recorders) if (boots && spawnSync(...nodeCommand(import.meta.filename, "--only", name), { stdio: "inherit" }).status) throw new Error(`recording ${name} failed`);
}

for (const f of [JAR, RES]) if (!existsSync(f)) throw new Error(`missing ${f} — run \`pnpm gen-framework\` with the reference AVD booted`);

/** the font updates alone: PLATFORM_DATA with the device's updated fonts in place of those recorded */
async function recordFonts() {
  const data = { ...Object.fromEntries(Object.entries(PLATFORM_DATA).filter(([path]) => !path.startsWith(UPDATED_FONTS))), ...await recordFontUpdates() };
  writeBootClasspath(PLATFORM_JARS, BOOT_JAR_PATHS, data, SHARED_LIBRARIES);
}

/** The fonts the reference device's FontManagerService serves in place of the image's, which GMS's
 *  font updater installed (src/android/font-updates.ts): the files its UpdatableFontDir holds, by
 *  the PostScript name OtfFontFileParser reads, and its configuration's date and version. Pulls the
 *  files and returns their sizes for PLATFORM_DATA. */
async function recordFontUpdates(): Promise<Record<string, number>> {
  await asRoot();
  const files = adb("shell", `find ${UPDATED_FONTS} -type f -name '*.[ot]tf' 2>/dev/null; true`).split(/\s+/).filter(Boolean);
  const data: Record<string, number> = {}, postScriptMap: Record<string, string> = {};
  for (const src of files) {
    data[src] = await mirror(src);
    postScriptMap[postScriptName(new Uint8Array(readFileSync(`${OUT}${src}`)), 0)!] = src;
  }
  const config = files.length ? adb("shell", "abx2xml", "/data/fonts/config/config.xml", "-") : "";
  // a named family an update adds (FontManager.updateFontFamily) joins the configuration's own
  if (/<family\b/.test(config)) throw new Error("the device's font update adds families, which are not recorded");
  const lastModifiedDate = Number(/<lastModifiedDate value="(\d+)"/.exec(config)?.[1] ?? 0);
  const configVersion = Number(/Current Version: (\d+)/.exec(adb("shell", "cmd", "font", "status"))![1]);
  writeGenerated("src/android/font-updates.ts", ": the reference device's updated system fonts, as its\n" +
    "FontManagerService serves them: each file by PostScript name, and the configuration's date and version.",
    `export const FONT_UPDATES = {\n  postScriptMap: ${JSON.stringify(postScriptMap)} as Record<string, string>,\n` +
    `  lastModifiedDate: ${lastModifiedDate},\n  configVersion: ${configVersion},\n};\n`, `${files.length} updated fonts`);
  return data;
}

/** The framework values the reference device's enabled overlays replace, as it resolves them in its
 *  own configuration: SystemUI's Monet palette, the gestural navigation bar's insets and scrim, the
 *  Google and Pixel configuration. Only inline values; strings, arrays and files keep framework-res's. */
async function recordDeviceOverlays() {
  const table = new Arsc(unzipSync(new Uint8Array(readFileSync(RES)), { filter: (f) => f.name === "resources.arsc" })["resources.arsc"]);
  const keys = new Set<string>();
  for (const [, overlay] of adb("shell", "cmd", "overlay", "list", "android").matchAll(/^\[x\] (\S+)/gm))
    for (const [, key] of adb("shell", "cmd", "overlay", "dump", overlay).matchAll(/^\s*0x[0-9a-f]{8} -> .*?\(((?:bool|integer|dimen|color)\/\w+)/gm)) keys.add(key);
  const list = [...keys], values: [string, string][] = [];
  // batched: a longer command line closes adb's shell
  for (let i = 0; i < list.length; i += 100) {
    for (const line of adb("shell", `for k in ${list.slice(i, i + 100).join(" ")}; do echo "$k $(cmd overlay lookup android android:$k)"; done`).split("\n")) {
      const [key, text] = line.trim().split(" "), [type, name] = key.split("/");
      const value = resValue(type, text), own = table.entry(table.names(type).get(name)!)?.value;
      // a color the table holds as RGB8 rather than ARGB8 is the same color when its data is
      if (!value || own && own.data === value[1] && (own.type === value[0] || type === "color")) continue;
      values.push([JSON.stringify(key), `[0x${value[0].toString(16)}, ${type === "color" ? "0x" + (value[1] >>> 0).toString(16) : value[1]}]`]);
    }
  }
  writeGenerated("src/android/device-overlays.ts", ": the framework values the reference device's overlays replace.",
    constObject("DEVICE_OVERLAYS", "Record<string, [type: number, data: number]>", values.sort()), `${values.length} overlaid values`);
}

/** a value `cmd overlay lookup` prints as its Res_value type and data */
function resValue(type: string, text: string): [number, number] | null {
  if (type === "bool" && /^(true|false)$/.test(text)) return [0x12, text === "true" ? -1 : 0];
  if (type === "integer" && /^-?\d+$/.test(text)) return [0x10, Number(text)];
  if (type === "color" && /^#[0-9a-f]{8}$/.test(text)) return [0x1c, parseInt(text.slice(1), 16) | 0];
  const dimension = type === "dimen" ? /^(-?[\d.]+)([a-z]*)$/.exec(text) : null;
  const f = Number(dimension?.[1]), unit = ["px", "dip", "sp", "pt", "in", "mm"].indexOf(dimension?.[2]!);
  if (dimension?.[2] === "") return [0x04, new Int32Array(new Float32Array([f]).buffer)[0]];
  if (unit < 0) return null;
  // TypedValue's complex form, packed as aapt's floatToComplex packs it
  const bits = Math.round(Math.abs(f) * 2 ** 23);
  const [radix, shift] = bits % 2 ** 23 === 0 ? [0, 23] : bits < 2 ** 23 ? [3, 0] : bits < 2 ** 31 ? [2, 8] : bits < 2 ** 39 ? [1, 16] : [0, 23];
  const mantissa = (f < 0 ? -Math.floor(bits / 2 ** shift) : Math.floor(bits / 2 ** shift)) & 0xffffff;
  return [0x05, mantissa << 8 | radix << 4 | unit];
}

/** the compat changes the reference device's PlatformCompat disables for some app: by id, the target
 *  SDK each is enabled from, Infinity for those it disables for every app */
async function recordCompatChanges() {
  const changes: [string, string][] = [];
  for (const [, id, rest] of adb("shell", "dumpsys", "platform_compat").matchAll(/^ChangeId\((\d+); name=\w+(.*)\)\s*$/gm)) {
    const since = Number(/; enableSinceTargetSdk=(\d+)/.exec(rest)?.[1] ?? 0);
    if (rest.includes("; disabled")) changes.push([id, "Infinity"]);
    else if (since > 1) changes.push([id, String(since)]);
  }
  writeGenerated("src/android/compat-changes.ts", ": the compat changes the reference device disables for some app.",
    constObject("COMPAT_CHANGES", "Record<number, number>", changes), `${changes.length} changes`);
}

/** android.system.OsConstants as the reference device's libcore initializes them (initConstants) */
async function recordOsConstants() {
  const values = runDex("scripts/DumpOsConstants.java").split("\n")
    .map((line) => line.trim().split(" ")).filter(([name, value]) => name && /^-?\d+$/.test(value)).map(([n, v]) => [n, v] as const);
  writeGenerated("src/android/os-constants.ts", ": android.system.OsConstants on the reference device.",
    constObject("OS_CONSTANTS", "Record<string, number>", values), `${values.length} constants`);
}

/** the single-byte charsets as the reference device's ICU converters decode them, byte by byte */
async function recordCharsets() {
  const rows = runDex("scripts/DumpCharsets.java").split("\n").map((line) => {
    const [name, aliases, replacement, table, oneWay] = line.trim().split("\t");
    const chars = String.fromCharCode(...table.trim().split(" ").map((h) => parseInt(h, 16)));
    const list = (s: string | undefined) => `[${s?.trim() ? s.trim().split(" ").join(", ") : ""}]`;
    return `  [${JSON.stringify(name)}, ${JSON.stringify(aliases ? aliases.split(" ") : [])}, ${list(replacement)}, ${JSON.stringify(chars)}, ${list(oneWay)}],`;
  });
  writeGenerated("src/jvm/charset-tables.ts", ": the reference device's single-byte charsets as\n" +
    "[name, aliases as aliases() iterates them, encoder replacement, the character each byte 0-255\n" +
    "decodes to, the bytes whose character does not encode back to them].",
    `export const SINGLE_BYTE_CHARSETS: [string, string[], number[], string, number[]][] = [\n${rows.join("\n")}\n];\n`, `${rows.length} charsets`);
}

/** The device's settings tables as SettingsProvider holds them for an app (src/android/device-settings.ts).
 *  System, Secure and Global keep the non-null settings some third-party app may read: a key the
 *  Settings class declares only if it is @Readable (Settings.X.getPublicSettings, which the provider
 *  enforces per caller), and not one the provider gates on a permission no app holds. Settings that
 *  name this AVD or its media go: the SSAID and device name are derived per app and from Build.MODEL,
 *  this device has no Bluetooth adapter, and the default sounds name media files it does not have.
 *  Device config keeps the flags a class on the boot class path that reads DeviceConfig or
 *  Settings.Config names, which is what an app process can ask for. */
async function recordSettings() {
  await bootTier();
  const { publicSettings } = await import("../src/android/settings.ts");
  const parse = (text: string) => text.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const);
  const DROPPED = new Set(["android_id", "device_name", "bluetooth_name", "bluetooth_address", "bluetooth_addr_valid", "multi_sim_data_call",
    "ringtone", "ringtone_set", "notification_sound", "notification_sound_set", "alarm_alert", "alarm_alert_set"]);
  // the AVD's apps that fill a role (IME, assistant, autofill, spell checker...) are not on this device
  const avdPackages = new Set(adb("shell", "pm", "list", "packages").split("\n").map((line) => line.trim().replace(/^package:/, "")));
  const ours = new Set<string>(SYSTEM_PACKAGES.map((p) => p.pkg));
  const namesAvdApp = (name: string, value: string) => [...value.matchAll(/([a-zA-Z][\w]*(?:\.[\w]+)+)\/[\w.$]+/g)].some((m) => avdPackages.has(m[1])) ||
    name.endsWith("_package") && avdPackages.has(value) && !ours.has(value);
  const tables: Record<string, Record<string, string>> = {};
  for (const table of ["system", "secure", "global"] as const) {
    const { all, readable } = await publicSettings(table);
    tables[table] = Object.fromEntries(parse(adb("shell", "settings", "list", table))
      .filter(([name, value]) => value !== "null" && all.has(name) && readable.has(name) && !DROPPED.has(name) && !namesAvdApp(name, value) &&
        !/^\/(?:product|system)\/media\//.test(value)));
  }
  const named = new Set<string>();
  const CONFIG_READERS = new Set(["Landroid/provider/DeviceConfig;", "Landroid/provider/DeviceConfigInterface;", "Landroid/provider/Settings$Config;"]);
  for (const jar of PLATFORM_JARS) for (const dex of loadDexes(`${OUT}/${jar}`)) for (let i = 0; i < dex.classDefCount; i++) {
    const def = dex.classDef(i), strings: string[] = [];
    let reads = false;
    for (const m of [...def.directMethods, ...def.virtualMethods]) {
      if (!m.codeOff) continue;
      const { insns } = dex.code(m.codeOff);
      for (let pc = 0; pc < insns.length; pc += insnLen(insns, pc)) {
        const op = insns[pc] & 0xff;
        if (op === 0x1a) strings.push(dex.string(insns[pc + 1]));
        else if (op === 0x1b) strings.push(dex.string(insns[pc + 1] | insns[pc + 2] << 16));
        else if (op >= 0x6e && op <= 0x78 && op !== 0x73 && CONFIG_READERS.has(dex.type(dex.method(insns[pc + 1]).cls))) reads = true;
      }
    }
    if (reads) for (const s of strings) named.add(s);
  }
  tables.config = Object.fromEntries(parse(adb("shell", "device_config", "list")).filter(([key]) => named.has(key.slice(key.indexOf("/") + 1))));
  writeGenerated("src/android/device-settings.ts", ": the reference device's settings tables as an app may read them.",
    `export const DEVICE_SETTINGS: Record<"system" | "secure" | "global" | "config", Record<string, string>> = {\n` +
    Object.entries(tables).map(([table, values]) => `  ${table}: {\n${Object.entries(values).map(([n, v]) => `    ${JSON.stringify(n)}: ${JSON.stringify(v)},`).join("\n")}\n  },`).join("\n") +
    `\n};\n`, Object.entries(tables).map(([t, v]) => `${t} ${Object.keys(v).length}`).join(", "));
}

/** The reference AVD's platform properties as an app process reads them (src/shell/platform-properties.ts):
 *  of the property areas whose SELinux context the policy lets untrusted_app read (selinuxfs computes
 *  each decision, which needs root), those buildFixed keeps that are not identity. */
async function recordProperties() {
  await asRoot();
  const parse = (text: string) => text.split("\n").map((line) => /^\[(.*?)\]: \[(.*)\]\r?$/.exec(line)).filter((m) => m !== null).map((m) => [m[1], m[2]] as const);
  const contexts = new Map(parse(adb("shell", "getprop", "-Z")));
  const query = (ctx: string) => `exec 3<>/sys/fs/selinux/access; printf '%s' "u:r:untrusted_app:s0:c512,c768 ${ctx} $(cat /sys/fs/selinux/class/file/index)" >&3; ` +
    `read -r a <&3; exec 3>&-; echo "${ctx} $a"`;
  const readBit = 1 << (Number(adb("shell", "cat", "/sys/fs/selinux/class/file/perms/read")) - 1);
  const readable = new Set(adb("shell", [...new Set(contexts.values())].map(query).join("; ")).split("\n")
    .map((line) => line.trim().split(" ")).filter(([, allowed]) => parseInt(allowed, 16) & readBit).map(([ctx]) => ctx));
  const properties = parse(adb("shell", "getprop")).filter(([name, value]) => readable.has(contexts.get(name)!) && buildFixed(name, value) && !identity(name));
  writeProperties("src/shell/platform-properties.ts", "PLATFORM_PROPERTIES", properties,
    ": the reference device's platform properties as an app reads\nthem (see recordProperties).");
}

/** The key character maps of the device's virtual keyboard and touchscreen, and the key codes each
 *  device reports having (InputDevice.hasKeys), which come from its key layout and its kernel's keys */
async function recordInputDevices() {
  const keys: Record<string, number[]> = {};
  for (const line of runDex("scripts/DumpInputDevices.java", { android: true }).split("\n")) {
    const [name, codes = ""] = line.trim().split("\t");
    if (name === "Virtual" || name === "virtio_input_multi_touch_1") keys[name] = codes.split(" ").filter(Boolean).map(Number);
  }
  // full-line comments go; a '#' inside a character literal is the key's character
  const kcm = (file: string) => adb("shell", "cat", `/system/usr/keychars/${file}`).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).join("\n");
  writeGenerated("src/android/keychars.ts", ": the reference device's key character maps (AOSP's\n" +
    "/system/usr/keychars, Apache-2.0, comments removed) and the key codes InputDevice.hasKeys reports\n" +
    "for its touchscreen and its virtual keyboard, whose negative id asks every device of the AVD.",
    constObject("KEY_CHARACTER_MAPS", "Record<string, string>", ["Virtual.kcm", "Generic.kcm"].map((f) => [JSON.stringify(f), JSON.stringify(kcm(f))])) +
    constObject("DEVICE_KEYS", "Record<string, number[]>", Object.entries(keys).map(([n, c]) => [JSON.stringify(n), `[${c.join(", ")}]`])), `${Object.keys(keys).length} devices`);
}

/** StaticLayout's breaks, line extents and hyphenated glyphs of the paragraphs textcmp lays out (which it reads back from the fixture's case
 *  lines), and getTextWidths across weights and sizes for fwtest (fonts.ts) */
async function recordTextLayouts() {
  const FIXTURE = "tests/fixtures/textlayout-device.txt", WIDTHS = "tests/fixtures/textwidths-device.txt";
  /** text, width px, text size px, and for hyphenated layouts the locale and hyphenation frequency */
  const PARAGRAPHS: [string, number, number, string?, number?][] = [
    ["The quick brown fox jumps over the lazy dog", 200, 24],
    ["The quick brown fox jumps over the lazy dog", 720, 24],
    ["Supercalifragilisticexpialidocious antidisestablishmentarianism", 180, 24],
    ["https://example.com/a/very/long/path/that/cannot/be/broken/on/a/space", 200, 24],
    ["one\ntwo three four five six seven eight nine ten\n\neleven", 160, 28],
    ["a b c d e f g h i j k l m n o p q r s t u v w x y z", 100, 20],
    ["A well-known state-of-the-art hyphenated compound", 150, 24],
    ["Write to someone.name@example.com for details", 180, 24],
    ["Tabs\tand\tmore\ttabs\there to see how they wrap", 200, 24],
    ["日本語のテキストを改行するテストです。", 150, 24],
    ["Emoji 👍🏽 family 👨‍👩‍👧 flags 🇨🇦🇯🇵 end", 160, 24],
    ["Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.", 300, 20],
    ...([["en-US", "Hyphenation breaks extraordinarily long words like internationalization and responsibilities"],
      ["de", "Die Donaudampfschifffahrtsgesellschaft sucht Rechtsschutzversicherungsgesellschaften"]] as const).flatMap(([locale, text]) =>
      [[text, 160, 24, locale, 1], [text, 160, 24, locale, 2], [text, 100, 20, locale, 2]] as [string, number, number, string, number][]),
  ];
  /** weight and size of the getTextWidths cases fwtest compares (fonts.ts) */
  const WIDTH_CASES = [100, 300, 400, 500, 700, 900].flatMap((w) => [10, 12, 13.5, 14, 16, 18, 20, 24, 32, 40].map((s) => `${w} ${s}`));
  const dir = tempDir(), cases = PARAGRAPHS.map(([t, ...rest]) => [t.replace(/\n/g, "\\n").replace(/\t/g, "\\t"), ...rest].join("\t"));
  writeFileSync(`${dir}/cases.txt`, cases.join("\n") + "\n");
  writeFileSync(`${dir}/widths.txt`, WIDTH_CASES.join("\n") + "\n");
  adb("push", `${dir}/cases.txt`, "/data/local/tmp/webdroid-textlayout.txt");
  adb("push", `${dir}/widths.txt`, "/data/local/tmp/webdroid-textwidths.txt");
  const out = runDex("scripts/TextLayoutProbe.java", { android: true, args: ["/data/local/tmp/webdroid-textlayout.txt", "/data/local/tmp/webdroid-textwidths.txt"] }).split("\n");
  const layouts = out.filter((l) => !l.startsWith("widths "));
  writeFileSync(FIXTURE, [...cases.map((c, i) => `case ${i}\t${c}`), ...layouts].join("\n") + "\n");
  writeFileSync(WIDTHS, out.filter((l) => l.startsWith("widths ")).join("\n") + "\n");
  console.log(`${FIXTURE}: ${layouts.length} rows; ${WIDTHS}`);
}

// --- verify: every id the framework's own R classes name must resolve in the paired table ---
const jarDexes = loadDexes(JAR);
console.log(`${JAR}: ${jarDexes.length} dex, ${jarDexes.reduce((n, d) => n + d.classDefCount, 0)} classes`);

const tableOf = async (apk: string) =>
  new Arsc(unzipSync(new Uint8Array(readFileSync(apk)), { filter: (f) => f.name === "resources.arsc" })["resources.arsc"]);
const paired = await tableOf(RES);

/** every (name, id) pair the R$<type> classes in the framework dex declare: the ids are constants,
 *  their static values; styleables are int[] built in <clinit>, and not what a table answers for */
function rIds(): Map<string, number> {
  const out = new Map<string, number>();
  for (const dex of jarDexes) for (let i = 0; i < dex.classDefCount; i++) {
    const def = dex.classDef(i), name = descToName(dex.type(dex.classDef2Type(i)));
    if (!/^(android|com\/android\/internal)\/R\$/.test(name) || !def.staticValuesOff) continue;
    const type = name.slice(name.indexOf("$") + 1), values = dex.encodedArray(def.staticValuesOff);
    def.staticFields.forEach((sf, j) => {
      const v = values[j];
      if (typeof v === "number" && v >>> 24 === 0x01) out.set(`${type}/${dex.field(sf.fieldIdx).name}`, v);
    });
  }
  return out;
}

const ids = rIds();
// "an entry exists at this id" is not the test — a table whose ids shifted still answers
// almost every one. The name at the id has to be the name the bytecode compiled against.
const check = (a: Arsc) => {
  let hit = 0, wrong = 0, absent = 0;
  const examples: string[] = [];
  for (const [k, id] of ids) {
    const e = a.entry(id);
    const want = k.slice(k.indexOf("/") + 1);
    // R.java spells an entry as a java identifier, so a dotted style name arrives underscored
    if (!e) absent++;
    else if (e.key.replace(/\./g, "_") === want) hit++;
    else { wrong++; if (examples.length < 6) examples.push(`0x${(id >>> 0).toString(16)} is "${e.key}", bytecode says "${want}"`); }
  }
  return { hit, wrong, absent, examples };
};

const report = (label: string, r: ReturnType<typeof check>) => {
  console.log(`  ${label}: ${r.hit} right (${((r.hit / ids.size) * 100).toFixed(1)}%), ${r.wrong} wrong name, ${r.absent} absent`);
  for (const e of r.examples) console.log(`      ${e}`);
};

console.log(`R ids declared by the framework dex: ${ids.size}`);
const p = check(paired);
report(RES, p);
if (p.wrong) throw new Error(`${p.wrong} ids name a different resource in ${RES} than in ${JAR} — the two halves are not from one build`);
