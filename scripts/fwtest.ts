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

if (gaps.length) {
  console.log(`\n${gaps.length} declared natives with no delegate, first 30:`);
  for (const g of gaps.slice(0, 30)) console.log("  " + g);
}
