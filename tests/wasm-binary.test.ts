import { expect, test } from "bun:test";
import { ModuleBuilder } from "../src/wasm/compiler/wasmbin";

test("Wasm imports retain Unicode and long module names across repeated builds", () => {
  const mb = new ModuleBuilder(), signature = mb.addFuncType([], []), expected: WebAssembly.ModuleImportDescriptor[] = [];
  const utf8 = (s: string) => new TextDecoder().decode(new TextEncoder().encode(s));
  for (const mod of ["host", "共有😀", "x".repeat(130), "\ud800", ""]) {
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
