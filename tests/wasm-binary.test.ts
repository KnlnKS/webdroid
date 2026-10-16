import { expect, test } from "bun:test";
import { ModuleBuilder, T } from "../src/wasm/compiler/wasmbin.ts";
import { Code, OP } from "../src/wasm/compiler/code.ts";

test("Wasm imports retain Unicode and long module names across repeated builds", () => {
  const mb = new ModuleBuilder(), signature = mb.addFuncType([], []), expected: WebAssembly.ModuleImportDescriptor[] = [];
  const utf8 = (s: string) => new TextDecoder().decode(new TextEncoder().encode(s));
  for (const mod of ["host", "共有😀", "prefix共有😀", "x".repeat(130), "prefix\ud800", ""]) {
    for (const name of ["call", "λ", "\udc00"]) {
      mb.importFunc(mod, name, signature);
      expected.push({ module: utf8(mod), name: utf8(name), kind: "function" });
    }
  }
  const bytes = mb.build();
  expect(WebAssembly.Module.imports(new WebAssembly.Module(bytes as BufferSource)).map(({ module, name, kind }) => ({ module, name, kind }))).toEqual(expected);
  mb.importFunc("later", "entry", signature);
  expected.push({ module: "later", name: "entry", kind: "function" });
  expect(WebAssembly.Module.imports(new WebAssembly.Module(mb.build() as BufferSource)).map(({ module, name, kind }) => ({ module, name, kind }))).toEqual(expected);
});

test("Wasm import compaction preserves calls, table entries and function references", () => {
  const mb = new ModuleBuilder(), type = mb.addFuncType([], [T.i32]);
  for (let i = 0; i < 200; i++) mb.importFunc("host", "f" + i,
    i === 95 ? { params: [], results: [T.i64] } : i === 149 ? { params: [T.f64], results: [] } : type);
  const entry = mb.reserveFunc(type, "entry"), target = mb.addFunc(type, new Code(0).i32(3).finish(), "target");
  mb.addTable(T.funcref, 1); mb.addElemActive(0, 0, [target]); mb.addElemDeclare([target]);
  const c = new Code(0);
  c.pc = 11; c.call(150);
  c.defer(c => { c.pc = 12; c.call(199).raw(OP.i32_add); });
  c.pc = 13; c.i32(0).callIndirect(type).raw(OP.i32_add).refFunc(target).callRef(type).raw(OP.i32_add);
  mb.setBody(entry, c.finish()); mb.export("entry", "func", entry); mb.export("imported", "func", 95);
  mb.start = mb.addFunc(mb.addFuncType([], []), new Code(0).call(42).drop().finish(), "start");
  const invoked: number[] = [], imports = { host: Object.fromEntries(Array.from({ length: 200 }, (_, i) => ["f" + i, () => { invoked.push(i); return i === 95 ? BigInt(i) : i; }])) };
  const declaredTypes = mb.types.length;
  const original = mb.build(), compact = mb.build(true), module = new WebAssembly.Module(compact as BufferSource);
  expect(WebAssembly.Module.imports(module).map(i => i.name)).toEqual(["f42", "f95", "f150", "f199"]);
  const functions = new WebAssembly.Instance(module, imports).exports as { entry: () => number; imported: () => bigint };
  expect(functions.entry()).toBe(355);
  expect(functions.imported()).toBe(95n);
  expect(invoked).toEqual([42, 150, 199, 95]);
  expect(mb.build()).toEqual(original);
  expect(mb.build(true)).toEqual(compact);
  expect(mb.types).toHaveLength(declaredTypes);
  for (let i = 0; i < c.marks.length; i += 2) expect(compact[mb.bodyOffsets[0] + c.prefixLen + c.marks[i]]).toBe(i === 4 ? 0x11 : 0x10);
  // An untracked body must keep the original index space.
  mb.addFunc(type, [0, 0x10, 0xc7, 1, 0x0b]);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(mb.build(true) as BufferSource))).toHaveLength(200);
});
