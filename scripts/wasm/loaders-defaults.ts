// The loaders suite's default methods: interface super calls and default selection in each of three namespaces against the JDK, and abstract
// redeclarations that dominate a default after the interfaces were recompiled (binary evolution), as AbstractMethodError.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACC, Program } from "../../src/wasm/compiler/program.ts";
import { symbolicImplFor } from "../../src/wasm/compiler/linkage.ts";
import { prepareMethod } from "../../src/jvm/prepared.ts";
import { program, world } from "./lib.ts";
import { loadDexes } from "../dexes.ts";
import { JAVA, platformJars } from "./paths.ts";
import type { Suite } from "./tools.ts";
import { androidFixture, filesIn, java, javac, tempDir } from "../java.ts";

const core = () => program(platformJars("core-oj", "core-libart"));

/** `build` compiles fixture sources into a dex of a directory of its own (loaders.ts) */
export async function defaults(suite: Suite, build: (dir: string, sources: string[]) => string): Promise<void> {
  await interfaceSuper(suite, build("interfaceSuper", ["InterfaceSuper.java"]));
  await abstractDefault(suite, build("abstractDefault", ["InterfaceSuper.java", "ClassReabstract.java"]));
}

async function interfaceSuper({ check, fail }: Suite, dex: string): Promise<void> {
  {
    const p = new Program(loadDexes(dex), core()), target = world(p), loader = p.newLoader(p.root, null);
    target.addDexes(loadDexes(dex), loader);
    const face = p.definedBy(loader, "InterfaceSuper$C")!, replacement = p.definedBy(loader, "InterfaceSuper$B")!;
    p.addClass({ name: "Outside", sup: "java/lang/Object", ifaces: [face], flags: ACC.PUBLIC, isInterface: false, fields: [], methods: [], byKey: new Map(), dex: null, def: null }, p.root);
    target.link("Outside");
    if ((target as any).classes.has(face)) fail("dependency control interface already linked");
    try { target.namespaces.initiateClass(loader, "InterfaceSuper$B", replacement); fail("changed inherited default accepted"); }
    catch (error) { const t = target.throwable(error); if (!t || target.classNameOf(t) !== "java/lang/LinkageError" || p.lookup(loader, "InterfaceSuper$B") !== "InterfaceSuper$B") throw error; }
  }
  const names = ["selected", "reversed", "declared", "inherited", "classSuper", "virtualDefault", "interfaceDefault", "unusedAbstract"];
  const jdk = java(dirname(dex), "InterfaceSuper").trim().split("\n").map(Number);
  if (!check("interface-super JDK control", jdk.slice(0, names.length).join(","), "22,22,33,11,44,22,22,55")) return;
  const p = new Program(loadDexes(dex), core()), target = p.get("InterfaceSuper$Select")!.byKey.get("f()I")!;
  const code = target.dex.code(target.codeOff).insns, ref = target.dex.method(code[1]);
  if ((code[0] & 0xff) !== 0x6f || target.dex.rawType(ref.cls) !== "LInterfaceSuper$C;") fail("D8 did not preserve invoke-super C.f");
  if (p.get("InterfaceSuper$Default")!.byKey.has("f()I")) fail("D8 introduced a default forwarder");
  for (const [method, kind, owner] of [["virtualDefault", "invoke-virtual", "Default"], ["interfaceDefault", "invoke-interface", "C"]]) {
    const m = p.get("InterfaceSuper")!.byKey.get(method + "()I")!;
    const call = prepareMethod(m.dex.code(m.codeOff)).instructions.find(i => i.name === kind && m.dex.method(i.b).name === "f");
    if (!call || m.dex.rawType(m.dex.method(call.b).cls) !== `LInterfaceSuper$${owner};`) fail("D8 changed ordinary default dispatch");
  }
  const current = world(p), mirrors = new Set<object>();
  for (const [index, namespace] of ["root", "first", "second"].entries()) {
    let cls = "InterfaceSuper";
    if (namespace !== "root") {
      const loader = p.newLoader(p.boot, null);
      current.addDexes(loadDexes(dex), loader); cls += "@" + loader.id;
    }
    const suffix = cls.slice("InterfaceSuper".length), defaultClass = "InterfaceSuper$Default" + suffix, selected = "InterfaceSuper$B" + suffix;
    if (p.implFor(defaultClass, "f", "()I")?.cls !== selected || symbolicImplFor(p, defaultClass, "f()I")?.cls !== selected) fail("ordinary Wasm default selector lost maximal declaration or loader identity");
    await current.entryAsync(cls, "setOffset", "(I)V")(index * 17);
    for (const [i, name] of names.entries()) check(`interface-super ${namespace}/${name}`, await current.entryAsync(cls, name, "()I")(), jdk[index * names.length + i]);
    mirrors.add(await current.entryAsync(cls, "self", "()Ljava/lang/Class;")() as object);
  }
  check("interface-super Class identities, one per loader", mirrors.size, 3);
  console.log(`interface-super/default: ${3 * names.length} Wasm cases against the JDK; scoped rebinding keeps the outside-loader dispatch guard`);
}

async function abstractDefault({ check, fail }: Suite, dex: string): Promise<void> {
  const dir = dirname(dex), old = tempDir();
  writeFileSync(join(old, "InterfaceSuper.java"), readFileSync(join(JAVA, "InterfaceSuper.java"), "utf8").replace("interface Reabstracted extends C { int f(); }", "interface Reabstracted extends C {}").replace("interface OtherReabstracted extends C { int f(); }", "interface OtherReabstracted extends C {}"));
  writeFileSync(join(old, "ClassReabstract.java"), readFileSync(join(JAVA, "ClassReabstract.java"), "utf8").replace("  public abstract int f();", ""));
  javac(old, [join(old, "InterfaceSuper.java"), join(old, "ClassReabstract.java"), join(JAVA, "AbstractDefaultUse.java")], { release: 11 });
  for (const file of filesIn(old, /^AbstractDefaultUse.*\.class$/)) copyFileSync(file, join(dir, file.split("/").pop()!));
  androidFixture({ out: dir });
  if (!check("binary-evolution JDK control", java(dir, "AbstractDefaultUse").trim(), "42\n1\n42\n1")) return;
  const p = new Program(loadDexes(dex), core()), w = world(p);
  for (let index = 0; index < 3; index++) {
    let cls = "AbstractDefaultUse";
    if (index) { const loader = p.newLoader(p.boot, null); w.addDexes(loadDexes(dex), loader); cls += "@" + loader.id; }
    const abstract = symbolicImplFor(p, cls, "f()I", true);
    if (p.implFor(cls, "f", "()I") || symbolicImplFor(p, cls, "f()I") || !abstract || !(abstract.flags & ACC.ABSTRACT) || !(abstract.flags & ACC.PUBLIC)) fail("compatible maximal abstracts lost metadata or retained concrete default");
    for (const suffix of ["", "Class"]) {
      const mode = `abstract dominance ${index}/${suffix || "interface"}`;
      try {
        check(`${mode}: preparation`, await w.entryAsync(cls, "prepare" + suffix, "()I")(), 42);
        check(`${mode}: AbstractMethodError`, await w.entryAsync(cls, "check" + suffix, "()I")(), 1);
      } catch (error) { fail(`${mode} threw before the expected catch: ${error}`); }
    }
  }
  console.log("abstract dominance: recompiled abstract redeclarations raise AbstractMethodError in each of three namespaces");
}
