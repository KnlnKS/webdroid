// The identity of a production phone as an app reads it, and its kernel's uname but for the machine
// (src/shell/device-properties.ts), from the phone's factory image: the build.prop files of its
// partitions, merged and derived as init does (property_service.cpp PropertyLoadBootDefaults), what
// init takes from the bootloader where the image says what that is, and the kernel's banner. An app
// reads what the image's SELinux policy (its CIL, as init compiles it) lets untrusted_app read.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import { constObject, writeGenerated } from "./lib.ts";

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
export function buildFixed(name: string, value: string): boolean {
  return value !== "" && /^(ro|dalvik\.vm|build\.version\.extensions)\./.test(name) &&
    !/^ro\.(boot|kernel|hardware|surface_flinger|egl|config|adb)\.|^ro\.(opengles|cpuvulkan)\.version$|^ro\.hwui\.use_vulkan$|^ro\.zygote|^ro\.sf\.lcd_density$|^ro\.odm\.build\.media_performance_class$/.test(name) &&
    !/^ro\.(\w+\.)?product\.cpu\.abi/.test(name);
}
/** Which product this is: its build, partitions' builds, product names, board, SoC, hardware and
 *  bootloader. These come from the identity image (recordIdentity) and the rest from the reference
 *  AVD (gen-framework's recordProperties), whose framework is the code that runs: its ART
 *  configuration, SDK extension levels and platform settings stay, and so do its heap sizes: the heap
 *  is this device's, not the phone's. recordIdentity checks that both name one API level. */
export function identity(name: string): boolean {
  return /^ro\.(build|product|soc|board|bootimage|(system|system_ext|system_dlkm|vendor|vendor_dlkm|odm|odm_dlkm|product)\.build)\./.test(name) ||
    /^ro\.(hardware|bootloader|baseband|bootmode|revision|serialno|vendor\.api_level)$/.test(name);
}
/** a properties file gen-framework generates */
export const writeProperties = (file: string, name: string, properties: (readonly [string, string])[], header: string, tail = "") =>
  writeGenerated(file, header, constObject(name, "Record<string, string>", properties.map(([n, v]) => [JSON.stringify(n), JSON.stringify(v)])) + tail,
    `${properties.length} properties`);

/** a file of the device's tree, from the partition mounted there; null when there is none */
type Read = (path: string) => string | null;

/** the factory image at `url`, downloaded and checked against the digest its name carries, with its
 *  partitions' ext4 images extracted */
async function factoryImage(url: string) {
  const name = url.slice(url.lastIndexOf("/") + 1), cache = `${process.env.HOME}/.cache/webdroid/${name.replace(/\.zip$/, "")}`, zip = `${cache}/${name}`;
  mkdirSync(cache, { recursive: true });
  if (!existsSync(zip)) {
    execFileSync("curl", ["-fL", "-o", `${zip}.part`, url], { stdio: "inherit" });
    renameSync(`${zip}.part`, zip);
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(zip)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  // a factory image's name carries its digest's first 8 digits
  if (!sha256.startsWith(/-([0-9a-f]{8})\.zip$/.exec(name)![1])) throw new Error(`${name} has sha256 ${sha256}`);
  const images = `${cache}/image.zip`;
  if (!existsSync(images)) {
    const fd = openSync(images, "w");
    try { execFileSync("unzip", ["-p", zip, "*/image-*.zip"], { stdio: ["ignore", fd, "inherit"] }); } finally { closeSync(fd); }
  }
  const entries = new Set(execFileSync("unzip", ["-Z1", images], { encoding: "utf8", maxBuffer: 1 << 30 }).split("\n"));
  for (const entry of ["android-info.txt", "boot.img", ...["system", "system_ext", "product", "vendor", "system_dlkm", "vendor_dlkm", "odm", "odm_dlkm"].map((p) => `${p}.img`)]) {
    if (entries.has(entry) && !existsSync(`${cache}/${entry}`)) execFileSync("unzip", ["-o", "-d", cache, images, entry], { stdio: "pipe" });
  }
  const debugfs = [...process.env.PATH!.split(":"), "/opt/homebrew/opt/e2fsprogs/sbin", "/usr/local/opt/e2fsprogs/sbin", "/sbin"].map((dir) => `${dir}/debugfs`).find(existsSync);
  if (!debugfs) throw new Error("debugfs reads the image's ext4 partitions: brew install e2fsprogs");
  const debug = (command: string, image: string) => spawnSync(debugfs, ["-R", command, `${cache}/${image}.img`], { maxBuffer: 1 << 30 });
  const read: Read = (path) => {
    const [, part, rest] = /^\/(\w+)(\/.*)$/.exec(path)!;
    // odm and odm_dlkm are vendor's directories on a device without those partitions
    const [image, inner] = existsSync(`${cache}/${part}.img`) ? [part, part === "system" ? path : rest] : part.startsWith("odm") ? ["vendor", path] : [];
    if (!image) return null;
    const r = debug(`cat ${inner}`, image);
    return r.stderr.toString().includes("not found") ? null : r.stdout.toString();
  };
  return { cache, sha256, read, debug };
}

/** the policy init compiles (the platform's, system_ext's and product's with their mappings to the
 *  vendor's version, the vendor's and the odm's), as whether `source` may `perm` a `target` of `cls` */
function sepolicy(read: Read): (source: string, target: string, cls: string, perm: string) => boolean {
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
  return (source, target, cls, perm) =>
    allows.some(([s, t, c, p]) => c === cls && p.includes(perm) && isA(source, s) && (t === "self" ? target === source : isA(target, t)));
}

/** property_info_parser over the partitions' property_contexts: a property's [type, value type,
 *  enum values], by an exact name, else the longest prefix */
function propertyInfo(read: Read): (key: string) => string[] {
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
  return (key) => exact.get(key) ?? prefixes.find(([p]) => key.startsWith(p) || p === "*")?.[1] ?? ["default_prop"];
}

/** LoadProperties over the partitions' build.prop files and init's derivations from them: a later
 *  file overrides an earlier one, a vendor file sets only what vendor_init may, and each value is of
 *  its property's type (property_service.cpp CheckType) */
function loadBuildProps(read: Read, allowed: ReturnType<typeof sepolicy>, infoOf: (key: string) => string[]): Map<string, string> {
  const typed = ([, type = "string", ...values]: string[], value: string) => type === "string" || type === "bool" && /^(true|false|1|0)$/.test(value) ||
    type === "int" && /^-?\d+$/.test(value) || type === "uint" && /^\d+$/.test(value) || type === "double" && value !== "" && !isNaN(Number(value)) ||
    type === "size" && /^\d+[gkm]$/.test(value) || type === "enum" && values.includes(value);
  const props = new Map<string, string>(), property = (key: string) => props.get(key) ?? "";
  // the boot ramdisk's build.prop, loaded first, names the boot image's build, which no app may read
  for (const path of ["/system/build.prop", "/system_ext/etc/build.prop", "/system_dlkm/etc/build.prop", "/vendor/default.prop", "/vendor/build.prop",
    "/vendor_dlkm/etc/build.prop", "/odm_dlkm/etc/build.prop", "/odm/etc/build.prop", "/product/etc/build.prop"]) {
    for (const line of read(path)?.split("\n") ?? []) {
      const eq = line.indexOf("="), key = line.slice(0, eq).trim(), value = line.slice(eq + 1).trim();
      if (eq < 0 || key.startsWith("#")) continue;
      const info = infoOf(key);
      if (allowed(/^\/(vendor|odm)/.test(path) ? "vendor_init" : "init", info[0], "property_service", "set") && typed(info, value)) props.set(key, value);
      else console.log(`  init refuses ${key}=${value} from ${path}`);
    }
  }
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
  return props;
}

/** the identity properties and uname of the phone whose factory image is at `url`, which must be of
 *  the platform's API level `sdk` */
export async function recordIdentity(url: string, sdk: string): Promise<void> {
  const { cache, sha256, read, debug } = await factoryImage(url);
  const allowed = sepolicy(read), infoOf = propertyInfo(read), props = loadBuildProps(read, allowed, infoOf);
  // export_kernel_boot_props: the bootloader names its own version, which android-info.txt requires
  // of the bootloader the image flashes; init.rc imports /vendor/etc/init/hw/init.${ro.hardware}.rc,
  // which the vendor provides for one hardware name. The baseband, boot mode, revision and serial
  // the bootloader passes are its own, so a reader gets its default.
  props.set("ro.bootloader", /^require version-bootloader=(.+)$/m.exec(readFileSync(`${cache}/android-info.txt`, "utf8"))![1].trim());
  const initRc = read("/system/etc/init/hw/init.rc")!;
  if (!initRc.includes("import /vendor/etc/init/hw/init.${ro.hardware}.rc")) throw new Error("init.rc no longer names ro.hardware's rc");
  const hardware = debug("ls -p /etc/init/hw", "vendor").stdout.toString().split("\n").flatMap((line) => /^\/\d+\/\d+\/\d+\/\d+\/init\.([^./]+)\.rc\//.exec(line)?.[1] ?? []);
  if (hardware.length !== 1) throw new Error(`vendor rc files name hardware ${hardware}`);
  props.set("ro.hardware", hardware[0]);

  if (props.get("ro.build.version.sdk") !== sdk) throw new Error(`the image is API ${props.get("ro.build.version.sdk")}, the platform API ${sdk}`);
  const readable = new Map<string, boolean>();
  const appReads = (key: string) => {
    const type = infoOf(key)[0];
    if (!readable.has(type)) readable.set(type, allowed("untrusted_app", type, "file", "read"));
    return readable.get(type)!;
  };
  const properties = [...props].filter(([key, value]) => identity(key) && buildFixed(key, value) && appReads(key)).sort(([a], [b]) => a < b ? -1 : 1);

  // the kernel's banner, "Linux version <release> (<builder>) (<toolchain>) <version>", and the
  // names init.rc sets
  const boot = new Uint8Array(readFileSync(`${cache}/boot.img`)), view = new DataView(boot.buffer);
  if (view.getUint32(40, true) < 3) throw new Error("boot image header before v3");
  let kernel = boot.subarray(4096, 4096 + view.getUint32(8, true));
  if (view.getUint32(4096, true) === 0x184c2102) kernel = new Uint8Array(execFileSync("lz4", ["-dc"], { input: kernel, maxBuffer: 1 << 30 }));
  const banner = /Linux version (\S+) \(.*\) (#\d+ [^\n\0]*)/.exec(new TextDecoder("latin1").decode(kernel))!;
  const uname = { sysname: "Linux", nodename: /^\s*hostname (\S+)/m.exec(initRc)![1], release: banner[1], version: banner[2], domainname: /^\s*domainname (\S+)/m.exec(initRc)![1] };
  writeProperties("src/shell/device-properties.ts", "DEVICE_PROPERTIES", properties,
    ` --identity: the identity of the phone whose factory image is\n${url}\n(sha256 ${sha256}),\nas an app reads it (see recordIdentity), and its kernel's uname but for the machine.`,
    `export const UNAME = ${JSON.stringify(uname, null, 2).replace(/"(\w+)":/g, "$1:")};\n`);
}
