// Pull the real android: framework off the reference device and prove the two halves match.
//
//   bun run gen-framework            # pull from a connected device/emulator, then verify
//   bun run gen-framework --verify   # verify what is already in vendor/aosp
//   bun run gen-framework --charsets # record only the device's single-byte charsets
//   bun run gen-framework --input    # record only the device's key character maps and key sets
//   bun run gen-framework --settings # record only the device's settings tables
//   bun run gen-framework --properties # record only the device's system properties and uname
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
import { PLATFORM_JARS } from "../src/jvm/bootclasspath";
import { loadPlatformJar } from "../src/android/framework";
import { SYSTEM_PACKAGES } from "../src/shell/system-packages";
import { Arsc } from "../src/android/arsc";
import { androidPlatform, androidTool } from "./android-sdk";

const OUT = "vendor/aosp";
const JAR = `${OUT}/framework.jar`, RES = `${OUT}/framework-res.apk`;
const sh = (...args: string[]) => {
  const r = Bun.spawnSync([androidTool("adb"), ...args], { stderr: "pipe", stdout: "pipe" });
  if (r.exitCode !== 0) throw new Error(`adb ${args.join(" ")} failed:\n${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
};

if (process.argv.includes("--charsets")) { await recordCharsets(); process.exit(0); }
if (process.argv.includes("--input")) { await recordInputDevices(); process.exit(0); }
if (process.argv.includes("--settings")) { await recordSettings(); process.exit(0); }
if (process.argv.includes("--properties")) { await recordProperties(); process.exit(0); }
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
    `/** the ICU and time zone files, fonts, hyphenation patterns and bionic's libraries, by device path (mirrored under vendor/aosp), with their sizes */\n` +
    `export const PLATFORM_DATA: Record<string, number> = ${JSON.stringify(data)};\n`);
  // its own process: it boots the class path just written, which the verification below loads apart
  if (Bun.spawnSync(["bun", "scripts/gen-framework.ts", "--settings"], { stdout: "inherit", stderr: "inherit" }).exitCode) throw new Error("recording settings failed");
}

for (const f of [JAR, RES]) if (!existsSync(f)) throw new Error(`missing ${f} — run \`bun run gen-framework\` with the reference AVD booted`);

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

/** The system properties an app process reads on the reference device, and its kernel's uname
 *  (src/shell/device-properties.ts). An app sees the property areas whose SELinux context the policy
 *  lets untrusted_app read (selinuxfs computes each decision, which needs root). Of those, only the
 *  read-only properties the build fixes stay; dropped are:
 *  - mutable properties: daemons' and services' runtime state (init.svc.*, sys.*, gsm.*, dev.mnt.*),
 *    debug switches and server-pushed flags, none of which this device's services set;
 *  - ro.boot.*, ro.kernel.* and ro.adb.*: the emulator's launch command line, qemu flags and adbd's setup;
 *  - the emulator's HAL, GPU and display selection (ro.hardware.*, ro.surface_flinger.*, the GLES and
 *    Vulkan versions): this device draws through the browser;
 *  - ro.config.*'s media names, which name files this device does not have;
 *  - the ABI lists and ro.zygote, which src/shell/properties.ts derives from what the native tier runs;
 *  - empty values, which every reader takes as unset.
 *  ART's configuration (dalvik.vm.*) and the SDK extension levels are mutable in name only: init sets
 *  them from the build, so they stay. */
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
  const kept = (name: string) => /^(ro|dalvik\.vm|build\.version\.extensions)\./.test(name) &&
    !/^ro\.(boot|kernel|hardware|surface_flinger|config|adb)\.|^ro\.(opengles|cpuvulkan)\.version$|^ro\.hwui\.use_vulkan$|^ro\.zygote/.test(name) &&
    !/^ro\.(\w+\.)?product\.cpu\.abi/.test(name);
  const properties = parse(sh("shell", "getprop")).filter(([name, value]) => value && readable.has(contexts.get(name)!) && kept(name));
  const uname = Object.fromEntries(([["sysname", "s"], ["nodename", "n"], ["release", "r"], ["version", "v"]] as const)
    .map(([field, flag]) => [field, sh("shell", "uname", `-${flag}`)]));
  uname.domainname = sh("shell", "cat", "/proc/sys/kernel/domainname");
  await Bun.write("src/shell/device-properties.ts", `// Generated by bun run gen-framework: the reference device's system properties as an app reads\n` +
    `// them, those its build fixes (see recordProperties), and its kernel's uname but for the machine.\n` +
    `export const DEVICE_PROPERTIES: Record<string, string> = {\n${properties.map(([n, v]) => `  ${JSON.stringify(n)}: ${JSON.stringify(v)},`).join("\n")}\n};\n` +
    `export const UNAME = ${JSON.stringify(uname, null, 2).replace(/"(\w+)":/g, "$1:")};\n`);
  console.log(`  src/shell/device-properties.ts ${properties.length} properties`);
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
