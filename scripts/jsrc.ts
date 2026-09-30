// Dump compiled JS for a class: bun scripts/jsrc.ts <apk> <class> [lineFrom lineTo]
import { loadDexes } from "./lib";
import { rt } from "../src/jvm/runtime";
import "../src/jvm/natives/jlang";
import "../src/jvm/natives/jutil";
import "../src/jvm/natives/jrandom";
import "../src/jvm/natives/jvalues";
import "../src/jvm/natives/jtimer";
import "../src/jvm/natives/jstream";
import "../src/jvm/natives/jio";
import "../src/jvm/natives/jblockingqueue";
import "../src/jvm/natives/jsync";
import { compileClassSource } from "../src/jvm/compiler";

const [apk, cls, from, to] = process.argv.slice(2);
await loadDexes(apk);
const info = rt.link(cls);
const src = compileClassSource(rt as any, info.dex!, info as any);
const lines = src.split("\n");
const a = from ? Number(from) : 1, b = to ? Number(to) : lines.length;
for (let i = a; i <= Math.min(b, lines.length); i++) console.log(String(i).padStart(4), lines[i - 1]);
