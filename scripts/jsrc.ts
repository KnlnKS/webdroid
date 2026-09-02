// Dump compiled JS for a class: bun scripts/jsrc.ts <apk> <class> [lineFrom lineTo]
import { unzipSync } from "fflate";
import { DexFile } from "../src/jvm/dex";
import { rt } from "../src/jvm/runtime";
import "../src/jvm/natives/jlang";
import "../src/jvm/natives/jutil";
import "../src/jvm/natives/jio";
import "../src/jvm/natives/jconc";
import { compileClassSource } from "../src/jvm/compiler";

const [apk, cls, from, to] = process.argv.slice(2);
const zip = unzipSync(new Uint8Array(await Bun.file(apk).arrayBuffer()), { filter: (f) => /classes\d*\.dex$/.test(f.name) });
for (const [name, bytes] of Object.entries(zip)) rt.loadDex(new DexFile(bytes, name));
const info = rt.link(cls);
const src = compileClassSource(rt as any, info.dex!, info as any);
const lines = src.split("\n");
const a = from ? Number(from) : 1, b = to ? Number(to) : lines.length;
for (let i = a; i <= Math.min(b, lines.length); i++) console.log(String(i).padStart(4), lines[i - 1]);
