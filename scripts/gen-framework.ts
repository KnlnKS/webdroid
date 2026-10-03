// Pull the real android: framework off the reference device and prove the two halves match.
//
//   bun run gen-framework            # pull from a connected device/emulator, then verify
//   bun run gen-framework --verify   # verify what is already in vendor/aosp
//   bun run gen-framework --charsets # record only the device's single-byte charsets
//   bun run gen-framework --input    # record only the device's key character maps and key sets
//   bun run gen-framework --settings # record only the device's settings tables
//   bun run gen-framework --properties # record only the device's platform properties
//   bun run gen-framework --fonts    # record only the device's updated system fonts
//   bun run gen-framework --identity [url] # record the identity properties and uname of a phone's
//                                    factory image, by default the Pixel 9's (no device needed)
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
import { existsSync } from "node:fs";
import { unzipSync } from "fflate";
import { rt } from "../src/jvm/runtime";
import { loadJarDexes, mountLocalPlatformData, openDexes } from "./lib";
import "../src/natives";
import { mangleStaticField } from "../src/jvm/abi";
import { insnLen } from "../src/jvm/opcodes";
import { PLATFORM_JARS, PLATFORM_DATA } from "../src/jvm/bootclasspath";
import { loadPlatformJar } from "../src/android/framework";
import { SYSTEM_PACKAGES } from "../src/shell/system-packages";
import { Arsc } from "../src/android/arsc";
import { postScriptName } from "../src/android/sfnt";
import { androidPlatform, androidTool } from "./android-sdk";

const OUT = "vendor/aosp";
const JAR = `${OUT}/framework.jar`, RES = `${OUT}/framework-res.apk`;
/** where the device's FontManagerService keeps the font files it installs */
const UPDATED_FONTS = "/data/fonts/files/";
const sh = (...args: string[]) => {
  const r = Bun.spawnSync([androidTool("adb"), ...args], { stderr: "pipe", stdout: "pipe" });
  if (r.exitCode !== 0) throw new Error(`adb ${args.join(" ")} failed:\n${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
};

if (process.argv.includes("--charsets")) { await recordCharsets(); process.exit(0); }
if (process.argv.includes("--input")) { await recordInputDevices(); process.exit(0); }
if (process.argv.includes("--settings")) { await recordSettings(); process.exit(0); }
if (process.argv.includes("--properties")) { await recordProperties(); process.exit(0); }
if (process.argv.includes("--fonts")) {
  const data = { ...Object.fromEntries(Object.entries(PLATFORM_DATA).filter(([path]) => !path.startsWith(UPDATED_FONTS))), ...await recordFontUpdates() };
  const file = "src/jvm/bootclasspath.ts", src = await Bun.file(file).text();
  await Bun.write(file, src.replace(/(export const PLATFORM_DATA: Record<string, number> = ).*;/, (_, decl) => `${decl}${JSON.stringify(data)};`));
  process.exit(0);
}
if (process.argv.includes("--identity")) {
  await recordIdentity(process.argv[process.argv.indexOf("--identity") + 1] ?? "https://dl.google.com/dl/android/aosp/tokay-ap3a.241005.015-factory-88013873.zip");
  process.exit(0);
}
if (!process.argv.includes("--verify")) {
  sh("wait-for-device");
  for (let i = 0; sh("shell", "getprop", "sys.boot_completed") !== "1"; i++) {
    if (i > 90) throw new Error("device never reported sys.boot_completed — boot it with `bun run e2e:boot`");
    await Bun.sleep(2000);
  }
  const fingerprint = sh("shell", "getprop", "ro.build.fingerprint");
  console.log(`pulling from ${fingerprint}`);
  await Bun.$`mkdir -p ${OUT}/boot`.quiet();
  // the whole BOOTCLASSPATH, in its order: framework.jar keeps its own path, the rest go to boot/
  const bootJars = sh("shell", "echo", "$BOOTCLASSPATH").split(":").filter(Boolean);
  const jars: string[] = [];
  const pull = (src: string, dst: string) => {
    sh("pull", src, `${OUT}/${dst}`);
    console.log(`  ${dst} ${(Bun.file(`${OUT}/${dst}`).size / 1e6).toFixed(1)}MB`);
  };
  for (const src of bootJars) {
    const name = src.slice(src.lastIndexOf("/") + 1), dst = name === "framework.jar" ? name : `boot/${name}`;
    pull(src, dst);
    jars.push(dst);
  }
  pull("/system/framework/framework-res.apk", "framework-res.apk");
  pull("/system/etc/preloaded-classes", "preloaded-classes");
  // ART's boot image profile as text: the framework methods the platform measured hot (§4.3).
  // Only root may run profman.
  sh("root");
  await Bun.sleep(2000); // adbd restarts as root
  sh("wait-for-device");
  sh("shell", `/apex/com.android.art/bin/profman --profile-file=/system/etc/boot-image.prof ${bootJars.map((j) => `--apk=${j} --dex-location=${j}`).join(" ")}` +
    " --dump-classes-and-methods > /data/local/tmp/boot-image-profile.txt");
  pull("/data/local/tmp/boot-image-profile.txt", "boot-image-profile.txt");
  // ICU data, the time zone module's files, the system fonts and their configuration, the
  // hyphenation patterns, and bionic's libraries, at their device paths
  const data: Record<string, number> = {};
  const { DEVICE_LIBS } = await import("../src/native/bionic");
  const files = sh("shell", "find", "/apex/com.android.i18n/etc", "/apex/com.android.tzdata/etc", "/system/fonts", "/system/usr/hyphen-data", "-type", "f").split(/\s+/);
  for (const src of [...files, "/system/etc/fonts.xml", "/system/etc/font_fallback.xml", ...DEVICE_LIBS]) {
    await Bun.$`mkdir -p ${`${OUT}${src.slice(0, src.lastIndexOf("/"))}`}`.quiet();
    pull(src, src.slice(1));
    data[src] = Bun.file(`${OUT}${src}`).size;
  }
  Object.assign(data, await recordFontUpdates());
  // the libraries <uses-library> names: SystemConfig's <library> jars under /system, mirrored too
  const libraries: Record<string, { path: string; dependencies: string[] }> = {};
  for (const [, attrs] of sh("shell", "cat /system/etc/permissions/*.xml").matchAll(/<library\b([^>]*)>/g)) {
    const at = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
    const name = at("name"), path = at("file");
    if (!name || !path?.startsWith("/system/") || !path.endsWith(".jar")) continue;
    await Bun.$`mkdir -p ${`${OUT}${path.slice(0, path.lastIndexOf("/"))}`}`.quiet();
    pull(path, path.slice(1));
    data[path] = Bun.file(`${OUT}${path}`).size;
    libraries[name] = { path, dependencies: at("dependency")?.split(":") ?? [] };
  }
  await Bun.write(`${OUT}/build.txt`, `${fingerprint}\nsdk ${sh("shell", "getprop", "ro.build.version.sdk")}\n`);
  await recordDeviceColors();
  await recordOsConstants();
  await recordCharsets();
  await recordInputDevices();
  await recordProperties();
  await Bun.write("src/jvm/bootclasspath.ts", `// Generated by bun run gen-framework from the reference device's BOOTCLASSPATH.\n` +
    `/** the platform class path under vendor/aosp, in class-path order */\n` +
    `export const PLATFORM_JARS = ${JSON.stringify(jars, null, 1).replace(/\n\s*/g, " ")};\n` +
    `/** where each of those jars lives on the device */\n` +
    `export const BOOT_JAR_PATHS = ${JSON.stringify(bootJars, null, 1).replace(/\n\s*/g, " ")};\n` +
    `/** the ICU and time zone files, fonts and their updates, hyphenation patterns and bionic's libraries, by device path (mirrored under vendor/aosp), with their sizes */\n` +
    `export const PLATFORM_DATA: Record<string, number> = ${JSON.stringify(data)};\n` +
    `/** the shared libraries by name, with the ones each loads first */\n` +
    `export const SHARED_LIBRARIES: Record<string, { path: string; dependencies: string[] }> = ${JSON.stringify(libraries)};\n`);
  // its own process: it boots the class path just written, which the verification below loads apart
  if (Bun.spawnSync(["bun", "scripts/gen-framework.ts", "--settings"], { stdout: "inherit", stderr: "inherit" }).exitCode) throw new Error("recording settings failed");
}

for (const f of [JAR, RES]) if (!existsSync(f)) throw new Error(`missing ${f} — run \`bun run gen-framework\` with the reference AVD booted`);

/** The fonts the reference device's FontManagerService serves in place of the image's, which GMS's
 *  font updater installed (src/android/font-updates.ts): the files its UpdatableFontDir holds, by
 *  the PostScript name OtfFontFileParser reads, and its configuration's date and version. Pulls the
 *  files and returns their sizes for PLATFORM_DATA. */
async function recordFontUpdates(): Promise<Record<string, number>> {
  sh("root");
  sh("wait-for-device");
  const files = sh("shell", `find ${UPDATED_FONTS} -type f -name '*.[ot]tf' 2>/dev/null; true`).split(/\s+/).filter(Boolean);
  const data: Record<string, number> = {}, postScriptMap: Record<string, string> = {};
  for (const src of files) {
    await Bun.$`mkdir -p ${`${OUT}${src.slice(0, src.lastIndexOf("/"))}`}`.quiet();
    sh("pull", src, `${OUT}${src}`);
    data[src] = Bun.file(`${OUT}${src}`).size;
    postScriptMap[postScriptName(new Uint8Array(await Bun.file(`${OUT}${src}`).arrayBuffer()), 0)!] = src;
  }
  const config = files.length ? sh("shell", "abx2xml", "/data/fonts/config/config.xml", "-") : "";
  // a named family an update adds (FontManager.updateFontFamily) joins the configuration's own
  if (/<family\b/.test(config)) throw new Error("the device's font update adds families, which are not recorded");
  const lastModifiedDate = Number(/<lastModifiedDate value="(\d+)"/.exec(config)?.[1] ?? 0);
  const configVersion = Number(/Current Version: (\d+)/.exec(sh("shell", "cmd", "font", "status"))![1]);
  await Bun.write("src/android/font-updates.ts", `// Generated by bun run gen-framework: the reference device's updated system fonts, as its\n` +
    `// FontManagerService serves them: each file by PostScript name, and the configuration's date and version.\n` +
    `export const FONT_UPDATES = {\n  postScriptMap: ${JSON.stringify(postScriptMap)} as Record<string, string>,\n` +
    `  lastModifiedDate: ${lastModifiedDate},\n  configVersion: ${configVersion},\n};\n`);
  console.log(`  src/android/font-updates.ts ${files.length} updated fonts`);
  return data;
}

/** The reference device's system_* colors as its overlays resolve them: SystemUI's Monet palette
 *  for the default wallpaper replaces most framework-res defaults, and apps read these colors. */
async function recordDeviceColors() {
  const table = new Arsc(unzipSync(new Uint8Array(await Bun.file(RES).arrayBuffer()), { filter: (f) => f.name === "resources.arsc" })["resources.arsc"]);
  const names = [...table.names("color").keys()].filter((n) => n.startsWith("system_"));
  const script = names.map((n) => `echo "${n} $(cmd overlay lookup android android:color/${n})"`).join(";");
  const colors: Record<string, string> = {};
  for (const line of sh("shell", script).split("\n")) {
    const [name, value] = line.trim().split(" ");
    const own = table.entry(table.names("color").get(name)!)?.value;
    if (/^#[0-9a-f]{1,8}$/.test(value) && parseInt(value.slice(1), 16) !== own?.data! >>> 0) colors[name] = "0x" + value.slice(1).padStart(8, "0");
  }
  await Bun.write("src/android/device-colors.ts", `// Generated by bun run gen-framework: the reference device's overlaid system_* colors.\n` +
    `export const DEVICE_COLORS: Record<string, number> = {\n${Object.entries(colors).map(([n, v]) => `  ${n}: ${v},`).join("\n")}\n};\n`);
  console.log(`  src/android/device-colors.ts ${Object.keys(colors).length} overlaid colors`);
}

/** android.system.OsConstants as the reference device's libcore initializes them (initConstants) */
async function recordOsConstants() {
  const dir = (await Bun.$`mktemp -d`.text()).trim(), java = process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/javac` : "javac";
  await Bun.$`${java} --release 17 -d ${dir} scripts/DumpOsConstants.java`.quiet();
  await Bun.$`${androidTool("d8")} --output ${dir} ${dir}/DumpOsConstants.class`.quiet();
  sh("push", `${dir}/classes.dex`, "/data/local/tmp/webdroid-osconstants.dex");
  const values = sh("shell", "CLASSPATH=/data/local/tmp/webdroid-osconstants.dex app_process / DumpOsConstants").split("\n")
    .map((line) => line.trim().split(" ")).filter(([name, value]) => name && /^-?\d+$/.test(value));
  await Bun.write("src/android/os-constants.ts", `// Generated by bun run gen-framework: android.system.OsConstants on the reference device.\n` +
    `export const OS_CONSTANTS: Record<string, number> = {\n${values.map(([n, v]) => `  ${n}: ${v},`).join("\n")}\n};\n`);
  console.log(`  src/android/os-constants.ts ${values.length} constants`);
}

/** the single-byte charsets as the reference device's ICU converters decode them, byte by byte */
async function recordCharsets() {
  const dir = (await Bun.$`mktemp -d`.text()).trim(), java = process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/javac` : "javac";
  await Bun.$`${java} --release 17 -d ${dir} scripts/DumpCharsets.java`.quiet();
  await Bun.$`${androidTool("d8")} --output ${dir} ${dir}/DumpCharsets.class`.quiet();
  sh("push", `${dir}/classes.dex`, "/data/local/tmp/webdroid-charsets.dex");
  const rows = sh("shell", "CLASSPATH=/data/local/tmp/webdroid-charsets.dex app_process / DumpCharsets").split("\n").map((line) => {
    const [name, aliases, replacement, table, oneWay] = line.trim().split("\t");
    const chars = String.fromCharCode(...table.trim().split(" ").map((h) => parseInt(h, 16)));
    const list = (s: string | undefined) => `[${s?.trim() ? s.trim().split(" ").join(", ") : ""}]`;
    return `  [${JSON.stringify(name)}, ${JSON.stringify(aliases ? aliases.split(" ") : [])}, ${list(replacement)}, ${JSON.stringify(chars)}, ${list(oneWay)}],`;
  });
  await Bun.write("src/jvm/charset-tables.ts", `// Generated by bun run gen-framework: the reference device's single-byte charsets as\n` +
    `// [name, aliases as aliases() iterates them, encoder replacement, the character each byte 0-255\n` +
    `// decodes to, the bytes whose character does not encode back to them].\n` +
    `export const SINGLE_BYTE_CHARSETS: [string, string[], number[], string, number[]][] = [\n${rows.join("\n")}\n];\n`);
  console.log(`  src/jvm/charset-tables.ts ${rows.length} charsets`);
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
  for (const [i, jar] of PLATFORM_JARS.entries()) loadPlatformJar(new Uint8Array(await Bun.file(`${OUT}/${jar}`).arrayBuffer()), i);
  await mountLocalPlatformData();
  rt.linkNatives();
  const { publicSettings } = await import("../src/android/settings");
  const parse = (text: string) => text.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const);
  const DROPPED = new Set(["android_id", "device_name", "bluetooth_name", "bluetooth_address", "bluetooth_addr_valid", "multi_sim_data_call",
    "ringtone", "ringtone_set", "notification_sound", "notification_sound_set", "alarm_alert", "alarm_alert_set"]);
  // the AVD's apps that fill a role (IME, assistant, autofill, spell checker...) are not on this device
  const avdPackages = new Set(sh("shell", "pm", "list", "packages").split("\n").map((line) => line.trim().replace(/^package:/, "")));
  const ours = new Set<string>(SYSTEM_PACKAGES.map((p) => p.pkg));
  const namesAvdApp = (name: string, value: string) => [...value.matchAll(/([a-zA-Z][\w]*(?:\.[\w]+)+)\/[\w.$]+/g)].some((m) => avdPackages.has(m[1])) ||
    name.endsWith("_package") && avdPackages.has(value) && !ours.has(value);
  const tables: Record<string, Record<string, string>> = {};
  for (const table of ["system", "secure", "global"] as const) {
    const { all, readable } = await publicSettings(table);
    tables[table] = Object.fromEntries(parse(sh("shell", "settings", "list", table))
      .filter(([name, value]) => value !== "null" && all.has(name) && readable.has(name) && !DROPPED.has(name) && !namesAvdApp(name, value) &&
        !/^\/(?:product|system)\/media\//.test(value)));
  }
  const named = new Set<string>();
  const CONFIG_READERS = new Set(["Landroid/provider/DeviceConfig;", "Landroid/provider/DeviceConfigInterface;", "Landroid/provider/Settings$Config;"]);
  for (const jar of PLATFORM_JARS) for (const dex of await openDexes(`${OUT}/${jar}`)) for (let i = 0; i < dex.classDefCount; i++) {
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
  tables.config = Object.fromEntries(parse(sh("shell", "device_config", "list")).filter(([key]) => named.has(key.slice(key.indexOf("/") + 1))));
  await Bun.write("src/android/device-settings.ts", `// Generated by bun run gen-framework: the reference device's settings tables as an app may read them.\n` +
    `export const DEVICE_SETTINGS: Record<"system" | "secure" | "global" | "config", Record<string, string>> = {\n` +
    Object.entries(tables).map(([table, values]) => `  ${table}: {\n${Object.entries(values).map(([n, v]) => `    ${JSON.stringify(n)}: ${JSON.stringify(v)},`).join("\n")}\n  },`).join("\n") +
    `\n};\n`);
  console.log(`  src/android/device-settings.ts ${Object.entries(tables).map(([t, v]) => `${t} ${Object.keys(v).length}`).join(", ")}`);
}

/** Of the properties an app may read, those a build fixes and that describe neither hardware this
 *  device replaces nor its runtime state. Dropped are:
 *  - mutable properties: daemons' and services' runtime state (init.svc.*, sys.*, gsm.*, dev.mnt.*),
 *    debug switches and server-pushed flags, none of which this device's services set;
 *  - ro.boot.*, ro.kernel.* and ro.adb.*: the bootloader's command line, qemu flags and adbd's setup;
 *  - the HAL, GPU and display selection (ro.hardware.*, ro.surface_flinger.*, ro.egl.*, the GLES and
 *    Vulkan versions, the density) and the media performance class: this device draws through the
 *    browser, at the live profile's density (config.ts), with the codecs and cameras it has;
 *  - ro.config.*'s media names, which name files this device does not have;
 *  - the ABI lists and ro.zygote, which src/shell/properties.ts derives from what the native tier runs;
 *  - empty values, which every reader takes as unset.
 *  ART's configuration (dalvik.vm.*) and the SDK extension levels are mutable in name only: init sets
 *  them from the build, so they stay. */
function buildFixed(name: string, value: string) {
  return value !== "" && /^(ro|dalvik\.vm|build\.version\.extensions)\./.test(name) &&
    !/^ro\.(boot|kernel|hardware|surface_flinger|egl|config|adb)\.|^ro\.(opengles|cpuvulkan)\.version$|^ro\.hwui\.use_vulkan$|^ro\.zygote|^ro\.sf\.lcd_density$|^ro\.odm\.build\.media_performance_class$/.test(name) &&
    !/^ro\.(\w+\.)?product\.cpu\.abi/.test(name);
}
/** Which product this is: its build, partitions' builds, product names, board, SoC, hardware and
 *  bootloader. These come from the identity image (recordIdentity) and the rest from the reference
 *  AVD (recordProperties), whose framework is the code that runs: its ART configuration, SDK
 *  extension levels and platform settings stay, and so do its heap sizes: the heap is this device's,
 *  not the phone's. recordIdentity checks that both name one API level. */
function identity(name: string) {
  return /^ro\.(build|product|soc|board|bootimage|(system|system_ext|system_dlkm|vendor|vendor_dlkm|odm|odm_dlkm|product)\.build)\./.test(name) ||
    /^ro\.(hardware|bootloader|baseband|bootmode|revision|serialno|vendor\.api_level)$/.test(name);
}

/** The reference AVD's platform properties as an app process reads them (src/shell/platform-properties.ts):
 *  of the property areas whose SELinux context the policy lets untrusted_app read (selinuxfs computes
 *  each decision, which needs root), those buildFixed keeps that are not identity. */
async function recordProperties() {
  sh("root");
  sh("wait-for-device");
  const parse = (text: string) => text.split("\n").map((line) => /^\[(.*?)\]: \[(.*)\]\r?$/.exec(line)).filter((m) => m !== null).map((m) => [m[1], m[2]] as const);
  const contexts = new Map(parse(sh("shell", "getprop", "-Z")));
  const query = (ctx: string) => `exec 3<>/sys/fs/selinux/access; printf '%s' "u:r:untrusted_app:s0:c512,c768 ${ctx} $(cat /sys/fs/selinux/class/file/index)" >&3; ` +
    `read -r a <&3; exec 3>&-; echo "${ctx} $a"`;
  const readBit = 1 << (Number(sh("shell", "cat", "/sys/fs/selinux/class/file/perms/read")) - 1);
  const readable = new Set(sh("shell", [...new Set(contexts.values())].map(query).join("; ")).split("\n")
    .map((line) => line.trim().split(" ")).filter(([, allowed]) => parseInt(allowed, 16) & readBit).map(([ctx]) => ctx));
  const properties = parse(sh("shell", "getprop")).filter(([name, value]) => readable.has(contexts.get(name)!) && buildFixed(name, value) && !identity(name));
  await writeProperties("src/shell/platform-properties.ts", "PLATFORM_PROPERTIES", properties,
    `// Generated by bun run gen-framework: the reference device's platform properties as an app reads\n// them (see recordProperties).\n`);
}

async function writeProperties(file: string, name: string, properties: (readonly [string, string])[], header: string, tail = "") {
  await Bun.write(file, `${header}export const ${name}: Record<string, string> = {\n${properties.map(([n, v]) => `  ${JSON.stringify(n)}: ${JSON.stringify(v)},`).join("\n")}\n};\n${tail}`);
  console.log(`  ${file} ${properties.length} properties`);
}

/** The identity of a production phone as an app reads it, and its kernel's uname but for the machine
 *  (src/shell/device-properties.ts), from the phone's factory image: the build.prop files of its
 *  partitions, merged and derived as init does (property_service.cpp PropertyLoadBootDefaults), what
 *  init takes from the bootloader where the image says what that is, and the kernel's banner. An app
 *  reads what the image's SELinux policy (its CIL, as init compiles it) lets untrusted_app read. */
async function recordIdentity(url: string) {
  const name = url.slice(url.lastIndexOf("/") + 1), cache = `${process.env.HOME}/.cache/webdroid/${name.replace(/\.zip$/, "")}`, zip = `${cache}/${name}`;
  await Bun.$`mkdir -p ${cache}`.quiet();
  if (!existsSync(zip)) await Bun.$`curl -fL -o ${zip}.part ${url} && mv ${zip}.part ${zip}`;
  const sha256 = (await Bun.$`shasum -a 256 ${zip}`.text()).split(" ")[0];
  // a factory image's name carries its digest's first 8 digits
  if (!sha256.startsWith(/-([0-9a-f]{8})\.zip$/.exec(name)![1])) throw new Error(`${name} has sha256 ${sha256}`);
  const images = `${cache}/image.zip`;
  if (!existsSync(images)) await Bun.$`unzip -p ${zip} '*/image-*.zip' > ${images}`;
  const entries = new Set((await Bun.$`unzip -Z1 ${images}`.text()).split("\n"));
  for (const entry of ["android-info.txt", "boot.img", ...["system", "system_ext", "product", "vendor", "system_dlkm", "vendor_dlkm", "odm", "odm_dlkm"].map((p) => `${p}.img`)]) {
    if (entries.has(entry) && !existsSync(`${cache}/${entry}`)) await Bun.$`unzip -o -d ${cache} ${images} ${entry}`.quiet();
  }
  const debugfs = Bun.which("debugfs", { PATH: `${process.env.PATH}:/opt/homebrew/opt/e2fsprogs/sbin:/usr/local/opt/e2fsprogs/sbin:/sbin` });
  if (!debugfs) throw new Error("debugfs reads the image's ext4 partitions: brew install e2fsprogs");
  const debug = (command: string, image: string) => Bun.spawnSync([debugfs, "-R", command, `${cache}/${image}.img`], { stdout: "pipe", stderr: "pipe" });
  /** a file of the device's tree, from the partition mounted there; null when there is none */
  const read = (path: string): string | null => {
    const [, part, rest] = /^\/(\w+)(\/.*)$/.exec(path)!;
    // odm and odm_dlkm are vendor's directories on a device without those partitions
    const [image, inner] = existsSync(`${cache}/${part}.img`) ? [part, part === "system" ? path : rest] : part.startsWith("odm") ? ["vendor", path] : [];
    if (!image) return null;
    const r = debug(`cat ${inner}`, image);
    return r.stderr.toString().includes("not found") ? null : r.stdout.toString();
  };

  // the policy init compiles: the platform's, system_ext's and product's with their mappings to
  // the vendor's version, the vendor's and the odm's
  const vers = read("/vendor/etc/selinux/plat_sepolicy_vers.txt")!.trim();
  const policy = ["/system/etc/selinux/plat_sepolicy.cil", `/system/etc/selinux/mapping/${vers}.cil`, `/system/etc/selinux/mapping/${vers}.compat.cil`,
    "/system_ext/etc/selinux/system_ext_sepolicy.cil", `/system_ext/etc/selinux/mapping/${vers}.cil`,
    "/product/etc/selinux/product_sepolicy.cil", `/product/etc/selinux/mapping/${vers}.cil`,
    "/vendor/etc/selinux/plat_pub_versioned.cil", "/vendor/etc/selinux/vendor_sepolicy.cil", "/odm/etc/selinux/odm_sepolicy.cil"];
  type Cil = string | Cil[];
  const attributes = new Map<string, Cil[]>(), allows: [string, string, string, string[]][] = [];
  for (const text of policy.map(read)) {
    const stack: Cil[][] = [[]];
    for (const [token] of text?.matchAll(/;[^\n]*|"[^"]*"|[()]|[^\s()";]+/g) ?? []) {
      if (token[0] === ";") continue;
      if (token === "(") {
        const list: Cil[] = [];
        stack.at(-1)!.push(list);
        stack.push(list);
      } else if (token !== ")") stack.at(-1)!.push(token);
      else if (stack.length === 2) {
        const [verb, a, b, perms] = stack.pop()! as [string, string, string, string[]];
        if (verb === "typeattributeset") attributes.set(a, [...attributes.get(a) ?? [], b]);
        else if (verb === "allow") allows.push([a, b, perms[0], perms[1] as unknown as string[]]);
      } else stack.pop();
    }
  }
  const memo = new Map<string, boolean>();
  const isA = (type: string, name: string): boolean => {
    if (name === type || !attributes.has(name)) return name === type;
    const key = `${name} ${type}`;
    if (!memo.has(key)) {
      memo.set(key, false);
      memo.set(key, attributes.get(name)!.some((e) => matches(type, e)));
    }
    return memo.get(key)!;
  };
  const matches = (type: string, e: Cil): boolean => typeof e === "string" ? isA(type, e) : e[0] === "and" ? e.slice(1).every((x) => matches(type, x)) :
    e[0] === "or" ? e.slice(1).some((x) => matches(type, x)) : e[0] === "not" ? !matches(type, e[1]) : e[0] === "all" || e.some((x) => matches(type, x));
  const allowed = (source: string, target: string, cls: string, perm: string) =>
    allows.some(([s, t, c, p]) => c === cls && p.includes(perm) && isA(source, s) && (t === "self" ? target === source : isA(target, t)));
  // property_info_parser: an exact name, else the longest prefix; [type, value type, enum values]
  const exact = new Map<string, string[]>(), prefixes: [string, string[]][] = [];
  for (const part of ["system/etc/selinux/plat", "system_ext/etc/selinux/system_ext", "product/etc/selinux/product", "vendor/etc/selinux/vendor", "odm/etc/selinux/odm"]) {
    for (const line of read(`/${part}_property_contexts`)?.split("\n") ?? []) {
      const [key, context, match, ...type] = line.trim().split(/\s+/);
      if (!key || key.startsWith("#")) continue;
      const info = [context.split(":")[2], ...(match === "exact" || match === "prefix" ? type : [match, ...type]).filter(Boolean)];
      if (match === "exact") exact.set(key, info);
      else prefixes.push([key, info]);
    }
  }
  prefixes.sort(([a], [b]) => b.length - a.length);
  const infoOf = (key: string) => exact.get(key) ?? prefixes.find(([p]) => key.startsWith(p) || p === "*")?.[1] ?? ["default_prop"];
  // property_service.cpp CheckType
  const typed = ([, type = "string", ...values]: string[], value: string) => type === "string" || type === "bool" && /^(true|false|1|0)$/.test(value) ||
    type === "int" && /^-?\d+$/.test(value) || type === "uint" && /^\d+$/.test(value) || type === "double" && value !== "" && !isNaN(Number(value)) ||
    type === "size" && /^\d+[gkm]$/.test(value) || type === "enum" && values.includes(value);

  // LoadProperties: a later file overrides an earlier one; a vendor file sets only what vendor_init may
  const props = new Map<string, string>(), property = (key: string) => props.get(key) ?? "";
  const load = (path: string) => {
    for (const line of read(path)?.split("\n") ?? []) {
      const eq = line.indexOf("="), key = line.slice(0, eq).trim(), value = line.slice(eq + 1).trim();
      if (eq < 0 || key.startsWith("#")) continue;
      const info = infoOf(key);
      if (allowed(/^\/(vendor|odm)/.test(path) ? "vendor_init" : "init", info[0], "property_service", "set") && typed(info, value)) props.set(key, value);
      else console.log(`  init refuses ${key}=${value} from ${path}`);
    }
  };
  // the boot ramdisk's build.prop, loaded first, names the boot image's build, which no app may read
  for (const path of ["/system/build.prop", "/system_ext/etc/build.prop", "/system_dlkm/etc/build.prop", "/vendor/default.prop", "/vendor/build.prop",
    "/vendor_dlkm/etc/build.prop", "/odm_dlkm/etc/build.prop", "/odm/etc/build.prop", "/product/etc/build.prop"]) load(path);
  // property_initialize_ro_product_props
  const order = property("ro.product.property_source_order") || "product,odm,vendor,system_ext,system";
  if (order.split(",").some((s) => !["odm", "product", "system_ext", "system", "vendor"].includes(s))) throw new Error(`ro.product.property_source_order ${order}`);
  for (const field of ["brand", "device", "manufacturer", "model", "name"]) {
    const source = order.split(",").map((s) => property(`ro.product.${s}.${field}`)).find(Boolean);
    if (!property(`ro.product.${field}`) && source) props.set(`ro.product.${field}`, source);
  }
  // property_initialize_build_id would derive a missing id from the vbmeta digest the bootloader passes
  if (!property("ro.build.id") || property("ro.build.legacy.id") || property("ro.product.build.16k_page.enabled") === "true") throw new Error("the build id or fingerprint needs boot state");
  // property_derive_build_fingerprint
  if (!property("ro.build.fingerprint")) props.set("ro.build.fingerprint", `${property("ro.product.brand")}/${property("ro.product.name")}/${property("ro.product.device")}:` +
    `${property("ro.build.version.release_or_codename")}/${property("ro.build.id")}/${property("ro.build.version.incremental")}:${property("ro.build.type")}/${property("ro.build.tags")}`);
  // property_initialize_ro_vendor_api_level: the lower of the board's level and the vendor API level
  // of the product's first SDK (an SDK before 35 is its own, 35 is 202404)
  if (!property("ro.vendor.api_level")) {
    const board = property("ro.board.first_api_level") ? Number(property("ro.board.api_level") || property("ro.board.first_api_level")) : Infinity;
    const first = Number(property("ro.product.first_api_level") || property("ro.build.version.sdk"));
    if (first > 35) throw new Error(`no vendor API level for SDK ${first}`);
    props.set("ro.vendor.api_level", String(Math.min(first < 35 ? first : 202404, board)));
  }
  // export_kernel_boot_props: the bootloader names its own version, which android-info.txt requires
  // of the bootloader the image flashes; init.rc imports /vendor/etc/init/hw/init.${ro.hardware}.rc,
  // which the vendor provides for one hardware name. The baseband, boot mode, revision and serial
  // the bootloader passes are its own, so a reader gets its default.
  props.set("ro.bootloader", /^require version-bootloader=(.+)$/m.exec(await Bun.file(`${cache}/android-info.txt`).text())![1].trim());
  const initRc = read("/system/etc/init/hw/init.rc")!;
  if (!initRc.includes("import /vendor/etc/init/hw/init.${ro.hardware}.rc")) throw new Error("init.rc no longer names ro.hardware's rc");
  const hardware = debug("ls -p /etc/init/hw", "vendor").stdout.toString().split("\n").flatMap((line) => /^\/\d+\/\d+\/\d+\/\d+\/init\.([^./]+)\.rc\//.exec(line)?.[1] ?? []);
  if (hardware.length !== 1) throw new Error(`vendor rc files name hardware ${hardware}`);
  props.set("ro.hardware", hardware[0]);

  const platform = /^sdk (\d+)$/m.exec(await Bun.file(`${OUT}/build.txt`).text())![1];
  if (property("ro.build.version.sdk") !== platform) throw new Error(`the image is API ${property("ro.build.version.sdk")}, the platform API ${platform}`);
  const readable = new Map<string, boolean>();
  const appReads = (key: string) => {
    const type = infoOf(key)[0];
    if (!readable.has(type)) readable.set(type, allowed("untrusted_app", type, "file", "read"));
    return readable.get(type)!;
  };
  const properties = [...props].filter(([key, value]) => identity(key) && buildFixed(key, value) && appReads(key)).sort(([a], [b]) => a < b ? -1 : 1);

  // the kernel's banner, "Linux version <release> (<builder>) (<toolchain>) <version>", and the
  // names init.rc sets
  const boot = new Uint8Array(await Bun.file(`${cache}/boot.img`).arrayBuffer()), view = new DataView(boot.buffer);
  if (view.getUint32(40, true) < 3) throw new Error("boot image header before v3");
  let kernel = boot.subarray(4096, 4096 + view.getUint32(8, true));
  if (view.getUint32(4096, true) === 0x184c2102) kernel = new Uint8Array(await Bun.$`lz4 -dc < ${new Response(kernel)}`.arrayBuffer());
  const banner = /Linux version (\S+) \(.*\) (#\d+ [^\n\0]*)/.exec(new TextDecoder("latin1").decode(kernel))!;
  const uname = { sysname: "Linux", nodename: /^\s*hostname (\S+)/m.exec(initRc)![1], release: banner[1], version: banner[2], domainname: /^\s*domainname (\S+)/m.exec(initRc)![1] };
  await writeProperties("src/shell/device-properties.ts", "DEVICE_PROPERTIES", properties,
    `// Generated by bun run gen-framework --identity: the identity of the phone whose factory image is\n// ${url}\n` +
    `// (sha256 ${sha256}),\n// as an app reads it (see recordIdentity), and its kernel's uname but for the machine.\n`,
    `export const UNAME = ${JSON.stringify(uname, null, 2).replace(/"(\w+)":/g, "$1:")};\n`);
}

/** The key character maps of the device's virtual keyboard and touchscreen, and the key codes each
 *  device reports having (InputDevice.hasKeys), which come from its key layout and its kernel's keys */
async function recordInputDevices() {
  const dir = (await Bun.$`mktemp -d`.text()).trim(), java = process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/javac` : "javac";
  const jar = `${androidPlatform(35)}/android.jar`;
  await Bun.$`${java} --release 17 -cp ${jar} -d ${dir} scripts/DumpInputDevices.java`.quiet();
  await Bun.$`${androidTool("d8")} --min-api 34 --lib ${jar} --output ${dir} ${dir}/DumpInputDevices.class`.quiet();
  sh("push", `${dir}/classes.dex`, "/data/local/tmp/webdroid-input.dex");
  const keys: Record<string, number[]> = {};
  for (const line of sh("shell", "CLASSPATH=/data/local/tmp/webdroid-input.dex app_process / DumpInputDevices").split("\n")) {
    const [name, codes = ""] = line.trim().split("\t");
    if (name === "Virtual" || name === "virtio_input_multi_touch_1") keys[name] = codes.split(" ").filter(Boolean).map(Number);
  }
  // full-line comments go; a '#' inside a character literal is the key's character
  const kcm = (file: string) => sh("shell", "cat", `/system/usr/keychars/${file}`).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).join("\n");
  await Bun.write("src/android/keychars.ts", `// Generated by bun run gen-framework: the reference device's key character maps (AOSP's\n` +
    `// /system/usr/keychars, Apache-2.0, comments removed) and the key codes InputDevice.hasKeys reports\n` +
    `// for its touchscreen and its virtual keyboard, whose negative id asks every device of the AVD.\n` +
    `export const KEY_CHARACTER_MAPS: Record<string, string> = {\n${["Virtual.kcm", "Generic.kcm"].map((f) => `  ${JSON.stringify(f)}: ${JSON.stringify(kcm(f))},`).join("\n")}\n};\n` +
    `export const DEVICE_KEYS: Record<string, number[]> = {\n${Object.entries(keys).map(([n, c]) => `  ${JSON.stringify(n)}: [${c.join(", ")}],`).join("\n")}\n};\n`);
  console.log(`  src/android/keychars.ts ${Object.keys(keys).length} devices`);
}

// --- verify: every id the framework's own R classes name must resolve in the paired table ---
const jarDexes = await loadJarDexes(JAR);
// the R classes are dex, but their <clinit> runs on java.* natives
console.log(`${JAR}: ${jarDexes.length} dex, ${rt.dexIndex.size} classes`);

const tableOf = async (apk: string) =>
  new Arsc(unzipSync(new Uint8Array(await Bun.file(apk).arrayBuffer()), { filter: (f) => f.name === "resources.arsc" })["resources.arsc"]);
const paired = await tableOf(RES);

/** every (name, id) pair the R$<type> classes in the framework dex declare */
async function rIds(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const name of rt.dexIndex.keys()) {
    if (!/^(android|com\/android\/internal)\/R\$/.test(name)) continue;
    const type = name.slice(name.indexOf("$") + 1);
    const info = rt.link(name);
    await rt.initClass(info);
    const ctor = info.ctor as Record<string, unknown>;
    const { dex, def } = info;
    if (!dex || !def) continue;
    for (const sf of def.staticFields) {
      const f = dex.field(sf.fieldIdx).name;
      const v = ctor[mangleStaticField(f)];
      // styleables are int[]; the scalar ids are what a table has to answer for
      if (typeof v === "number" && v >>> 24 === 0x01) out.set(`${type}/${f}`, v);
    }
  }
  return out;
}

const ids = await rIds();
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
