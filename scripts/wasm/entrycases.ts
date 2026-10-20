// The calls the entry suite makes from the host, through the names jentry exports, and what they answer as lines of text.
import { join } from "node:path";
import { getDeclared, setDeclared } from "../../src/jvm/runtime.ts";
import { JThrowable } from "../../src/jvm/natives/jthrowable.ts";
import { boxDesc, unbox } from "../../src/jvm/natives/jbox.ts";
import { JThread, callOn, classNameOf, iof, linkClass, newObj, scall, staticField, vcall } from "../../src/jvm/natives/jentry.ts";
import { javaInterface } from "../../src/android/webjavabridge.ts";
import { processFailure } from "../../src/shell/process-port.ts";
import { JAVA } from "./paths.ts";
import { androidFixture } from "../java.ts";

let built: string | undefined;
/** the fixture E (and its nested classes) as a dex, built once per process */
export const entryDex = (): string => built ??= join(androidFixture({ sources: [join(JAVA, "E.java")] }), "classes.dex");

const STR = "Ljava/lang/String;", INT = "Ljava/lang/Integer;", E = "E";
async function show(v: unknown): Promise<string> {
  v = await v;
  if (v === null || v === undefined || typeof v !== "object") return typeof v === "bigint" ? v + "n" : Object.is(v, -0) ? "-0" : String(v);
  if (ArrayBuffer.isView(v)) return `${v.constructor.name}[${[...(v as unknown as Iterable<number>)]}]`;
  if (Array.isArray(v)) return `[${await Promise.all(v.map(show))}]`;
  return `${classNameOf(v)}(${await vcall(v, "toString", `()${STR}`)})`;
}
async function run(f: () => unknown): Promise<string> {
  try { return "ok " + await show(f()); } catch (e) {
    const t = e as { msg?: unknown };
    return `threw ${classNameOf(e)} ${JSON.stringify(t.msg)} jthrowable=${e instanceof JThrowable} runtime=${iof(e, "java/lang/RuntimeException")} error=${iof(e, "java/lang/Error")}`;
  }
}

/** the exception `f` throws */
async function caught(f: () => unknown): Promise<unknown> {
  try { await f(); } catch (t) { return t; }
  throw new Error("did not throw");
}

export async function entryCases(): Promise<string[]> {
  const out: string[] = [], line = async (name: string, f: () => unknown) => { out.push(`${name}: ${await run(f)}`); };
  await line("WebView bridge", async () => {
    const api = await javaInterface(await newObj("E$WebApi"), new JThread());
    return [Object.keys(api), await api.ping(41)];
  });
  await line("add", () => scall(E, "add", "(II)I", 40, 2));
  await line("mul", () => scall(E, "mul", "(JJ)J", 1n << 33n, 3n));
  await line("half", () => scall(E, "half", "(F)F", 3.5));
  await line("scale", () => scall(E, "scale", "(DI)D", 1.25, 3));
  await line("not", () => scall(E, "not", "(Z)Z", 1));
  await line("next", () => scall(E, "next", "(C)C", 65));
  await line("lowByte", () => scall(E, "lowByte", "(I)B", 0x1ff));
  for (const [name, desc, value] of [["Integer", "I", 1], ["Long", "J", 1234567890123n], ["Float", "F", 1.25], ["Double", "D", -0], ["Boolean", "Z", 1], ["Byte", "B", -7], ["Short", "S", -300], ["Character", "C", 65]] as const) {
    await line("unbox " + name, async () => {
      const boxed = await scall("java/lang/" + name, "valueOf", `(${desc})Ljava/lang/${name};`, value);
      return [boxDesc(boxed), unbox(boxed)];
    });
  }
  await line("join", () => scall(E, "join", `(${STR}${STR})${STR}`, "a", "b"));
  await line("nul", () => scall(E, "nul", `(${STR})${STR}`, null));
  await line("sum", () => scall(E, "sum", "([I)I", Int32Array.of(1, 2, 3, 4)));
  const filled = new Int8Array(4);
  await line("fill", () => scall(E, "fill", "([BI)V", filled, 10));
  await line("fill's array", () => filled);
  await line("bytes", () => scall(E, "bytes", "(I)[B", 3));
  await line("names", () => scall(E, "names", `(I)[${STR}`, 2));
  await line("counted", () => scall(E, "counted", "()I"));
  for (const f of ["built", "K", "BIG", "D", "F", "NAME", "INSTANCE"]) await line("static " + f, () => staticField(E, f));
  const a = await newObj(E, "(I)V", 3), b = await newObj(E);
  await line("new", () => a);
  await line("default", () => b);
  await line("get", () => vcall(a, "get", "()I"));
  await line("plus", () => vcall(a, "plus", "(I)I", 4));
  await line("set", () => vcall(a, "set", "(I)V", 8));
  await line("describe", () => vcall(a, "describe", `()${STR}`));
  await line("self is the receiver", async () => (await vcall(a, "self", `()L${E};`)) === a);
  await line("static make is not the receiver", async () => (await scall(E, "make", `(I)L${E};`, 3)) === a);
  const sub = await vcall(a, "sub", `(I)L${E};`, 6);
  await line("override", () => vcall(sub, "get", "()I"));
  await line("sub", () => sub);
  await line("peer", () => getDeclared(a, E, "peer"));
  await line("getDeclared", () => getDeclared(a, E, "v"));
  await line("setDeclared", () => { setDeclared(a, E, { v: 21, peer: sub }); return vcall(a, "get", "()I"); });
  await line("peer set", () => getDeclared(a, E, "peer") === sub);
  await line("instance of", () => [iof(sub, E), iof(sub, "E$Sub"), iof(a, "E$Sub"), iof(a, "java/lang/Object"), iof(null, E), classNameOf(sub)]);
  const e = linkClass(E);
  await line("class", () => [e.name, e.static("K"), e.has("get", "()I"), e.has("nope", "()I"), e.call("add", "(II)I")(1, 2)]);
  await line("setStatic", () => [e.setStatic("D", 9.5, "D"), e.setStatic("nope", 1, "I"), e.static("D")]);
  await line("allocate and construct", () => { const o = e.new(); e.special("<init>", "(I)V")(o, 17); return vcall(o, "get", "()I"); });
  await line("unknown method", () => caught(() => scall(E, "nope", "()V")).then((t) => [classNameOf(t), iof(t, "java/lang/RuntimeException")]));
  const list = await newObj("java/util/ArrayList");
  await line("list", () => vcall(list, "add", `(Ljava/lang/Object;)Z`, "x"));
  await line("list size", () => vcall(list, "size", "()I"));
  await line("list string", () => vcall(list, "toString", `()${STR}`));
  await line("Integer", async () => vcall(await scall("java/lang/Integer", "valueOf", `(I)${INT}`, 5), "intValue", "()I"));
  await line("Integer.MAX_VALUE", () => staticField("java/lang/Integer", "MAX_VALUE"));
  await line("parseInt", () => scall("java/lang/Integer", "parseInt", `(${STR})I`, "42"));
  await line("string receiver", () => vcall("abc", "length", "()I"));
  await line("boom", () => scall(E, "boom", "(I)I", -3));
  await line("process exception", async () => {
    const error = processFailure(await caught(() => scall(E, "boom", "(I)I", -3)));
    return [error.javaClass, error.message];
  });
  await line("boom ok", () => scall(E, "boom", "(I)I", 3));
  await line("npe", () => caught(() => scall(E, "npe", "(Ljava/lang/Object;)I", null)).then((t) => [classNameOf(t), iof(t, "java/lang/RuntimeException")]));
  await line("parseInt fails", () => scall("java/lang/Integer", "parseInt", `(${STR})I`, "x"));
  await line("getMessage", () => caught(() => scall(E, "boom", "(I)I", -4)).then((t) => vcall(t, "getMessage", `()${STR}`)));
  await line("wrapped", () => scall(E, "wrapped", "(I)I", -1));
  await line("cause", () => caught(() => scall(E, "wrapped", "(I)I", -2)).then((t) => { const c = (t as { cause: { msg: unknown } }).cause; return [classNameOf(c), c.msg, c !== t]; }));
  await line("rethrown", () => caught(() => scall(E, "boom", "(I)I", -5)).then((t) => { throw t; }));
  // a thread the host made is a thread of its own, wherever it enters Java
  const thread = Object.assign(new JThread(), { jname: "Binder:7" }), current = () => scall("java/lang/Thread", "currentThread", "()Ljava/lang/Thread;");
  await line("own thread", async () => {
    const main = await current(), mine = await callOn(thread, current), again = await callOn(thread, current);
    return [mine !== main, mine === again];
  });
  return out;
}
