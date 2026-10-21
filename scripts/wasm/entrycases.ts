// The calls the entry suite makes from the host, through the names jentry exports, and what each must answer as text.
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
/** what `f` answers: its value, or the exception that leaves it */
async function run(f: () => unknown): Promise<string> {
  try { return await show(f()); } catch (e) {
    const t = e as { msg?: unknown };
    return `threw ${classNameOf(e)} ${JSON.stringify(t.msg)} jthrowable=${e instanceof JThrowable} runtime=${iof(e, "java/lang/RuntimeException")} error=${iof(e, "java/lang/Error")}`;
  }
}

/** the exception `f` throws */
async function caught(f: () => unknown): Promise<unknown> {
  try { await f(); } catch (t) { return t; }
  throw new Error("did not throw");
}

/** the calls, each with the answer it must give: the ones that answer otherwise */
export async function entryCases(): Promise<string[]> {
  const out: string[] = [], line = async (name: string, want: string, f: () => unknown) => {
    const got = await run(f);
    if (got !== want) out.push(`${name}\n  want  ${want}\n  wasm  ${got}`);
  };
  await line("WebView bridge", "[[ping],42]", async () => {
    const api = await javaInterface(await newObj("E$WebApi"), new JThread());
    return [Object.keys(api), await api.ping(41)];
  });
  await line("add", "42", () => scall(E, "add", "(II)I", 40, 2));
  await line("mul", "25769803776n", () => scall(E, "mul", "(JJ)J", 1n << 33n, 3n));
  await line("half", "1.75", () => scall(E, "half", "(F)F", 3.5));
  await line("scale", "3.75", () => scall(E, "scale", "(DI)D", 1.25, 3));
  await line("not", "0", () => scall(E, "not", "(Z)Z", 1));
  await line("next", "66", () => scall(E, "next", "(C)C", 65));
  await line("lowByte", "-1", () => scall(E, "lowByte", "(I)B", 0x1ff));
  for (const [name, desc, value, want] of [["Integer", "I", 1, "[I,1]"], ["Long", "J", 1234567890123n, "[J,1234567890123n]"], ["Float", "F", 1.25, "[F,1.25]"], ["Double", "D", -0, "[D,-0]"], ["Boolean", "Z", 1, "[Z,1]"], ["Byte", "B", -7, "[B,-7]"], ["Short", "S", -300, "[S,-300]"], ["Character", "C", 65, "[C,65]"]] as const) {
    await line("unbox " + name, want, async () => {
      const boxed = await scall("java/lang/" + name, "valueOf", `(${desc})Ljava/lang/${name};`, value);
      return [boxDesc(boxed), unbox(boxed)];
    });
  }
  await line("join", "a-b", () => scall(E, "join", `(${STR}${STR})${STR}`, "a", "b"));
  await line("nul", "null", () => scall(E, "nul", `(${STR})${STR}`, null));
  await line("sum", "10", () => scall(E, "sum", "([I)I", Int32Array.of(1, 2, 3, 4)));
  const filled = new Int8Array(4);
  await line("fill", "undefined", () => scall(E, "fill", "([BI)V", filled, 10));
  await line("fill's array", "Int8Array[10,11,12,13]", () => filled);
  await line("bytes", "Int8Array[1,2,3]", () => scall(E, "bytes", "(I)[B", 3));
  await line("names", "[n0,n1]", () => scall(E, "names", `(I)[${STR}`, 2));
  await line("counted", "43", () => scall(E, "counted", "()I"));
  for (const [f, want] of [["built", "43"], ["K", "7"], ["BIG", "1099511627776n"], ["D", "2.5"], ["F", "1.5"], ["NAME", "entry"], ["INSTANCE", "E(E11)"]]) await line("static " + f, want, () => staticField(E, f));
  const a = await newObj(E, "(I)V", 3), b = await newObj(E);
  await line("new", "E(E3)", () => a);
  await line("default", "E(E5)", () => b);
  await line("get", "3", () => vcall(a, "get", "()I"));
  await line("plus", "7", () => vcall(a, "plus", "(I)I", 4));
  await line("set", "undefined", () => vcall(a, "set", "(I)V", 8));
  await line("describe", "E8", () => vcall(a, "describe", `()${STR}`));
  await line("self is the receiver", "true", async () => (await vcall(a, "self", `()L${E};`)) === a);
  await line("static make is not the receiver", "false", async () => (await scall(E, "make", `(I)L${E};`, 3)) === a);
  const sub = await vcall(a, "sub", `(I)L${E};`, 6);
  await line("override", "-6", () => vcall(sub, "get", "()I"));
  await line("sub", "E$Sub(E6)", () => sub);
  await line("peer", "null", () => getDeclared(a, E, "peer"));
  await line("getDeclared", "8", () => getDeclared(a, E, "v"));
  await line("setDeclared", "21", () => { setDeclared(a, E, { v: 21, peer: sub }); return vcall(a, "get", "()I"); });
  await line("peer set", "true", () => getDeclared(a, E, "peer") === sub);
  await line("instance of", "[true,true,false,true,false,E$Sub]", () => [iof(sub, E), iof(sub, "E$Sub"), iof(a, "E$Sub"), iof(a, "java/lang/Object"), iof(null, E), classNameOf(sub)]);
  const e = linkClass(E);
  await line("class", "[E,7,true,false,3]", () => [e.name, e.static("K"), e.has("get", "()I"), e.has("nope", "()I"), e.call("add", "(II)I")(1, 2)]);
  await line("setStatic", "[true,false,9.5]", () => [e.setStatic("D", 9.5, "D"), e.setStatic("nope", 1, "I"), e.static("D")]);
  await line("allocate and construct", "17", () => { const o = e.new(); e.special("<init>", "(I)V")(o, 17); return vcall(o, "get", "()I"); });
  await line("unknown method", "[java/lang/UnsupportedOperationException,true]", () => caught(() => scall(E, "nope", "()V")).then((t) => [classNameOf(t), iof(t, "java/lang/RuntimeException")]));
  const list = await newObj("java/util/ArrayList");
  await line("list", "1", () => vcall(list, "add", `(Ljava/lang/Object;)Z`, "x"));
  await line("list size", "1", () => vcall(list, "size", "()I"));
  await line("list string", "[x]", () => vcall(list, "toString", `()${STR}`));
  await line("Integer", "5", async () => vcall(await scall("java/lang/Integer", "valueOf", `(I)${INT}`, 5), "intValue", "()I"));
  await line("Integer.MAX_VALUE", "2147483647", () => staticField("java/lang/Integer", "MAX_VALUE"));
  await line("parseInt", "42", () => scall("java/lang/Integer", "parseInt", `(${STR})I`, "42"));
  await line("string receiver", "3", () => vcall("abc", "length", "()I"));
  await line("boom", 'threw java/lang/IllegalStateException "boom -3" jthrowable=true runtime=true error=false', () => scall(E, "boom", "(I)I", -3));
  await line("process exception", "[java/lang/IllegalStateException,boom -3]", async () => {
    const error = processFailure(await caught(() => scall(E, "boom", "(I)I", -3)));
    return [error.javaClass, error.message];
  });
  await line("boom ok", "3", () => scall(E, "boom", "(I)I", 3));
  await line("npe", "[java/lang/NullPointerException,true]", () => caught(() => scall(E, "npe", "(Ljava/lang/Object;)I", null)).then((t) => [classNameOf(t), iof(t, "java/lang/RuntimeException")]));
  await line("parseInt fails", 'threw java/lang/NumberFormatException "For input string: \\"x\\"" jthrowable=true runtime=true error=false', () => scall("java/lang/Integer", "parseInt", `(${STR})I`, "x"));
  await line("getMessage", "boom -4", () => caught(() => scall(E, "boom", "(I)I", -4)).then((t) => vcall(t, "getMessage", `()${STR}`)));
  await line("wrapped", 'threw E$Err "wrapped -1" jthrowable=true runtime=true error=false', () => scall(E, "wrapped", "(I)I", -1));
  await line("cause", "[java/lang/IllegalStateException,boom -2,true]", () => caught(() => scall(E, "wrapped", "(I)I", -2)).then((t) => { const c = (t as { cause: { msg: unknown } }).cause; return [classNameOf(c), c.msg, c !== t]; }));
  await line("rethrown", 'threw java/lang/IllegalStateException "boom -5" jthrowable=true runtime=true error=false', () => caught(() => scall(E, "boom", "(I)I", -5)).then((t) => { throw t; }));
  // a thread the host made is a thread of its own, wherever it enters Java
  const thread = Object.assign(new JThread(), { jname: "Binder:7" }), current = () => scall("java/lang/Thread", "currentThread", "()Ljava/lang/Thread;");
  await line("own thread", "[true,true]", async () => {
    const main = await current(), mine = await callOn(thread, current), again = await callOn(thread, current);
    return [mine !== main, mine === again];
  });
  return out;
}
