// Table for candidate "byte mover" / boundary files: LOC, coupling, registered natives, runtime imports.
import { readFileSync } from "fs";
const j = JSON.parse(readFileSync(import.meta.dirname + "/out/ast.json", "utf8"));
const E = j.entries as any[];
const g = (c: any, ...ks: string[]) => ks.reduce((a, k) => a + (c[k] ?? 0), 0);
const groups: Record<string, string[]> = {
  "bitmap/pixels": ["android/bitmap.ts", "android/bitmap-raster.ts", "android/decode.ts", "android/heif.ts", "android/animatedimage.ts", "android/ninepatch.ts", "native/bitmap.ts"],
  "parcel/binder": ["android/parcel.ts", "android/binder.ts", "android/intentipc.ts", "android/cursorwindow.ts"],
  "zip/inflate": ["jvm/natives/jzip.ts", "native/zlib.ts"],
  "crypto/tls": ["jvm/natives/ciphers.ts", "jvm/natives/digest.ts", "jvm/natives/conscrypt.ts", "jvm/natives/conscrypt-x509.ts", "jvm/natives/der.ts", "jvm/natives/x509.ts", "jvm/natives/pkey.ts", "android/keystore.ts"],
  "fs/io": ["native/fs.ts", "native/fd.ts", "jvm/natives/jio.ts", "jvm/natives/jnio.ts", "android/storage.ts", "shell/vfs.ts", "shell/hostfs.ts"],
  "regex/text": ["jvm/natives/jregex.ts", "jvm/natives/jstring.ts", "jvm/natives/jchars.ts", "jvm/natives/charset.ts", "android/text.ts", "android/minikin.ts", "android/hyphenator.ts"],
  "sql": ["android/sqlite.ts"],
  "graphics/skia-like": ["android/skia.ts", "android/harfbuzz.ts", "android/sfnt.ts", "android/path.ts", "android/matrix.ts", "android/hairline.ts", "android/region.ts", "android/maskfilter.ts", "android/patheffect.ts", "android/canvas.ts", "android/canvas-draw.ts", "android/recording.ts", "android/rendernode.ts", "android/paint.ts", "android/fonts.ts", "android/shaping.ts", "android/gl.ts", "native/gles3.ts"],
  "arm/a64 core+host": ["native/cpu.ts", "native/core.ts", "native/mem.ts", "native/elf.ts", "native/dl.ts", "native/libc.ts", "native/bionic.ts", "native/loader.ts", "native/host.ts", "native/pthread.ts", "native/net.ts", "native/poll.ts"],
};
for (const [g1, fs] of Object.entries(groups)) {
  let loc = 0, score = 0, reg = 0, pure = 0, rtImp = 0;
  const rows: string[] = [];
  for (const f of fs) {
    const k = "src/" + f, v = j.perFile[k]; if (!v) { rows.push(f + "?"); continue; }
    const c = v.c;
    const s = g(c, "fieldSelfR", "fieldSelfW", "fieldOtherR", "fieldOtherW", "dollarProp", "dynNameAccessR", "dynNameAccessW", "declaredFieldHelper", "anyAccessR", "anyAccessW", "call_vcall", "call_vcallOn", "call_scall", "call_newObj", "call_callOn", "call_staticField", "instanceofJava", "identityJavaTyped", "dotI", "dotConstructor", "jarray", "dotT");
    const r = E.filter((e) => e.file === k).length;
    const src = readFileSync(import.meta.dirname + "/../../../" + k, "utf8");
    const imp = /from "\.\.\/jvm\/(runtime|natives\/jentry)"|from "\.\/runtime"/.test(src);
    loc += v.loc; score += s; reg += r; if (imp) rtImp++;
    rows.push(`${f}[${v.loc}/${s}/${r}${imp ? "/rt" : ""}]`);
  }
  console.log(`${g1}: loc=${loc} coupling=${score} natives=${reg} filesImportingRuntime=${rtImp}/${fs.length}\n   ${rows.join(" ")}`);
}
