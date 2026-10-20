// The classes the host implements (B2), as the cases of the hostclass suite use them: TS classes registered as specs for classes no dex defines (wdtest/*) beside the
// registered specs of the platform's own boundary (java/net/HttpURLConnection), the Java fixture Hc that uses them, and the calls host code makes on both. The suite runs
// the cases on a World, where the host object and the Java object are an object each; the lines must be java/hc/expected.txt.
import { join } from "node:path";
import { driven, getDeclared, JObj, rt, type Gen } from "../../src/jvm/runtime.ts";
import { classNameOf, iof, newObj, scall, vcall } from "../../src/jvm/natives/jentry.ts";
import { JAVA } from "./paths.ts";
import { androidFixture, javac, tempDir } from "../java.ts";

/** how a host method that waits enters Java again: the harness gives the World's */
export const enter: { call: (cls: string, name: string, desc: string) => Promise<unknown> } = { call: async (cls, name, desc) => scall(cls, name, desc) };
const sleep = () => new Promise<void>((r) => setTimeout(r, 1));

export class JCounter extends JObj {
  n = 0; tag: string | null = null;
  asInt(): number { return this.n; }
}
rt.register({
  name: "wdtest/Counter", ctor: JCounter, ifaces: ["java/lang/Runnable", "java/util/function/IntSupplier"],
  methods: {
    "inc()I": function (this: JCounter) { return ++this.n; },
    "get()I": function (this: JCounter) { return this.n; },
    "getAsInt()I": JCounter.prototype.asInt,
    "run()V": function (this: JCounter) { this.n += 100; },
    "self()Lwdtest/Counter;": function (this: JCounter) { return this; },
    "same(Lwdtest/Counter;)Z": function (this: JCounter, other: JCounter | null) { return +(this === other); },
    "setTag(Ljava/lang/String;)V": function (this: JCounter, tag: string) { this.tag = tag; },
    "getTag()Ljava/lang/String;": function (this: JCounter) { return this.tag; },
    // the host calls Java on its own receiver: a subclass's override answers
    "twice()I": driven(function* (this: JCounter): Gen<number> { return 2 * ((yield vcall(this, "get", "()I")) as number); }),
    "pause(I)I": async function (this: JCounter, by: number) { await sleep(); this.n += by; return this.n; },
    "reenterInit()I": () => scall("Hc$Boot", "get", "()I"),
    "reenter()I": async function () { return (await enter.call("Hc", "locked", "()I")) as number; },
    "bump(Ljava/lang/Object;)V": (a: Int32Array) => { a[0]++; },
    "nested(Ljava/lang/Object;)I": () => scall("Hc", "bumpTwice", "()I"),
    "fail()V": () => { throw rt.mkThrowable("java/lang/IllegalStateException", "from the host"); },
    "static make(I)Lwdtest/Counter;": (n: number) => { const c = new JCounter(); c.n = n; return c; },
  },
});
class JHostList extends JObj { items: unknown[] = []; }
rt.register({
  name: "wdtest/HostList", ctor: JHostList, sup: "java/util/AbstractList",
  methods: {
    "get(I)Ljava/lang/Object;": function (this: JHostList, i: number) {
      if (i < 0 || i >= this.items.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", `Index: ${i}`);
      return this.items[i];
    },
    "size()I": function (this: JHostList) { return this.items.length; },
    "add(ILjava/lang/Object;)V": function (this: JHostList, i: number, e: unknown) { this.items.splice(i, 0, e); },
  },
});

class JFace extends JObj {}
rt.register({ name: "Hc$Face", ctor: JFace, methods: { "area()I": () => 7 } });
class JShape extends JObj {}
rt.register({ name: "Hc$Shape", ctor: JShape, methods: { "area()I": () => 7 } });
rt.register({ name: "wdtest/Maker", ctor: class extends JObj {}, methods: { "static make()Ljava/lang/Object;": () => new JShape(), "static face()Ljava/lang/Object;": () => new JFace() } });

/** the fixture Hc and the classes it declares, as a dex; the classes the host implements are compiled against, not dexed */
export function hostDex(): string {
  const dir = join(JAVA, "hc"), stubs = tempDir();
  javac(stubs, ["Counter", "HostList", "Maker"].map((c) => join(dir, `stubs/wdtest/${c}.java`)), { release: 11, android: true });
  return join(androidFixture({ sources: [join(dir, "Hc.java")], classpath: [stubs] }), "classes.dex");
}

const OBJ = "Ljava/lang/Object;", STR = "Ljava/lang/String;";
function show(v: unknown): string {
  if (v === null || v === undefined || typeof v !== "object") return typeof v === "bigint" ? v + "n" : String(v);
  return Array.isArray(v) ? `[${v.map(show)}]` : `<${classNameOf(v)}>`;
}
async function run(f: () => unknown): Promise<string> {
  try { return "ok " + show(await f()); } catch (e) {
    const t = e as { msg?: unknown };
    return `threw ${classNameOf(e)} ${JSON.stringify(t.msg)}`;
  }
}

/** `blocking` runs the Java that waits: the World's entryAsync */
export async function hostCases(blocking: (cls: string, name: string, desc: string) => Promise<unknown>): Promise<string[]> {
  const out: string[] = [], line = async (name: string, f: () => unknown) => { out.push(`${name}: ${await run(f)}`); };
  for (const m of ["runnable", "identity", "tags", "sub", "fail", "list", "http", "opened", "shapes", "faces", "booted"]) await line("Hc." + m, () => scall("Hc", m, `()${m === "sub" || m === "shapes" || m === "faces" || m === "booted" ? "I" : STR}`));

  await line("a host method that waits, from a subclass", () => blocking("Hc", "blockSub", "()I"));
  await line("a host method that enters Java that blocks", () => blocking("Hc", "reentered", "()I"));

  const c = await newObj("wdtest/Counter");
  await line("new", () => c);
  await line("class", () => classNameOf(c));
  await line("instance of", () => [iof(c, "wdtest/Counter"), iof(c, "java/lang/Runnable"), iof(c, "java/util/function/IntSupplier"), iof(c, "java/lang/Object"), iof(c, STR)]);
  await line("a host method nested in another", () => vcall(c, "nested", `(${OBJ})I`, null));
  await line("inc inc", async () => [await vcall(c, "inc", "()I"), await vcall(c, "inc", "()I")]);
  await line("a host field", () => (c as JCounter).n);
  await line("through the alias", () => vcall(c, "getAsInt", "()I"));
  await line("self is the receiver", async () => await vcall(c, "self", "()Lwdtest/Counter;") === c);
  await line("kept is the object", async () => await scall("Hc", "keep", `(${OBJ})${OBJ}`, c) === c && await scall("Hc", "kept", `(I)${OBJ}`, 0) === c);
  await line("static make", async () => { const m = await scall("wdtest/Counter", "make", "(I)Lwdtest/Counter;", 9) as JCounter; return [m instanceof JCounter, m.n, await vcall(m, "get", "()I"), m === c]; });

  const made = new JCounter();
  made.n = 4;
  await line("a host-made object in Java", async () => [await scall("Hc", "keep", `(${OBJ})${OBJ}`, made) === made, await vcall(made, "inc", "()I"), made.n, classNameOf(made), iof(made, "java/lang/Runnable")]);
  await line("both ways", async () => await scall("Hc", "kept", `(I)${OBJ}`, 1) === made);
  await line("equal", async () => [await vcall(c, "equals", `(${OBJ})Z`, c), await vcall(c, "equals", `(${OBJ})Z`, made), await vcall(made, "hashCode", "()I") === await vcall(made, "hashCode", "()I")]);

  const sub = await scall("Hc", "newSub", `()${OBJ}`) as JCounter;
  await line("Java-made subclass", async () => [classNameOf(sub), sub instanceof JCounter, iof(sub, "wdtest/Counter"), await vcall(sub, "inc", "()I"), await vcall(sub, "twice", "()I"), sub.n]);
  await line("its host object", async () => await scall("Hc", "keep", `(${OBJ})${OBJ}`, sub) === sub && await scall("Hc", "kept", `(I)${OBJ}`, 2) === sub);
  await scall("Hc", "forget", "()V");

  const url = await newObj("java/net/URL", `(${STR})V`, "http://example.org/x");
  const conn = await newObj("Hc$Conn", "(Ljava/net/URL;)V", url) as Record<string, unknown>;
  await line("connection fields", () => [conn.method, conn.responseCode, conn.follow, conn.chunkLength, conn.fixedContentLengthLong, getDeclared(conn, "java/net/URLConnection", "connected"),
    getDeclared(conn, "java/net/HttpURLConnection", "method")]);
  await line("a field Java writes", async () => { await vcall(conn, "method", `(${STR})V`, "POST"); return [conn.method, await vcall(conn, "getRequestMethod", `()${STR}`)]; });
  await line("a field the host writes", () => { conn.method = "HEAD"; return vcall(conn, "method", `()${STR}`); });
  return out;
}
