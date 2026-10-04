// java.lang.reflect.Proxy.generateProxy (art/runtime/native/java_lang_reflect_Proxy.cc, proxy_trampoline): a class that extends Proxy and
// implements the interfaces, whose every listed method boxes its arguments into an Object[] and calls Proxy.invoke(proxy, method, args), which
// asks the InvocationHandler. The class is made at run time (World.addClass); its method bodies are generated here and refer to the Method
// objects libcore passed in through the table compiled code reads by index (World.pin). The result is unboxed as ART does: null for a primitive is a
// NullPointerException, a value of another class a ClassCastException, and a checked exception the method does not declare is wrapped in
// UndeclaredThrowableException.
import { OP } from "./code";
import { T, refNull } from "./wasmbin";
import { ACC, type JClass, type MethodInfo } from "./program";
import { BOX } from "./reflect";
import { descToName } from "../../../src/jvm/abi";
import type { Compiler, Intrinsic } from "./j2w";
import type { Code } from "./code";
import type { World } from "./lazy";

const PROXY = "java/lang/reflect/Proxy", HANDLER = "java/lang/reflect/InvocationHandler", EXEC = "java/lang/reflect/Executable", CLASS = "java/lang/Class";
const NM_TABLE = 1, PROXY_FLAG = 0x40000;
const OBJECT_ARRAY = "[Ljava/lang/Object;";

export const proxyIntrinsics = new Map<string, Intrinsic>();
proxyIntrinsics.set("java/lang/reflect/Proxy.generateProxy(Ljava/lang/String;[Ljava/lang/Class;Ljava/lang/ClassLoader;[Ljava/lang/reflect/Method;[[Ljava/lang/Class;)Ljava/lang/Class;", (cx, m, c) => {
  c.lget(0).externConvertAny().lget(1).externConvertAny().lget(3).externConvertAny().lget(4).externConvertAny().call(cx.imp.proxy).anyConvertExtern();
});

interface Readers { art(method: object): bigint; classId(cls: object): number; alen(a: object): number; aget(a: object, i: number): object; classOf(id: number): object }
const readers = new WeakMap<World, Readers>();
function readersOf(w: World): Readers {
  let r = readers.get(w);
  if (!r) readers.set(w, r = {
    art: w.fieldReader(EXEC, "artMethod", "J") as never, classId: w.fieldReader(CLASS, "dexTypeIndex", "I") as never,
    alen: w.hostFn("px:alen", ["L"], "I", (cx, c) => { c.lget(0).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).refAsNonNull().arrayLen(); }),
    aget: w.hostFn("px:aget", ["L", "I"], "L", (cx, c) => { c.lget(0).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).lget(1).arrayGet(cx.tData.ref); }),
    classOf: w.hostFn("px:classOf", ["I"], "L", (cx, c) => { c.lget(0); cx.callRt(c, "classOf"); }),
  });
  return r;
}

/** host.proxy(name, interfaces, methods, exceptions): the Class of the proxy class `name`, made now */
export function generateProxy(w: World, name: string, interfaces: object, methods: object, exceptions: object): object {
  const r = readersOf(w), internal = name.replace(/\./g, "/");
  const jc: JClass = {
    name: internal, dex: null, def: null, sup: PROXY, flags: ACC.PUBLIC | ACC.FINAL | PROXY_FLAG, isInterface: false, fields: [], methods: [], byKey: new Map(),
    ifaces: Array.from({ length: r.alen(interfaces) }, (_, i) => w.nameOf(r.classId(r.aget(interfaces, i)))),
  };
  const bodies = new Map<MethodInfo, Intrinsic>();
  const add = (m: MethodInfo, body: Intrinsic) => { jc.methods.push(m); jc.byKey.set(m.key, m); bodies.set(m, body); };
  const made = (src: Pick<MethodInfo, "name" | "desc" | "key" | "params" | "ret">, flags: number): MethodInfo =>
    ({ cls: internal, name: src.name, desc: src.desc, flags, dex: null!, methodIdx: -1, codeOff: 0, key: src.key, isStatic: false, isCtor: src.name === "<init>", params: src.params, ret: src.ret });
  add(made({ name: "<init>", desc: `(L${HANDLER};)V`, key: `<init>(L${HANDLER};)V`, params: [`L${HANDLER};`], ret: "V" }, ACC.PUBLIC), (cx, m, c) => {
    c.lget(0).lget(1); cx.callMethod(c, cx.prog.resolve(PROXY, "<init>", `(L${HANDLER};)V`)!);
  });
  for (let i = 0; i < r.alen(methods); i++) {
    const method = r.aget(methods, i), cookie = r.art(method), src = w.prog.get(w.nameOf(Number(cookie >> 16n)))!.methods[Number(cookie & 0xffffn)];
    if (jc.byKey.has(src.key)) continue;
    const handle = w.pin(method), declared = w.pin(r.aget(exceptions, i));
    add(made(src, ACC.PUBLIC | ACC.FINAL), (cx, m, c) => proxyBody(cx, c, m, handle, declared));
  }
  w.addClass(jc, bodies);
  return r.classOf(w.idOf(internal));
}

/** the body of a proxy method: params (proxy, arguments...) */
function proxyBody(cx: Compiler, c: Code, m: MethodInfo, method: number, declared: number): void {
  const prog = cx.prog, args = c.newLocal(T.anyref), e = c.newLocal(T.anyref), result = c.newLocal(T.anyref), wrapper = cx.tArr.ref;
  if (m.params.length) {
    cx.emitNewArray(c, OBJECT_ARRAY, () => c.i32(m.params.length)); c.lset(args);
    m.params.forEach((p, i) => {
      c.lget(args).refCast(wrapper).structGet(wrapper, 2).i32(i).lget(i + 1);
      if (BOX[p]) { const [cls] = BOX[p]; cx.emitEnsure(c, cls); cx.callMethod(c, prog.resolve(cls, "valueOf", `(${p})L${cls};`)!); }
      c.arraySet(cx.tData.ref);
    });
  } else c.anyNull().lset(args);
  c.block(T.anyref).block(T.anyref).tryTable(null, [[0, cx.tag, 0]]);
  c.lget(0).i32(method).tableGet(NM_TABLE).anyConvertExtern().lget(args);
  cx.emitEnsure(c, PROXY); cx.callMethod(c, prog.resolve(PROXY, "invoke", `(L${PROXY};Ljava/lang/reflect/Method;${OBJECT_ARRAY})Ljava/lang/Object;`)!);
  c.br(2).end().unreachable().end();
  // an exception the handler raised: unchecked ones and those the method declares pass, others are wrapped
  const UTE = "java/lang/reflect/UndeclaredThrowableException", rethrow = () => { c.lget(e).throw_(cx.tag); };
  c.lset(e);
  for (const unchecked of ["java/lang/RuntimeException", "java/lang/Error"]) { c.lget(e).call(cx.instanceOfFn(unchecked)).if_(); rethrow(); c.end(); }
  const list = c.newLocal(refNull(cx.tData.ref)), i = c.newLocal(T.i32);
  c.i32(declared).tableGet(NM_TABLE).anyConvertExtern().refCast(wrapper).structGet(wrapper, 2).lset(list);
  c.block().loop().lget(i).lget(list).refAsNonNull().arrayLen().raw(OP.i32_ge_s).brIf(1);
  c.lget(list).refAsNonNull().lget(i).arrayGet(cx.tData.ref); c.lget(e); cx.callMethod(c, prog.resolve(CLASS, "isInstance", "(Ljava/lang/Object;)Z")!);
  c.if_(); rethrow(); c.end();
  c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
  const wrapped = c.newLocal(T.anyref);
  cx.emitEnsure(c, UTE); cx.emitNew(c, UTE); c.lset(wrapped);
  c.lget(wrapped).lget(e); cx.callMethod(c, prog.resolve(UTE, "<init>", "(Ljava/lang/Throwable;)V")!);
  c.lget(wrapped).throw_(cx.tag).end();
  // the result: void drops it; a primitive unboxes its wrapper; a reference is cast to the declared class
  c.lset(result);
  if (m.ret === "V") return;
  if (BOX[m.ret]) {
    const [cls, unbox, desc] = BOX[m.ret];
    c.lget(result).refIsNull().if_(); cx.callThrower(c, "npe"); c.end();
    c.lget(result).call(cx.castFn(cls)); cx.callMethod(c, prog.resolve(cls, unbox, desc)!);
  } else c.lget(result).call(cx.castFn(m.ret[0] === "L" ? descToName(m.ret) : m.ret));
}
