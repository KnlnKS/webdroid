// Run AOSP's own bytecode against our delegates, headless.
//
//   bun run fwtest [prefix ...]      # default: the graphics and resource cuts
//
// The point is that a delegate is written because a real framework method asked for it, not
// because a list said so. Provenance withholds our native spec for the named prefixes, the
// real classes load from vendor/aosp/framework.jar, and whatever they reach that we do not
// answer for comes back as a ranked list.
//
// It reports two numbers per class: how many of the natives the dex declares we implement,
// and how many of those the exercise below actually reached. The first is coverage, the
// second is evidence.
import { unzipSync } from "fflate";
import { existsSync } from "node:fs";
import { BYTECODE } from "../src/jvm/provenance";

const CUTS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
BYTECODE.push(...(CUTS.length ? CUTS : [
  "android/graphics/Paint", "android/graphics/Canvas", "android/graphics/BaseCanvas",
  "android/graphics/BaseRecordingCanvas", "android/graphics/Matrix", "android/graphics/Path",
  "android/graphics/Typeface", "android/graphics/Bitmap",
]));

// imported AFTER the policy is set: rt.register consults it, so the specs never land
const { rt } = await import("../src/jvm/runtime");
const { DexFile } = await import("../src/jvm/dex");
const { ACC } = await import("../src/jvm/runtime");
const { descToName } = await import("../src/jvm/abi");
await import("../src/natives");

const JAR = "vendor/aosp/framework.jar";
if (!existsSync(JAR)) throw new Error(`no ${JAR} — run \`bun run gen-framework\` with the reference AVD booted`);
const zip = unzipSync(new Uint8Array(await Bun.file(JAR).arrayBuffer()), { filter: (f) => /^classes\d*\.dex$/.test(f.name) });
for (const n of Object.keys(zip).sort()) rt.loadDex(new DexFile(zip[n], n));
for (const n of [...rt.natives.keys()]) { try { rt.link(n); } catch { /* */ } }

console.log(`withheld ${BYTECODE.length} prefixes; ${rt.dexIndex.size} framework classes\n`);

// --- coverage: every native the dex declares under a cut, against what we registered ---
const declared = new Map<string, string[]>();
for (const name of rt.dexIndex.keys()) {
  if (!BYTECODE.some((p) => name.startsWith(p))) continue;
  const info = rt.link(name);
  const { dex, def } = info;
  if (!dex || !def) continue;
  for (const m of [...def.directMethods, ...def.virtualMethods]) {
    if (m.codeOff || !(m.flags & ACC.NATIVE)) continue;
    (declared.get(name) ?? declared.set(name, []).get(name)!).push(dex.method(m.methodIdx).name + dex.methodDesc(m.methodIdx));
  }
}
void descToName;

let have = 0, total = 0;
const gaps: string[] = [];
for (const [cls, sigs] of [...declared].sort()) {
  const impl = sigs.filter((s) => rt.jniFn(cls, s));
  have += impl.length; total += sigs.length;
  if (impl.length < sigs.length) for (const s of sigs) if (!rt.jniFn(cls, s)) gaps.push(`${cls}.${s}`);
  console.log(`  ${String(impl.length).padStart(3)}/${String(sigs.length).padEnd(3)} ${cls}`);
}
console.log(`\ncoverage ${have}/${total} declared natives (${((have / (total || 1)) * 100).toFixed(0)}%)`);

// --- evidence: run the real bytecode and see what it actually reaches ---
const reached: string[] = [];
rt.onMissing = (w) => { reached.push(w); };

// Text measurement goes through an OffscreenCanvas 2D context, which bun does not have.
// Say so rather than reporting a delegate failure for a missing DOM.
const HAS_DOM = typeof (globalThis as { document?: unknown }).document !== "undefined";

async function exercise(name: string, fn: () => Promise<void>, needsDom = false) {
  if (needsDom && !HAS_DOM) { console.log(`skip ${name}  (needs a browser: Canvas2D text metrics)`); return; }
  const before = reached.length;
  try {
    await fn();
    const missed = reached.slice(before);
    console.log(`${missed.length ? "MISS" : "ok  "} ${name}${missed.length ? "  " + missed.slice(0, 3).join(" ") : ""}`);
  } catch (e) {
    const msg = (e as { msg?: string })?.msg ?? String(e);
    console.log(`FAIL ${name}  ${msg.split("\n")[0].slice(0, 150)}`);
  }
}

const { newObj, vcall } = await import("../src/jvm/natives/jlang");
console.log("");

await exercise("new Paint()", async () => {
  const p = await newObj("android/graphics/Paint", "()V");
  await vcall(p, "setColor", "(I)V", -65536);
  const c = await vcall(p, "getColor", "()I");
  if (c !== -65536) throw new Error(`getColor returned ${c}`);
  await vcall(p, "setTextSize", "(F)V", 24);
  await vcall(p, "setAntiAlias", "(Z)V", 1);
});

await exercise("Paint.measureText", async () => {
  const p = await newObj("android/graphics/Paint", "()V");
  await vcall(p, "setTextSize", "(F)V", 24);
  const w = await vcall(p, "measureText", "(Ljava/lang/String;)F", "hello");
  if (typeof w !== "number" || !(w > 0)) throw new Error(`measureText returned ${w}`);
}, true);

await exercise("new Matrix()", async () => {
  const m = await newObj("android/graphics/Matrix", "()V");
  await vcall(m, "setTranslate", "(FF)V", 3, 4);
  const id = await vcall(m, "isIdentity", "()Z");
  if (id) throw new Error("translated matrix reports identity");
});

await exercise("new Path()", async () => {
  const p = await newObj("android/graphics/Path", "()V");
  await vcall(p, "moveTo", "(FF)V", 0, 0);
  await vcall(p, "lineTo", "(FF)V", 10, 10);
  await vcall(p, "close", "()V");
});

// The resource delegates are exercised against the real framework table rather than through
// bytecode: constructing an AOSP Resources needs ResourcesImpl, a Configuration and a
// DisplayMetrics, none of which says anything more about whether the lookups are right.
if (existsSync("vendor/aosp/framework-res.apk")) {
  const { Arsc } = await import("../src/android/arsc");
  const { Resources, setFramework } = await import("../src/android/res");
  const { handle } = await import("../src/android/delegates");
  const { centralDir, entryBytes } = await import("../src/jvm/natives/jzip");
  // read the package lazily, as framework.ts does: the arsc up front, every other entry on
  // demand — the layout exercise below needs res/ to be reachable, not just the table
  const apkBytes = new Uint8Array(await Bun.file("vendor/aosp/framework-res.apk").arrayBuffer());
  const dir = centralDir(apkBytes);
  const files = (path: string) => { const e = dir.get(path); return e ? entryBytes(apkBytes, e) : null; };
  const arsc = new Arsc(files("resources.arsc")!, files);
  setFramework(arsc);
  const res = new Resources(arsc, {});
  const am = handle(res);
  const jni = (cls: string, sig: string) => {
    const fn = rt.jniFn(cls, sig);
    if (!fn) throw new Error(`no delegate for ${cls}.${sig}`);
    return fn as (...x: unknown[]) => unknown;
  };
  const call = (sig: string, ...a: unknown[]) => jni("android/content/res/AssetManager", sig)(am, ...a);

  await exercise("AssetManager.nativeGetResourceIdentifier", async () => {
    const id = call("nativeGetResourceIdentifier(JLjava/lang/String;Ljava/lang/String;Ljava/lang/String;)I", "ok", "string", "android") as number;
    if ((id >>> 24) !== 0x01) throw new Error(`android:string/ok resolved to 0x${(id >>> 0).toString(16)}`);
    const name = call("nativeGetResourceName(JI)Ljava/lang/String;", id);
    if (name !== "android:string/ok") throw new Error(`name round-tripped as ${name}`);
  });

  await exercise("AssetManager.nativeGetResourceValue", async () => {
    const id = call("nativeGetResourceIdentifier(JLjava/lang/String;Ljava/lang/String;Ljava/lang/String;)I", "ok", "string", "android") as number;
    const tv = { type: 0, data: 0, resourceId: 0, density: 0, string: null as unknown, assetCookie: 0, changingConfigurations: 0 };
    const block = call("nativeGetResourceValue(JISLandroid/util/TypedValue;Z)I", id, 0, tv, 1);
    if (block !== 0 || tv.string !== "OK") throw new Error(`block ${block}, string ${JSON.stringify(tv.string)}`);
  });

  await exercise("AssetManager.nativeApplyStyle (obtainStyledAttributes)", async () => {
    // com.android.internal.R.styleable.View's first entry is android:id; asking a real theme
    // for the View styleable is what every widget constructor does
    const theme = call("nativeThemeCreate(J)J") as bigint;
    const styleId = call("nativeGetResourceIdentifier(JLjava/lang/String;Ljava/lang/String;Ljava/lang/String;)I", "Theme.Material.Light", "style", "android") as number;
    if (!styleId) throw new Error("no android:style/Theme.Material.Light");
    call("nativeThemeApplyStyle(JJIZ)V", theme, styleId, 1);
    const attrs = Int32Array.of(
      call("nativeGetResourceIdentifier(JLjava/lang/String;Ljava/lang/String;Ljava/lang/String;)I", "textColorPrimary", "attr", "android") as number,
      call("nativeGetResourceIdentifier(JLjava/lang/String;Ljava/lang/String;Ljava/lang/String;)I", "colorBackground", "attr", "android") as number,
    );
    const values = new Int32Array(attrs.length * 7);
    const indices = new Int32Array(attrs.length + 1);
    call("nativeApplyStyle(JJIIJ[IJJ)V", theme, 0, 0, 0n, attrs, handle(values), handle(indices));
    if (indices[0] === 0) throw new Error("the theme resolved none of the two attributes");
  });

  await exercise("AssetManager.nativeOpenXmlAsset (XmlBlock walk)", async () => {
    const id = call("nativeGetResourceIdentifier(JLjava/lang/String;Ljava/lang/String;Ljava/lang/String;)I", "alert_dialog", "layout", "android") as number;
    if (!id) throw new Error("no android:layout/alert_dialog");
    const tv = { type: 0, data: 0, resourceId: 0, density: 0, string: null as unknown, assetCookie: 0, changingConfigurations: 0 };
    call("nativeGetResourceValue(JISLandroid/util/TypedValue;Z)I", id, 0, tv, 1);
    // Resources.getLayout takes the TYPE_STRING branch or throws NotFoundException
    if (tv.type !== 3) throw new Error(`layout resolved as type ${tv.type}, not TYPE_STRING`);

    const blk = call("nativeOpenXmlAsset(JILjava/lang/String;)J", tv.assetCookie, tv.string) as bigint;
    const xb = (sig: string, ...a: unknown[]) => jni("android/content/res/XmlBlock", sig)(blk, ...a);
    const pool = xb("nativeGetStringBlock(J)J") as bigint;
    const str = (i: number) => jni("android/content/res/StringBlock", "nativeGetString(JI)Ljava/lang/String;")(pool, i);
    const st = xb("nativeCreateParseState(JI)J", id) as bigint;
    const sx = (sig: string, ...a: unknown[]) => jni("android/content/res/XmlBlock", sig)(st, ...a);

    const tags: string[] = [];
    let attrs = 0, depth = 0, ev = 0;
    while ((ev = sx("nativeNext(J)I") as number) !== 1) {
      if (ev === 2) { tags.push(str(sx("nativeGetName(J)I") as number) as string); attrs += sx("nativeGetAttributeCount(J)I") as number; depth++; }
      if (ev === 3) depth--;
    }
    if (depth !== 0) throw new Error(`walk ended at depth ${depth}`);

    // the tree parse of the same bytes is an independent count: it never sees a pool index
    const { parseAXML } = await import("../src/android/axml");
    const bytes = res.fileOf(id)!.bytes;
    const want: string[] = [];
    let wantAttrs = 0;
    const walk = (n: { name: string; attrs: unknown[]; children: never[] }) => {
      want.push(n.name); wantAttrs += n.attrs.length;
      for (const c of n.children) walk(c);
    };
    walk(parseAXML(bytes) as never);
    if (tags.join(",") !== want.join(",")) throw new Error(`${tags.length} tags vs the tree's ${want.length}`);
    if (attrs !== wantAttrs) throw new Error(`${attrs} attributes vs the tree's ${wantAttrs}`);
    if (!(pool > 0n) || !str(0)) throw new Error("the block's string pool is empty");
  });
}

if (gaps.length) {
  console.log(`\n${gaps.length} declared natives with no delegate, first 30:`);
  for (const g of gaps.slice(0, 30)) console.log("  " + g);
}
