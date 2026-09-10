import { expect, test } from "bun:test";
import { coldOp, runCold, type ColdMethod } from "./cold";
import { DexFile } from "./dex";
import { rt } from "./runtime";
import "./natives/jlang";

const dex = new DexFile(new Uint8Array(await Bun.file(new URL("./fixtures/suspension.dex", import.meta.url)).arrayBuffer()));
function method(source: string): ColdMethod {
  return { R: rt, D: rt.dexLink(dex), S: undefined, regs: 4, first: 0, instance: false, widths: [1],
    ops: new Map([[0, coldOp(source, 1)]]), catches: [] };
}

test("cold literal pools preserve escaped strings, exponent numbers, bigint and negative zero", async () => {
  const text = 'await v17 $t pc " \\ \n 123n';
  const body = method(`v0=${JSON.stringify(text)};v1=1.25e+30;v2=9007199254740993n;v3=-0;F.value=[v0,v1,v2,v3];F.done=true;`);
  expect(body.ops.get(0)?.kind).toBe("sync");
  expect(await runCold(body, null, [])).toEqual([text, 1.25e30, 9007199254740993n, -0]);
});

test("cold handlers keep field and method pools distinct across matching instruction shapes", async () => {
  const a = method("F.value=v0.m$read$a(v0.f$value$a);F.done=true;");
  const b = method("F.value=v0.m$read$b(v0.f$value$b);F.done=true;");
  expect(await runCold(a, null, [{ f$value$a: 7, m$read$a: (n: number) => n + 1 }])).toBe(8);
  expect(await runCold(b, null, [{ f$value$b: 11, m$read$b: (n: number) => n + 2 }])).toBe(13);
});

test("cold loop limit escapes a catch range covering its own handler", async () => {
  const body = method("pc=0;return;");
  body.catches = [{ start: 0, end: 1, handlers: [], all: 0 }];
  await expect(runCold(body, null, [])).rejects.toThrow("loopbomb pc=0");
});
