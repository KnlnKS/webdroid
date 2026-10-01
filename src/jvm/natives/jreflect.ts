// java.lang.reflect.Method + annotation instances backed by DEX annotation parsing.

import { rt, JObj, type ClassInfo, type NativeSpec, type Runtime, driven, type Gen } from "../runtime";
import { mangleMethod, mangleField, descToName, parseMethodDesc, jarray, PRIM_ARRAYS, type PrimElem, PRIM_NAME, PRIM_DESC, lateMethod, dotName, slashName, doubleToLongBits, longBitsToDouble, floatToIntBits, intBitsToFloat, splitSig } from "../abi";
import { vcall, packageNamed, stringHash, idHash, JClass, classpathStream, after, enclosingClass, newObj } from "./jlang";
import { box, boxObject, unbox, type BoxDesc } from "./jbox";
import type { DexFile, EncAnnotation, EncVal } from "../dex";
import { unsafeFallthrough } from "../compiler";
import { device } from "../../shell/config";
import { mem } from "../../native/mem";
import { handle } from "../../android/handles";
import { nonMovableBytes } from "./jnio";
import { BOOT_JAR_PATHS } from "../bootclasspath";

// ── annotation cache per class, by member name (+ descriptor for methods)
interface ClassAnno {
  cls: EncAnnotation[];
  methodsByRef: Map<string, EncAnnotation[]>; // "name+desc" → annotations
  fieldsByName: Map<string, EncAnnotation[]>;
  paramsByRef: Map<string, EncAnnotation[][]>;
}
const annoCache = new WeakMap<ClassInfo, ClassAnno>();
/** a member's declaring class, for Field, Method and Constructor */
function declaringClass(this: { owner: ClassInfo }) { return (this.owner.owner ?? rt).classFor(this.owner.name); }
/** the annotation holding an annotation interface's element defaults (dalvik AnnotationDefault) */
function annotationDefaults(info: ClassInfo): EncAnnotation | null {
  const d = classAnno(info).cls.find((a) => a.type === "dalvik/annotation/AnnotationDefault")?.elements.value;
  return d && typeof d === "object" && !Array.isArray(d) && d.kind === "annotation" ? d.anno : null;
}
function classAnno(info: ClassInfo): ClassAnno {
  let a = annoCache.get(info);
  if (a) return a;
  a = { cls: [], methodsByRef: new Map(), fieldsByName: new Map(), paramsByRef: new Map() };
  if (info.dex && info.def) {
    const raw = info.dex.classAnnotations(info.def);
    a.cls = raw.cls;
    for (const [methodIdx, annos] of raw.methods) {
      const m = info.dex.method(methodIdx);
      const desc = info.dex.methodDesc(methodIdx);
      a.methodsByRef.set(m.name + desc, annos);
    }
    for (const [fieldIdx, annos] of raw.fields) {
      a.fieldsByName.set(info.dex.field(fieldIdx).name, annos);
    }
    for (const [methodIdx, per] of raw.params) {
      const m = info.dex.method(methodIdx);
      a.paramsByRef.set(m.name + info.dex.methodDesc(methodIdx), per);
    }
  }
  annoCache.set(info, a);
  return a;
}
export function methodAnnotations(info: ClassInfo, name: string, desc: string): EncAnnotation[] {
  return classAnno(info).methodsByRef.get(name + desc) ?? [];
}

/** getExceptionTypes: the classes a dalvik.annotation.Throws lists for the member */
function thrownTypes(owner: ClassInfo, name: string, desc: string) {
  const v = methodAnnotations(owner, name, desc).find((a) => a.type === "dalvik/annotation/Throws")?.elements.value;
  const out = Array.isArray(v) ? v.map((e) => e && typeof e === "object" && "idx" in e ? (owner.owner ?? rt).classFor(descToName(owner.dex!.type(e.idx as number))) : null) : [];
  return jarray(out.filter(Boolean), "Ljava/lang/Class;");
}
/** a descriptor as Java spells the type: int, java.lang.String, byte[] */
function javaTypeName(d: string): string {
  let dims = 0;
  while (d[dims] === "[") dims++;
  const base = d[dims] === "L" ? dotName(d.slice(dims + 1, -1)) : PRIM_NAME[d[dims]];
  return base + "[]".repeat(dims);
}
class JAccessibleObject extends JObj { accessible = 0; }
const accessibleMethods: NonNullable<NativeSpec["methods"]> = {
  "static setAccessible([Ljava/lang/reflect/AccessibleObject;Z)V": (objects: JAccessibleObject[] | null, value: number) => {
    if (objects === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
    for (const object of objects) {
      if (object === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      object.accessible = value ? 1 : 0;
    }
  },
  "setAccessible(Z)V": function (this: JAccessibleObject, value: number) { this.accessible = value ? 1 : 0; },
  "isAccessible()Z": function (this: JAccessibleObject) { return this.accessible; },
};
rt.register({ name: "java/lang/reflect/AccessibleObject", ctor: JAccessibleObject, methods: {
  ...accessibleMethods,
  "trySetAccessible()Z": function (this: JAccessibleObject) { this.accessible = 1; return 1; },
} });

/** Method's and Constructor's common superclass (API 26), whose platform methods they share */
class JExecutable extends JAccessibleObject {}
rt.register({ name: "java/lang/reflect/Executable", ctor: JExecutable, sup: "java/lang/reflect/AccessibleObject",
  ifaces: ["java/lang/reflect/Member", "java/lang/reflect/GenericDeclaration"] });
export class JMethod extends JExecutable {
  owner!: ClassInfo;
  name = "";
  desc = "";
  isStatic = false;
  mods = 0;   // access flags when the declaration is known (a dex method); else public [static]
  fn: ((...a: unknown[]) => unknown) | null = null;
}
export function mkMethod(owner: ClassInfo, name: string, desc: string, isStatic: boolean, fn: ((...a: unknown[]) => unknown) | null, mods = 0): JMethod {
  const m = new JMethod();
  m.owner = owner; m.name = name; m.desc = desc; m.isStatic = isStatic; m.fn = fn; m.mods = mods;
  return m;
}

/** the dex's per-parameter annotation sets, padded to the descriptor's parameter count: a dex
 *  records a list only up to the last annotated parameter, and callers index by position */
function paramAnnotations(owner: ClassInfo, name: string, desc: string) {
  const per = classAnno(owner).paramsByRef.get(name + desc) ?? [];
  const n = parseMethodDesc(desc).params.length;
  const out = [];
  for (let i = 0; i < n; i++) out.push(jarray((per[i] ?? []).filter((an) => an.visibility === 1).map((an) => mkAnnotation(an, owner.owner)), "Ljava/lang/annotation/Annotation;"));
  return jarray(out, "[Ljava/lang/annotation/Annotation;");
}

/** getAnnotation/isAnnotationPresent/getAnnotations/getDeclaredAnnotations over the receiver's own annotation list */
function annotatedElement<T extends { owner: ClassInfo }>(annosOf: (this: T) => EncAnnotation[]): NonNullable<NativeSpec["methods"]> {
  const all = function (this: T) { return jarray(annosOf.call(this).filter((an) => an.visibility === 1).map((an) => mkAnnotation(an, this.owner.owner)), "Ljava/lang/annotation/Annotation;"); };
  return {
    "getAnnotation(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;": function (this: T, cls: JClass) {
      const found = annosOf.call(this).find((an) => an.visibility === 1 && an.type === cls?.ci?.name && (this.owner.owner ?? rt).link(an.type) === cls.ci);
      return found ? mkAnnotation(found, this.owner.owner) : null;
    },
    "isAnnotationPresent(Ljava/lang/Class;)Z": function (this: T, cls: JClass) {
      return annosOf.call(this).some((an) => an.visibility === 1 && an.type === cls?.ci?.name && (this.owner.owner ?? rt).link(an.type) === cls.ci) ? 1 : 0;
    },
    "getAnnotations()[Ljava/lang/annotation/Annotation;": all,
    "getDeclaredAnnotations()[Ljava/lang/annotation/Annotation;": all,
  };
}

export class JField extends JAccessibleObject {
  owner!: ClassInfo;
  fname = "";
  desc = "";
  prop = "";        // mangled property (on instance or ctor)
  isStatic = false;
  flags = 0;        // the declaration's own access flags; serializers read transient/synthetic off them
}
/** A static read is also the class's first use: a constant that has not been initialized yet
 *  reads as undefined, which is the zero the caller then takes for the field's real value. */
const readField = driven(function* readField(this: JField, o: unknown): Gen {
  const p = rt.initClass(this.owner); if (p) yield p;
  return this.isStatic ? this.owner.ctor[this.prop] : (o as Record<string, unknown>)[this.prop];
});
const writeField = driven(function* writeField(this: JField, o: unknown, value: unknown, boxed = false): Gen<void> {
  const p = rt.initClass(this.owner); if (p) yield p;
  if (boxed) value = argFor(this.desc, value);
  if (this.isStatic) this.owner.ctor[this.prop] = value;
  else (o as Record<string, unknown>)[this.prop] = value;
});
function fieldFloat(value: number | bigint): number {
  if (typeof value === "number") return Math.fround(value);
  const magnitude = value < 0n ? -value : value;
  // Keep a sticky low bit before conversion to double so long-to-float cannot double-round.
  const rounded = magnitude > 0x1fffffffffffffn ? ((magnitude >> 12n) | BigInt((magnitude & 0xfffn) !== 0n)) << 12n : magnitude;
  return Math.fround(Number(value < 0n ? -rounded : rounded));
}
export function classFields(info: ClassInfo, name?: string): JField[] {
  const out: JField[] = [];
  const push = (fname: string, desc: string, isStatic: boolean, prop: string, flags = isStatic ? 0x9 : 0x1) => {
    const f = new JField();
    f.owner = info; f.fname = fname; f.desc = desc; f.isStatic = isStatic; f.prop = prop; f.flags = flags;
    out.push(f);
  };
  if (info.def && info.dex) {
    for (const [list, isStatic] of [[info.def.instanceFields, false], [info.def.staticFields, true]] as const) {
      for (const ef of list) {
        const fr = info.dex.field(ef.fieldIdx);
        if (name !== undefined && fr.name !== name) continue;
        push(fr.name, info.dex.type(fr.type), isStatic,
          isStatic ? info.staticFieldTable.get(fr.name + ":" + info.dex.type(fr.type))!
            : (info.fieldTable.get(fr.name) ?? mangleField(info.name, fr.name)), ef.flags);
        if (name !== undefined) return out;
      }
    }
  } else if (info.native) {
    // a native class's fields have the platform class's types and modifiers, or the types its
    // serialized fields declare; the rest are references
    const declared = new Map<string, { desc: string; flags: number }>(), platform = rt.classDefOf(info.name);
    if (platform) for (const ef of [...platform.def.instanceFields, ...platform.def.staticFields]) {
      const fr = platform.dex.field(ef.fieldIdx);
      declared.set(fr.name, { desc: platform.dex.type(fr.type), flags: ef.flags });
    }
    for (const f of rt.natives.get(info.name)?.serialization?.fields ?? []) if (!declared.has(f.name)) declared.set(f.name, { desc: f.desc, flags: 0x2 });
    const field = (jname: string, isStatic: boolean, prop: string) => {
      const d = declared.get(jname);
      push(jname, d?.desc ?? "Ljava/lang/Object;", isStatic, prop, d?.flags);
    };
    for (const [jname, prop] of info.fieldTable) {
      if (name !== undefined && jname !== name) continue;
      field(jname, false, prop);
      if (name !== undefined) return out;
    }
    for (const k of Object.getOwnPropertyNames(info.ctor)) {
      if (!k.startsWith("s$")) continue;
      const jname = k.slice(2);
      if (name !== undefined && jname !== name) continue;
      field(jname, true, k);
      if (name !== undefined) return out;
    }
  }
  return out;
}
rt.register({
  name: "java/lang/reflect/Field", ctor: JField,
  sup: "java/lang/reflect/AccessibleObject",
  ifaces: ["java/lang/reflect/AnnotatedElement", "java/lang/reflect/Member"],
  methods: {
    "getName()Ljava/lang/String;": function (this: JField) { return this.fname; },
    "getType()Ljava/lang/Class;": function (this: JField) { return classForDesc(this.desc, this.owner.owner); },
    "getGenericType()Ljava/lang/reflect/Type;": function (this: JField) {
      const s = signatureOf(classAnno(this.owner).fieldsByName.get(this.fname));
      return s ? parseTypeSig(s, { pos: 0 }, classScope(this.owner)) : classForDesc(this.desc, this.owner.owner);
    },
    "getModifiers()I": function (this: JField) { return this.flags; },
    // ART's field offset, which jdk.internal.misc.Unsafe.objectFieldOffset reads
    "getOffset()I": function (this: JField) { return Number(fieldOffset(this)); },
    "isSynthetic()Z": function (this: JField) { return (this.flags >> 12) & 1; },
    "isEnumConstant()Z": function (this: JField) { return (this.flags >> 14) & 1; },
    ...accessibleMethods,
    "getDeclaringClass()Ljava/lang/Class;": declaringClass,
    "get(Ljava/lang/Object;)Ljava/lang/Object;": driven(function* (this: JField, o: unknown): Gen {
      return boxReturn(this.desc, yield readField.call(this, o));
    }),
    "set(Ljava/lang/Object;Ljava/lang/Object;)V": function (this: JField, o: unknown, v: unknown) {
      return writeField.call(this, o, v, true);
    },
    ...Object.fromEntries((["Int I", "Long J", "Boolean Z", "Float F", "Double D", "Byte B", "Short S", "Char C"])
      .map((t) => [`get${t.slice(0, -2)}(Ljava/lang/Object;)${t.slice(-1)}`, readField])),
    ...Object.fromEntries(["Boolean Z", "Byte BSIJFD", "Char CIJFD", "Short SIJFD", "Int IJFD", "Long JFD", "Float FD", "Double D"].map((spec) => {
      const [name, targets] = spec.split(" ");
      return [`set${name}(Ljava/lang/Object;${targets[0]})V`, function (this: JField, o: unknown, value: number | bigint) {
        if (!this.isStatic) {
          if (o == null) rt.npe();
          if (!(this.owner.owner ?? rt).iof(o, this.owner.name)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Wrong field receiver");
        }
        if (this.desc.length !== 1 || !targets.includes(this.desc)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid primitive field conversion");
        return writeField.call(this, o, this.desc === "J" ? BigInt(value) : this.desc === "F" ? fieldFloat(value) : this.desc === "D" ? Number(value) : value);
      }];
    })),
    "toString()Ljava/lang/String;": function (this: JField) { return this.owner.name + "." + this.fname; },
    ...annotatedElement(function (this: JField) { return classAnno(this.owner).fieldsByName.get(this.fname) ?? []; }),
  },
});

// ── generic type model (ParameterizedType from dalvik.annotation.Signature)
class JPType extends JObj {
  raw: unknown = null;       // JClass
  args: unknown[] = [];      // Type[]
  key = "";                  // canonical string for equals/hashCode
}
rt.register({ name: "java/lang/reflect/ParameterizedType", ctor: class extends JObj {}, ifaces: ["java/lang/reflect/Type"] });
rt.register({
  name: "webdroid/PType", ctor: JPType, ifaces: ["java/lang/reflect/ParameterizedType", "java/lang/reflect/Type"],
  methods: {
    "getRawType()Ljava/lang/reflect/Type;": function (this: JPType) { return this.raw; },
    "getOwnerType()Ljava/lang/reflect/Type;": () => null,
    "getActualTypeArguments()[Ljava/lang/reflect/Type;": function (this: JPType) { return types(this.args); },
    ...typeEquality<JPType>(),
  },
});
class JTypeVar extends JObj { name = ""; key = ""; decl: unknown = null; bounds: unknown[] = []; }
class JWildcard extends JObj { upper: unknown[] = []; lower: unknown[] = []; key = ""; }
class JGenericArray extends JObj { component: unknown = null; key = ""; }
const typeKey = (a: any): string => a?.key ?? (a?.ci ? dotName(a.ci.name) : a?.primName ?? a?.arrDesc ?? "?");
const types = (a: unknown[]) => jarray(a.slice(), "Ljava/lang/reflect/Type;");
/** Type equality as java.lang.reflect defines it: a type variable is its name AND its generic declaration
 *  (List's E is not ArrayList's E — Gson's resolve keys a visited map by TypeVariable and would otherwise
 *  answer the second one unresolved), a parameterized type its raw type and arguments; `key` is the display text */
function typeEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof JTypeVar) return b instanceof JTypeVar && a.name === b.name && a.decl === b.decl;
  if (a instanceof JPType) return b instanceof JPType && a.raw === b.raw && a.args.length === b.args.length && a.args.every((x, i) => typeEquals(x, b.args[i]));
  if (a instanceof JGenericArray) return b instanceof JGenericArray && typeEquals(a.component, b.component);
  if (a instanceof JWildcard) return b instanceof JWildcard && a.upper.length === b.upper.length && a.lower.length === b.lower.length
    && a.upper.every((x, i) => typeEquals(x, b.upper[i])) && a.lower.every((x, i) => typeEquals(x, b.lower[i]));
  return false;
}
function typeEquality<T extends { key: string }>() {
  return {
    "toString()Ljava/lang/String;": function (this: T) { return this.key; },
    "hashCode()I": function (this: T) { return stringHash(this.key) ^ (this instanceof JTypeVar && this.decl ? idHash(this.decl) : 0); },
    "equals(Ljava/lang/Object;)Z": function (this: T, o: unknown) { return typeEquals(this, o) ? 1 : 0; },
  };
}
for (const n of ["java/lang/reflect/TypeVariable", "java/lang/reflect/WildcardType", "java/lang/reflect/GenericArrayType"]) rt.register({ name: n, ctor: class extends JObj {}, ifaces: ["java/lang/reflect/Type"] });
rt.register({
  name: "webdroid/TypeVar", ctor: JTypeVar, ifaces: ["java/lang/reflect/TypeVariable", "java/lang/reflect/Type"],
  methods: {
    "getName()Ljava/lang/String;": function (this: JTypeVar) { return this.name; },
    "getBounds()[Ljava/lang/reflect/Type;": function (this: JTypeVar) { return types(this.bounds.length ? this.bounds : [rt.classFor("java/lang/Object")]); },
    "getGenericDeclaration()Ljava/lang/reflect/GenericDeclaration;": function (this: JTypeVar) { return this.decl; },
    ...typeEquality<JTypeVar>(),
  },
});
rt.register({
  name: "webdroid/Wildcard", ctor: JWildcard, ifaces: ["java/lang/reflect/WildcardType", "java/lang/reflect/Type"],
  methods: {
    "getUpperBounds()[Ljava/lang/reflect/Type;": function (this: JWildcard) { return types(this.upper); },
    "getLowerBounds()[Ljava/lang/reflect/Type;": function (this: JWildcard) { return types(this.lower); },
    ...typeEquality<JWildcard>(),
  },
});
rt.register({
  name: "webdroid/GenericArray", ctor: JGenericArray, ifaces: ["java/lang/reflect/GenericArrayType", "java/lang/reflect/Type"],
  methods: {
    "getGenericComponentType()Ljava/lang/reflect/Type;": function (this: JGenericArray) { return this.component; },
    ...typeEquality<JGenericArray>(),
  },
});
/** The type variables a signature may name: those already declared (a class's, a method's own), so a
 *  reference resolves to the declared object — equality is name and declaration — and an undeclared
 *  name becomes a variable of `decl`, remembered for the next reference. */
interface TypeScope { decl: unknown; vars: JTypeVar[] }
/** parse one type signature at ref.pos: a JClass, or one of the generic Type objects above */
function parseTypeSig(s: string, ref: { pos: number }, scope: TypeScope = { decl: null, vars: [] }): unknown {
  const c = s[ref.pos];
  if (c === "L") {
    let name = "";
    ref.pos++;
    while (ref.pos < s.length && s[ref.pos] !== ";" && s[ref.pos] !== "<") name += s[ref.pos++];
    const args: unknown[] = [];
    if (s[ref.pos] === "<") {
      ref.pos++;
      while (s[ref.pos] !== ">") args.push(parseTypeSig(s, ref, scope));
      ref.pos++; // '>'
      // inner-class suffix ".Name" possible; skip to ';'
      while (ref.pos < s.length && s[ref.pos] !== ";") ref.pos++;
    }
    ref.pos++; // ';'
    if (!args.length) return rt.classFor(name);
    const t = new JPType();
    t.raw = rt.classFor(name);
    t.args = args;
    t.key = dotName(name) + "<" + args.map(typeKey).join(", ") + ">";
    return t;
  }
  if (c === "[") {
    ref.pos++;
    const el: any = parseTypeSig(s, ref, scope);
    if (el?.ci || el?.primName || el?.arrDesc) return rt.classFor("[" + (el.ci ? "L" + el.ci.name + ";" : el.arrDesc ?? PRIM_DESC[el.primName]));
    const g = new JGenericArray(); g.component = el; g.key = typeKey(el) + "[]";
    return g;
  }
  if (c === "T") {
    let name = "";
    ref.pos++;
    while (ref.pos < s.length && s[ref.pos] !== ";") name += s[ref.pos++];
    ref.pos++;
    const known = scope.vars.find((v) => v.name === name);
    if (known) return known;
    const v = Object.assign(new JTypeVar(), { name, key: name, decl: scope.decl });
    scope.vars.push(v);
    return v;
  }
  if (c === "+" || c === "-" || c === "*") {
    const w = new JWildcard();
    ref.pos++;
    const bound = c === "*" ? null : parseTypeSig(s, ref, scope);
    w.upper = [c === "+" ? bound : rt.classFor("java/lang/Object")];
    if (c === "-") w.lower = [bound];
    w.key = c === "*" ? "?" : (c === "+" ? "? extends " : "? super ") + typeKey(bound);
    return w;
  }
  ref.pos++; // primitive
  return rt.classFor(PRIM_NAME[c] ?? "int");
}
/** a member's dalvik.annotation.Signature, joined; null when the member is not generic */
function signatureOf(annos: EncAnnotation[] | undefined): string | null {
  const sig = annos?.find((a) => a.type === "dalvik/annotation/Signature");
  if (!sig) return null;
  const parts = sig.elements["value"];
  return Array.isArray(parts) ? parts.join("") : String(parts ?? "");
}
/** skip a leading <type parameters> block */
function skipTypeParams(s: string): number {
  let pos = 0;
  if (s[0] === "<") { let d = 0; while (pos < s.length) { if (s[pos] === "<") d++; else if (s[pos] === ">") d--; pos++; if (!d) break; } }
  return pos;
}
/** the generic parameter and return types of a method, falling back to its erased descriptor.
 *  A signature that lists fewer parameters than the descriptor (synthetic outer/mask params)
 *  answers with the erased list, which is what ART does too. */
function genericMethodTypes(owner: ClassInfo, name: string, desc: string): { params: unknown[]; ret: unknown } {
  const erased = () => ({ params: parseMethodDesc(desc).params.map((d) => classForDesc(d, owner.owner)), ret: classForDesc(parseMethodDesc(desc).ret, owner.owner) });
  const s = signatureOf(classAnno(owner).methodsByRef.get(name + desc));
  if (!s) return erased();
  // the method's own type parameters come first, then the class's
  const scope = classScope(owner);
  scope.vars.unshift(...declaredTypeVars(s, { pos: 0 }, { decl: null, vars: [] }));
  const ref = { pos: skipTypeParams(s) + 1 }; // past '('
  const params: unknown[] = [];
  while (ref.pos < s.length && s[ref.pos] !== ")") params.push(parseTypeSig(s, ref, scope));
  ref.pos++;
  if (params.length !== parseMethodDesc(desc).params.length) return erased();
  return { params, ret: parseTypeSig(s, ref, scope) };
}
/** a scope naming the class's own type variables (a copy: references must not grow the class's list) */
const classScope = (info: ClassInfo): TypeScope => ({ decl: (info.owner ?? rt).classFor(info.name), vars: [...typeVarsOf(info)] });
/** the `<A:bound;B::iface;>` prefix of a signature at ref.pos, as declared variables of scope.decl */
function declaredTypeVars(sig: string, ref: { pos: number }, scope: TypeScope): JTypeVar[] {
  const vars: JTypeVar[] = [];
  if (sig[ref.pos] !== "<") return vars;
  ref.pos++;
  while (ref.pos < sig.length && sig[ref.pos] !== ">") {
    let name = "";
    while (ref.pos < sig.length && sig[ref.pos] !== ":") name += sig[ref.pos++];
    const v = scope.vars.find((x) => x.name === name) ?? (() => { const n = Object.assign(new JTypeVar(), { name, key: name, decl: scope.decl }); scope.vars.push(n); return n; })();
    vars.push(v);
    while (sig[ref.pos] === ":") {
      ref.pos++;
      if (sig[ref.pos] !== ":" && sig[ref.pos] !== ">") v.bounds.push(parseTypeSig(sig, ref, scope));
    }
  }
  ref.pos++;
  return vars;
}

/** an array of `len` elements whose component type is `cls` — what both
 *  java.lang.reflect.Array.newInstance and VMRuntime.newUnpaddedArray hand back */
function newArrayOf(cls: JClass | null, len: number): unknown {
  if (len < 0) throw rt.mkThrowable("java/lang/NegativeArraySizeException", String(len));
  const elem = elemDescOf(cls);
  if (elem === "V") throw rt.mkThrowable("java/lang/IllegalArgumentException", "Can't allocate an array of void");
  return elem in PRIM_ARRAYS ? new PRIM_ARRAYS[elem as PrimElem](len) : rt.oa(len, elem);
}

/** the element descriptor an array of `cls` carries (an array class's arrDesc is already a full
 *  descriptor); the outer levels of a multi-dim array prefix it with '[' */
function elemDescOf(cls: JClass | null): string {
  const prim = cls?.primName;
  return prim && PRIM_DESC[prim] ? PRIM_DESC[prim] : cls?.arrDesc ?? (cls?.ci ? "L" + cls.ci.name + ";" : "Ljava/lang/Object;");
}
function newMultiArray(cls: JClass | null, dims: Int32Array, i: number): unknown {
  if (i === dims.length - 1) return newArrayOf(cls, dims[i]);
  const a = rt.oa(dims[i], "[".repeat(dims.length - 1 - i) + elemDescOf(cls)) as unknown[];
  for (let k = 0; k < a.length; k++) a[k] = newMultiArray(cls, dims, i + 1);
  return a;
}
// libcore's Array boxes, unboxes and checks in Java; ART allocates its arrays
rt.registerJnis("java/lang/reflect/Array", {
  "createObjectArray(Ljava/lang/Class;I)Ljava/lang/Object;": newArrayOf,
  "createMultiArray(Ljava/lang/Class;[I)Ljava/lang/Object;": (cls: JClass | null, dims: Int32Array) => newMultiArray(cls, dims, 0),
});

// ── dalvik.system.VMRuntime: the allocator libcore and the framework grow arrays through.
// ArrayUtils.newUnpaddedObjectArray and every growable collection in android.util reach it, so
// it is the first thing framework bytecode wants that has nothing to do with the framework.
// "Unpadded" is a request for the slack a real heap has at the end of a block; there is no such
// slack here, so the array is exactly the length asked for — which the contract allows.
class JVMRuntime extends JObj {}
const theVmRuntime = new JVMRuntime();
/** the app's targetSdkVersion as ActivityThread binds it; ART's default is the development SDK */
let targetSdk = 10000;
export const setTargetSdkVersion = (version: number) => { targetSdk = version; };
rt.register({
  name: "dalvik/system/VMRuntime", ctor: JVMRuntime,
  methods: {
    "static getRuntime()Ldalvik/system/VMRuntime;": () => theVmRuntime,
    "newUnpaddedArray(Ljava/lang/Class;I)Ljava/lang/Object;": newArrayOf,
    "newNonMovableArray(Ljava/lang/Class;I)Ljava/lang/Object;": (cls: JClass | null, len: number) =>
      len >= 0 && elemDescOf(cls) === "B" ? nonMovableBytes(len) : newArrayOf(cls, len),
    // a byte[] in guest memory is at its address there; another non-movable array's address is
    // the handle JNI implementations dereference it by
    "addressOf(Ljava/lang/Object;)J": (array: object) =>
      array instanceof Int8Array && array.buffer === mem.buf ? BigInt(mem.va(array.byteOffset)) : handle(array),
    "getTargetSdkVersion()I": () => targetSdk,
    "setTargetSdkVersion(I)V": setTargetSdkVersion,
    // ro.build.version.sdk
    "static getSdkVersionNative(I)I": () => device.sdk,
    // ART counts native bytes to pace its collections; the JS engine paces its own
    "registerNativeAllocation(J)V": () => {},
    "registerNativeFree(J)V": () => {},
    // no hidden-API policy is enforced here, so every exemption already holds and no access is reported
    "setHiddenApiExemptions([Ljava/lang/String;)V": () => {},
    "static setNonSdkApiUsageConsumer(Ljava/util/function/Consumer;)V": () => {},
    "static setDedupeHiddenApiWarnings(Z)V": () => {},
    "static setHiddenApiUsageLogger(Ldalvik/system/VMRuntime$HiddenApiUsageLogger;)V": () => {},
    "setHiddenApiAccessLogSamplingRate(I)V": () => {},
    // what System.<clinit> reads of the runtime: the zygote's class paths, ART's version, and the
    // -D options AndroidRuntime starts it with (the locale from persist.sys.locale)
    "bootClassPath()Ljava/lang/String;": () => BOOT_JAR_PATHS.join(":"),
    "classPath()Ljava/lang/String;": () => ".",
    "vmVersion()Ljava/lang/String;": () => "2.1.0",
    "properties()[Ljava/lang/String;": () => jarray([`user.locale=${device.locale}`], "Ljava/lang/String;"),
  },
});

// DDMS chunks go to an attached debugger, and ART drops them when none is (there never is here)
rt.registerJni("org/apache/harmony/dalvik/ddmc/DdmServer", "nativeSendChunk(I[BII)V", () => {});

// ── Unsafe: sun.misc's for kotlinx-coroutines' artificial stack frames, and jdk.internal.misc's for
// libcore's atomics, CAS loops and LockSupport. A realm is one thread, so every memory order is
// plain and a read-modify-write is a read then a write.
class JUnsafe extends JObj {}
const rawAddress = (address: bigint) => mem.txVa(BigInt.asUintN(64, address));
const unsafe = new JUnsafe();
const sunMethods: NativeSpec["methods"] = {
  "static getUnsafe()Lsun/misc/Unsafe;": () => unsafe,
  // raw memory is the process's native heap (sun.nio.fs passes paths through it)
  "allocateMemory(J)J": (size: bigint) => {
    if (size < 0n || size > 0x7fffffffn) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
    const p = mem.malloc(Number(size));
    if (!p) throw rt.mkThrowable("java/lang/OutOfMemoryError", null);
    return BigInt(mem.va(p));
  },
  "freeMemory(J)V": (address: bigint) => mem.free(rawAddress(address)),
  "putByte(JB)V": (address: bigint, value: number) => mem.st8(rawAddress(address), value),
  "setMemory(JJB)V": (address: bigint, bytes: bigint, value: number) => mem.memset(rawAddress(address), value, Number(bytes)),
  // NativeObject's struct accessors (sun.nio.ch's iovecs), with pointers as wide as the guest's
  "addressSize()I": () => 4,
  "pageSize()I": () => 4096,
  "getByte(J)B": (a: bigint) => mem.ld8s(rawAddress(a)),
  "getShort(J)S": (a: bigint) => mem.ld16s(rawAddress(a)),
  "getChar(J)C": (a: bigint) => mem.ld16u(rawAddress(a)),
  "getInt(J)I": (a: bigint) => mem.ld32(rawAddress(a)),
  "getLong(J)J": (a: bigint) => mem.ld64(rawAddress(a)),
  "getFloat(J)F": (a: bigint) => mem.ldf32(rawAddress(a)),
  "getDouble(J)D": (a: bigint) => mem.ldf64(rawAddress(a)),
  "putShort(JS)V": (a: bigint, v: number) => mem.st16(rawAddress(a), v),
  "putChar(JC)V": (a: bigint, v: number) => mem.st16(rawAddress(a), v),
  "putInt(JI)V": (a: bigint, v: number) => mem.st32(rawAddress(a), v),
  "putLong(JJ)V": (a: bigint, v: bigint) => mem.st64(rawAddress(a), v),
  "putFloat(JF)V": (a: bigint, v: number) => mem.stf32(rawAddress(a), v),
  "putDouble(JD)V": (a: bigint, v: number) => mem.stf64(rawAddress(a), v),
  "allocateInstance(Ljava/lang/Class;)Ljava/lang/Object;": driven(function* (cls: JClass): Gen {
    const info = cls.ci!;
    const p = rt.initClass(info); if (p) yield p;
    return new info.ctor();
  }),
  "objectFieldOffset(Ljava/lang/reflect/Field;)J": fieldOffset,
  "arrayBaseOffset(Ljava/lang/Class;)I": () => 0,
  "arrayIndexScale(Ljava/lang/Class;)I": arrayIndexScale,
  "getObject(Ljava/lang/Object;J)Ljava/lang/Object;": uGet,
  "getObjectVolatile(Ljava/lang/Object;J)Ljava/lang/Object;": uGet,
  "putObject(Ljava/lang/Object;JLjava/lang/Object;)V": uPut,
  "putObjectVolatile(Ljava/lang/Object;JLjava/lang/Object;)V": uPut,
  "putOrderedObject(Ljava/lang/Object;JLjava/lang/Object;)V": uPut,
  "compareAndSwapObject(Ljava/lang/Object;JLjava/lang/Object;Ljava/lang/Object;)Z": casRef,
  "compareAndSwapLong(Ljava/lang/Object;JJJ)Z": casLong,
  "compareAndSwapInt(Ljava/lang/Object;JII)Z": casInt,
  "getInt(Ljava/lang/Object;J)I": uGetInt,
  "putInt(Ljava/lang/Object;JI)V": uPutInt,
  "getLong(Ljava/lang/Object;J)J": uGetLong,
  "putLong(Ljava/lang/Object;JJ)V": uPutLong,
  ...Object.fromEntries(([
    ["Boolean", "Z", (v: DataView, at: number) => (v.getUint8(at) ? 1 : 0), (v: DataView, at: number, x: number) => v.setUint8(at, x ? 1 : 0)],
    ["Byte", "B", (v: DataView, at: number) => v.getInt8(at), (v: DataView, at: number, x: number) => v.setInt8(at, x)],
    ["Char", "C", (v: DataView, at: number) => v.getUint16(at, true), (v: DataView, at: number, x: number) => v.setUint16(at, x, true)],
    ["Short", "S", (v: DataView, at: number) => v.getInt16(at, true), (v: DataView, at: number, x: number) => v.setInt16(at, x, true)],
    ["Float", "F", (v: DataView, at: number) => v.getFloat32(at, true), (v: DataView, at: number, x: number) => v.setFloat32(at, x, true)],
    ["Double", "D", (v: DataView, at: number) => v.getFloat64(at, true), (v: DataView, at: number, x: number) => v.setFloat64(at, x, true)],
  ] as const).flatMap(([n, d, get, put]) => [
    [`get${n}(Ljava/lang/Object;J)${d}`, (o: any, off: bigint) => { const view = uView(o); if (view) return get(view, Number(off)); const v = uGet(o, off); return d === "Z" ? (v ? 1 : 0) : v ?? 0; }],
    [`put${n}(Ljava/lang/Object;J${d})V`, (o: any, off: bigint, v: number) => { const view = uView(o); if (view) put(view, Number(off), v); else uPut(o, off, v); }],
  ])),
  "getLongVolatile(Ljava/lang/Object;J)J": uGetLong,
  "getIntVolatile(Ljava/lang/Object;J)I": uGetInt,
  "putIntVolatile(Ljava/lang/Object;JI)V": uPutInt,
  "getAndAddInt(Ljava/lang/Object;JI)I": intRmw((a, b) => (a + b) | 0),
  "getAndAddLong(Ljava/lang/Object;JJ)J": longRmw((a, b) => BigInt.asIntN(64, a + b)),
  "getAndSetInt(Ljava/lang/Object;JI)I": intRmw((_, b) => b),
  "putLongVolatile(Ljava/lang/Object;JJ)V": uPutLong,
  "putOrderedLong(Ljava/lang/Object;JJ)V": uPutLong,
  "getAndSetObject(Ljava/lang/Object;JLjava/lang/Object;)Ljava/lang/Object;": getAndSetRef,
};
rt.register({ name: "sun/misc/Unsafe", ctor: JUnsafe, statics: { theUnsafe: unsafe }, methods: sunMethods });
// jdk.internal.misc.Unsafe keeps libcore's class for its statics and checked helpers. Its natives
// are sun.misc.Unsafe's operations under the JDK's names, where an object is a "Reference"; the
// accessors and read-modify-writes libcore composes from them (a getAndAdd is a volatile read and a
// weak CAS in a loop, three frames each) are single operations here.
{
  const O = "Ljava/lang/Object;", fence = () => {};
  const jdk: Record<string, unknown> = {
    "addressSize()I": () => 4, "pageSize()I": () => 4096,
    "fullFence()V": fence, "loadFence()V": fence, "storeFence()V": fence, "loadLoadFence()V": fence, "storeStoreFence()V": fence,
    "getAndAddInt(Ljava/lang/Object;JI)I": intRmw((a, b) => (a + b) | 0),
    "getAndSetInt(Ljava/lang/Object;JI)I": intRmw((_, b) => b),
    "getAndBitwiseAndInt(Ljava/lang/Object;JI)I": intRmw((a, b) => a & b),
    "getAndBitwiseOrInt(Ljava/lang/Object;JI)I": intRmw((a, b) => a | b),
    "getAndBitwiseXorInt(Ljava/lang/Object;JI)I": intRmw((a, b) => a ^ b),
    "getAndAddLong(Ljava/lang/Object;JJ)J": longRmw((a, b) => BigInt.asIntN(64, a + b)),
    "getAndSetLong(Ljava/lang/Object;JJ)J": longRmw((_, b) => b),
    [`getAndSetReference(${O}J${O})${O}`]: getAndSetRef, [`getAndSetObject(${O}J${O})${O}`]: getAndSetRef,
  };
  for (const sig of ["allocateInstance(Ljava/lang/Class;)Ljava/lang/Object;", "allocateMemory(J)J", "freeMemory(J)V", "putByte(JB)V",
    ...[["Boolean", "Z"], ["Byte", "B"], ["Char", "C"], ["Short", "S"], ["Float", "F"], ["Double", "D"]].flatMap(([n, d]) => [`get${n}(${O}J)${d}`, `put${n}(${O}J${d})V`])])
    jdk[sig] = sunMethods[sig];
  for (const n of ["compareAndSwapInt", "compareAndSetInt", "weakCompareAndSetInt"]) jdk[`${n}(${O}JII)Z`] = casInt;
  for (const n of ["compareAndSwapLong", "compareAndSetLong"]) jdk[`${n}(${O}JJJ)Z`] = casLong;
  for (const n of ["compareAndSwapObject", "compareAndSetObject", "compareAndSetReference", "weakCompareAndSetReference"]) jdk[`${n}(${O}J${O}${O})Z`] = casRef;
  for (const m of ["", "Acquire", "Opaque", "Volatile"]) {
    jdk[`getInt${m}(${O}J)I`] = uGetInt;
    jdk[`getLong${m}(${O}J)J`] = uGetLong;
    jdk[`getReference${m}(${O}J)${O}`] = uGet;
    if (m !== "Opaque") jdk[`getObject${m}(${O}J)${O}`] = uGet;
  }
  for (const m of ["", "Release", "Opaque", "Volatile", "Ordered"]) {
    const put = m === "Ordered" ? "putOrdered" : "put", suffix = m === "Ordered" ? "" : m;
    jdk[`${put}Int${suffix}(${O}JI)V`] = uPutInt;
    jdk[`${put}Long${suffix}(${O}JJ)V`] = uPutLong;
    if (m !== "Ordered") jdk[`putReference${m}(${O}J${O})V`] = uPut;
    if (m !== "Opaque") jdk[`${put}Object${suffix}(${O}J${O})V`] = uPut;
  }
  rt.register({ name: "jdk/internal/misc/Unsafe", ctor: class extends JObj {}, platformClinit: true, methods: jdk as NativeSpec["methods"] });
  // private static natives, which only the class's own names reach
  rt.registerJnis("jdk/internal/misc/Unsafe", {
    "getArrayBaseOffsetForComponentType(Ljava/lang/Class;)I": () => 0,
    "getArrayIndexScaleForComponentType(Ljava/lang/Class;)I": (c: JClass) => arrayIndexScale(rt.classFor("[" + classDesc(c)) as JClass),
  });
}
// Unsafe "offsets" index this table of fields, with a stride of 8 so the word arithmetic
// protobuf's Android accessor applies to them (offset & ~3, (offset & 3) << 3) is an identity.
// An access wider or narrower than the field's own type moves the bits, as memory would: that
// same accessor reads a double as getLong and a float as getInt.
/** A field's accessors, compiled with its property name so each access stays monomorphic. An
 *  int or long access to a float or double field moves its bits. Reads of a field a TS object
 *  never set see its zero. */
interface UField {
  get(o: any): unknown; put(o: any, v: unknown): void;
  getInt(o: any): number; putInt(o: any, v: number): void;
  getLong(o: any): bigint; putLong(o: any, v: bigint): void;
}
const unsafeFields: UField[] = [];
const unsafeIndex = new Map<string, number>();
function fieldOffset(f: JField): bigint {
  let i = unsafeIndex.get(f.prop);
  if (i === undefined) {
    const at = `o[${JSON.stringify(f.prop)}]`, fl = f.desc === "F", db = f.desc === "D";
    i = unsafeFields.length;
    unsafeFields.push(new Function("F2I", "I2F", "D2L", "L2D", `return {
get(o){return ${at}},put(o,v){${at}=v},
getInt(o){return ${fl ? `F2I(${at}??0)` : `${at}??0`}},putInt(o,v){${at}=${fl ? "I2F(v)" : "v"}},
getLong(o){return ${db ? `D2L(${at}??0)` : `${at}??0n`}},putLong(o,v){${at}=${db ? "L2D(v)" : "v"}}}`)(
      floatToIntBits, intBitsToFloat, doubleToLongBits, longBitsToDouble));
    unsafeIndex.set(f.prop, i);
  }
  return BigInt(i * 8);
}
// Each operation converts its offset once, as the low word of a BigInt64Array store: in V8 that is
// about half the cost of Number(), which is most of an access's cost.
const offWord = new BigInt64Array(1), offLow = new Int32Array(offWord.buffer);
const low32 = (off: bigint) => { offWord[0] = off; return offLow[0]; };
const uField = (off: bigint) => unsafeFields[low32(off) >> 3];
/** a reference: an object array's element (4 bytes each), or a field */
function uGet(o: any, off: bigint): unknown {
  if (Array.isArray(o)) return o[low32(off) >> 2] ?? null;
  if (ArrayBuffer.isView(o)) return (o as any)[Number(off)] ?? null;
  return uField(off).get(o) ?? null;
}
function uPut(o: any, off: bigint, v: unknown): void {
  if (Array.isArray(o)) o[low32(off) >> 2] = v;
  else if (ArrayBuffer.isView(o)) (o as any)[Number(off)] = v;
  else uField(off).put(o, v);
}
const unsafeViews = new WeakMap<object, DataView>();
function uView(o: unknown): DataView | null {
  if (!ArrayBuffer.isView(o)) return null;
  let view = unsafeViews.get(o);
  if (!view) { view = new DataView(o.buffer, o.byteOffset, o.byteLength); unsafeViews.set(o, view); }
  return view;
}
function viewGetInt(o: ArrayBufferView, off: bigint): number {
  const view = uView(o)!, offset = Number(off);
  if (offset + 4 <= view.byteLength || offset < 0 || offset >= view.byteLength) return view.getInt32(offset, true);
  let value = 0;
  for (let i = 0; offset + i < view.byteLength; i++) value |= view.getUint8(offset + i) << (i * 8);
  return value | 0;
}
function viewPutInt(o: ArrayBufferView, off: bigint, value: number): void {
  const view = uView(o)!, offset = Number(off);
  if (offset + 4 <= view.byteLength || offset < 0 || offset >= view.byteLength) { view.setInt32(offset, value, true); return; }
  for (let i = 0; offset + i < view.byteLength; i++) view.setUint8(offset + i, value >>> (i * 8));
}
function uGetInt(o: any, off: bigint): number { return ArrayBuffer.isView(o) ? viewGetInt(o, off) : uField(off).getInt(o); }
function uPutInt(o: any, off: bigint, value: number): void {
  if (ArrayBuffer.isView(o)) viewPutInt(o, off, value); else uField(off).putInt(o, value);
}
function uGetLong(o: any, off: bigint): bigint { return ArrayBuffer.isView(o) ? uView(o)!.getBigInt64(Number(off), true) : uField(off).getLong(o); }
function uPutLong(o: any, off: bigint, value: bigint): void {
  if (ArrayBuffer.isView(o)) uView(o)!.setBigInt64(Number(off), value, true); else uField(off).putLong(o, value);
}
/** an int read-modify-write returning the old value */
function intRmw(op: (cur: number, x: number) => number) { return (o: any, off: bigint, x: number) => {
  if (ArrayBuffer.isView(o)) { const old = viewGetInt(o, off); viewPutInt(o, off, op(old, x)); return old; }
  const f = uField(off), old = f.getInt(o);
  f.putInt(o, op(old, x));
  return old;
}; }
function longRmw(op: (cur: bigint, x: bigint) => bigint) { return (o: any, off: bigint, x: bigint) => {
  if (ArrayBuffer.isView(o)) { const view = uView(o)!, at = Number(off), old = view.getBigInt64(at, true); view.setBigInt64(at, op(old, x), true); return old; }
  const f = uField(off), old = f.getLong(o);
  f.putLong(o, op(old, x));
  return old;
}; }
function casInt(o: any, off: bigint, exp: number, val: number): number {
  if (ArrayBuffer.isView(o)) { if (viewGetInt(o, off) !== exp) return 0; viewPutInt(o, off, val); return 1; }
  const f = uField(off);
  if (f.getInt(o) !== exp) return 0;
  f.putInt(o, val); return 1;
}
function casLong(o: any, off: bigint, exp: bigint, val: bigint): number {
  if (ArrayBuffer.isView(o)) { const view = uView(o)!, at = Number(off); if (view.getBigInt64(at, true) !== exp) return 0; view.setBigInt64(at, val, true); return 1; }
  const f = uField(off);
  if (f.getLong(o) !== exp) return 0;
  f.putLong(o, val); return 1;
}
function casRef(o: any, off: bigint, exp: unknown, val: unknown): number {
  if (Array.isArray(o)) {
    const i = low32(off) >> 2, cur = o[i];
    if (cur !== exp && !(cur === undefined && exp === null)) return 0;
    o[i] = val; return 1;
  }
  const f = uField(off), cur = f.get(o);
  if (cur !== exp && !(cur === undefined && exp === null)) return 0;
  f.put(o, val); return 1;
}
function getAndSetRef(o: any, off: bigint, v: unknown): unknown {
  if (Array.isArray(o)) { const i = low32(off) >> 2, old = o[i] ?? null; o[i] = v; return old; }
  const f = uField(off), old = f.get(o) ?? null;
  f.put(o, v); return old;
}
function arrayIndexScale(cls: JClass): number {
  return PRIM_ARRAYS[cls.arrDesc?.[1] as PrimElem]?.BYTES_PER_ELEMENT ?? 4;
}


const methodsCache = new WeakMap<ClassInfo, [JMethod[] | undefined, JMethod[] | undefined]>();
/** Class.getMethods (public, own and inherited) or, when declaredOnly, getDeclaredMethods */
export function classMethods(info: ClassInfo, declaredOnly: boolean): JMethod[] {
  let c = methodsCache.get(info);
  if (!c) methodsCache.set(info, (c = [undefined, undefined]));
  return (c[declaredOnly ? 1 : 0] ??= collectMethods(info, declaredOnly)).slice();
}
/** a platform body a native class could not run is not a method it has */
const runnable = (ci: ClassInfo, fn: unknown): fn is (...a: unknown[]) => unknown => typeof fn === "function" && !unsafeFallthrough(rt, ci, fn);
function collectMethods(info: ClassInfo, declaredOnly: boolean): JMethod[] {
  rt.ensureCompiled(info);
  const out: JMethod[] = [];
  const seen = new Set<string>();
  const collectNative = (ci: ClassInfo) => {
    const spec = rt.natives.get(ci.name);
    for (const key of Object.keys(spec?.methods ?? {})) {
      let k = key, isStatic = false;
      if (k.startsWith("static ")) { isStatic = true; k = k.slice(7); }
      const [name, desc] = splitSig(k);
      if (name === "<init>" || seen.has(name + desc)) continue;
      seen.add(name + desc);
      const mangled = mangleMethod(name, desc);
      const fn = isStatic ? ci.ctor[mangled] : ci.ctor.prototype[mangled];
      if (typeof fn === "function") out.push(mkMethod(ci, name, desc, isStatic, fn));
    }
    // methods installed outside the spec (Class's own reflection natives, generated members) are
    // known by the descriptors bytecode references them with
    for (const [k, desc] of rt.methodRefs(ci.name)) {
      const name = k.slice(0, k.length - desc.length);
      if (name === "<init>" || name === "<clinit>" || seen.has(k)) continue;
      const mangled = mangleMethod(name, desc);
      const fn = ci.ctor.prototype[mangled], sfn = ci.ctor[mangled];
      if (runnable(ci, fn)) { seen.add(k); out.push(mkMethod(ci, name, desc, false, fn)); }
      else if (runnable(ci, sfn)) { seen.add(k); out.push(mkMethod(ci, name, desc, true, sfn)); }
    }
  };
  const collect = (ci: ClassInfo) => {
    if (!ci.def || !ci.dex) { if (ci.native) collectNative(ci); return; }
    for (const m of [...ci.def.directMethods, ...ci.def.virtualMethods]) {
      const mr = ci.dex.method(m.methodIdx);
      if (mr.name === "<init>" || mr.name === "<clinit>") continue;
      const desc = ci.dex.methodDesc(m.methodIdx);
      const isStatic = (m.flags & 0x8) !== 0;
      const key = mr.name + desc;
      if (seen.has(key)) continue;
      seen.add(key);
      const mangled = mangleMethod(mr.name, desc);
      const fn = isStatic ? ci.ctor[mangled] : ci.ctor.prototype[mangled];
      out.push(mkMethod(ci, mr.name, desc, isStatic, typeof fn === "function" ? fn : null, m.flags));
    }
  };
  collect(info);
  if (!declaredOnly) {
    let sup = info.superInfo;
    while (sup) { rt.ensureCompiled(sup); collect(sup); sup = sup.superInfo; }
  }
  return out;
}

rt.register({
  name: "java/lang/reflect/Method", ctor: JMethod,
  sup: "java/lang/reflect/Executable",
  ifaces: ["java/lang/reflect/AnnotatedElement", "java/lang/reflect/Member", "java/lang/reflect/GenericDeclaration"],
  methods: {
    "getName()Ljava/lang/String;": function (this: JMethod) { return this.name; },
    "getTypeParameters()[Ljava/lang/reflect/TypeVariable;": noTypeVars,
    "getModifiers()I": function (this: JMethod) { return this.mods || (this.isStatic ? 0x8 : 0) | 0x1; },
    "isDefault()Z": function (this: JMethod) { return this.owner.isInterface && this.mods && !(this.mods & 0x400) ? 1 : 0; },
    "getDefaultValue()Ljava/lang/Object;": function (this: JMethod) {
      if (!this.owner.isInterface) return null;
      const defaults = annotationDefaults(this.owner);
      const val = defaults?.elements[this.name];
      const type = this.desc.slice(this.desc.indexOf(")") + 1);
      return val === undefined ? null : boxReturn(type, resolveEncVal(val, defaults!.dex, this.owner.owner ?? rt, type));
    },
    "getReturnType()Ljava/lang/Class;": function (this: JMethod) {
      return classForDesc(parseMethodDesc(this.desc).ret, this.owner.owner);
    },
    "getParameterCount()I": function (this: JMethod) { return parseMethodDesc(this.desc).params.length; },
    "getParameterTypes()[Ljava/lang/Class;": function (this: JMethod) { return paramClasses(this.desc, "Ljava/lang/Class;", this.owner.owner); },
    "getExceptionTypes()[Ljava/lang/Class;": function (this: JMethod) { return thrownTypes(this.owner, this.name, this.desc); },
    "getGenericParameterTypes()[Ljava/lang/reflect/Type;": function (this: JMethod) { return types(genericMethodTypes(this.owner, this.name, this.desc).params); },
    "getDeclaringClass()Ljava/lang/Class;": declaringClass,
    ...accessibleMethods,
    "isSynthetic()Z": function (this: JMethod) { return (this.mods >> 12) & 1; },
    "isBridge()Z": function (this: JMethod) { return (this.mods >> 6) & 1; },
    "isVarArgs()Z": function (this: JMethod) { return (this.mods >> 7) & 1; },
    "invoke(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;": driven(function* (this: JMethod, recv: unknown, args: unknown[] | null): Gen {
      const ps = parseMethodDesc(this.desc).params, a = (args ?? []).map((v, i) => argFor(ps[i], v));
      const target = this.isStatic ? this.fn : (recv as Record<string, unknown>)?.[mangleMethod(this.name, this.desc)] ?? lateMethod.find?.(recv, this.name, this.desc) ?? this.fn;
      if (typeof target !== "function") throw rt.mkThrowable("java/lang/NoSuchMethodError", `${this.owner.name}.${this.name}${this.desc}`);
      if (this.isStatic) { const init = rt.initClass(this.owner); if (init) yield init; }
      let val: unknown;
      try {
        const r = (target as (...x: unknown[]) => unknown).apply(this.isStatic ? this.owner.ctor : recv, a);
        val = r instanceof Promise ? yield r : r;
      } catch (e) { throw yield invocationTarget(e); }
      return boxReturn(parseMethodDesc(this.desc).ret, val);
    }),
    ...annotatedElement(function (this: JMethod) { return methodAnnotations(this.owner, this.name, this.desc); }),
    "getParameterAnnotations()[[Ljava/lang/annotation/Annotation;": function (this: JMethod) { return paramAnnotations(this.owner, this.name, this.desc); },
    "getGenericReturnType()Ljava/lang/reflect/Type;": function (this: JMethod) { return genericMethodTypes(this.owner, this.name, this.desc).ret; },
    // Java's own spelling, which a JNI caller parses for the name and parameter types
    "toString()Ljava/lang/String;": function (this: JMethod) {
      const { params, ret } = parseMethodDesc(this.desc);
      const mods = this.mods || (this.isStatic ? 0x9 : 0x1);
      const words = [[1, "public"], [4, "protected"], [2, "private"], [0x400, "abstract"], [8, "static"], [0x10, "final"], [0x20, "synchronized"], [0x100, "native"]] as const;
      return words.filter(([f]) => mods & f).map(([, w]) => w + " ").join("") + `${javaTypeName(ret)} ${dotName(this.owner.name)}.${this.name}(${params.map(javaTypeName).join(",")})`;
    },
    "equals(Ljava/lang/Object;)Z": function (this: JMethod, o: unknown) {
      return o instanceof JMethod && o.owner === this.owner && o.name === this.name && o.desc === this.desc ? 1 : 0;
    },
    "hashCode()I": function (this: JMethod) { return stringHash(this.name + this.desc); },
  },
});
/** Method.invoke and Constructor.newInstance report what the target threw inside this wrapper */
const invocationTarget = (e: unknown) => newObj("java/lang/reflect/InvocationTargetException", "(Ljava/lang/Throwable;)V", rt.jx(e));
// ── reflect Constructor. <init> mangles to i$<hash(desc)> with NO class component, so a
// ctor must always be invoked through the prototype of the class that DECLARES it.
export class JCtor extends JExecutable {
  owner!: ClassInfo;
  desc = "()V";
  flags = 1;
  /** a serialization constructor allocates this class and runs owner's constructor on it */
  alloc: ClassInfo | null = null;
}
const ctorCache = new WeakMap<ClassInfo, JCtor[]>();
/** constructors declared by this class (dex direct <init>s / native <init>(...) keys), memoized */
export function classCtors(info: ClassInfo): JCtor[] {
  const hit = ctorCache.get(info);
  if (hit) return hit;
  rt.ensureCompiled(info);
  const out: JCtor[] = [];
  const add = (desc: string, flags: number) => {
    const c = new JCtor(); c.owner = info; c.desc = desc; c.flags = flags; out.push(c);
  };
  if (info.def && info.dex) {
    for (const m of info.def.directMethods) {
      if (info.dex.method(m.methodIdx).name === "<init>") add(info.dex.methodDesc(m.methodIdx), m.flags);
    }
  } else if (info.native) {
    for (const key of Object.keys(rt.natives.get(info.name)?.methods ?? {})) {
      if (key.startsWith("<init>(")) add(key.slice(6), 1);
    }
  }
  ctorCache.set(info, out);
  return out;
}
rt.register({
  name: "java/lang/reflect/Constructor", ctor: JCtor,
  sup: "java/lang/reflect/Executable",
  ifaces: ["java/lang/reflect/AnnotatedElement", "java/lang/reflect/Member", "java/lang/reflect/GenericDeclaration"],
  methods: {
    "getName()Ljava/lang/String;": function (this: JCtor) { return dotName(this.owner.name); },
    "getTypeParameters()[Ljava/lang/reflect/TypeVariable;": noTypeVars,
    "getModifiers()I": function (this: JCtor) { return this.flags; },
    "getDeclaringClass()Ljava/lang/Class;": declaringClass,
    ...accessibleMethods,
    "isSynthetic()Z": () => 0,
    "isVarArgs()Z": function (this: JCtor) { return (this.flags & 0x80) ? 1 : 0; },
    "getParameterCount()I": function (this: JCtor) { return parseMethodDesc(this.desc).params.length; },
    "getParameterTypes()[Ljava/lang/Class;": function (this: JCtor) { return paramClasses(this.desc, "Ljava/lang/Class;", this.owner.owner); },
    "getExceptionTypes()[Ljava/lang/Class;": function (this: JCtor) { return thrownTypes(this.owner, "<init>", this.desc); },
    "getGenericParameterTypes()[Ljava/lang/reflect/Type;": function (this: JCtor) { return types(genericMethodTypes(this.owner, "<init>", this.desc).params); },
    "getParameterAnnotations()[[Ljava/lang/annotation/Annotation;": function (this: JCtor) { return paramAnnotations(this.owner, "<init>", this.desc); },
    ...annotatedElement(function (this: JCtor) { return classAnno(this.owner).methodsByRef.get("<init>" + this.desc) ?? []; }),
    // ObjectStreamClass: deserialization allocates the serializable class and runs its first
    // non-serializable superclass's constructor
    "serializationCopy(Ljava/lang/Class;Ljava/lang/Class;)Ljava/lang/reflect/Constructor;": function (this: JCtor, _ctor: JClass, cls: JClass) {
      const copy = Object.assign(new JCtor(), { owner: this.owner, desc: this.desc, flags: this.flags, alloc: cls.ci });
      return copy;
    },
    "newInstance([Ljava/lang/Object;)Ljava/lang/Object;": driven(function* (this: JCtor, args: unknown[] | null): Gen {
      const info = this.owner;
      // a serialization copy allocates its own class, which the allocation initializes
      for (const c of this.alloc ? [info, this.alloc] : [info]) { const p = rt.initClass(c); if (p) yield p; }
      const fn = info.ctor?.prototype?.[mangleMethod("<init>", this.desc)];
      if (typeof fn !== "function") throw rt.mkThrowable("java/lang/InstantiationException", dotName(info.name) + ".<init>" + this.desc);
      const ps = parseMethodDesc(this.desc).params;
      const a = (args ?? []).map((v, i) => argFor(ps[i], v));
      const o = new (this.alloc ?? info).ctor();
      try {
        const r = fn.apply(o, a);
        if (r instanceof Promise) yield r;
      } catch (e) { throw yield invocationTarget(e); }
      return o;
    }),
    "toString()Ljava/lang/String;": function (this: JCtor) { return this.owner.name + ".<init>" + this.desc; },
    "equals(Ljava/lang/Object;)Z": function (this: JCtor, o: unknown) {
      return o instanceof JCtor && o.owner === this.owner && o.desc === this.desc ? 1 : 0;
    },
    "hashCode()I": function (this: JCtor) { return stringHash(this.desc); },
  },
});

export function classForDesc(desc: string, runtime: Runtime = rt): unknown {
  if (desc[0] === "L") return runtime.classFor(descToName(desc));
  if (desc[0] === "[") return runtime.classFor(desc);
  return runtime.classFor(PRIM_NAME[desc] ?? "int");
}
function paramClasses(desc: string, elem: string, runtime: Runtime = rt) { return jarray(parseMethodDesc(desc).params.map((d) => classForDesc(d, runtime)), elem); }
function noTypeVars() { return jarray([], "Ljava/lang/reflect/TypeVariable;"); }

// ── a class's own generic model. A serializer resolving List<Foo> walks up to Collection<E> and
// asks who declared E, so the type variables and the parameterized supertypes have to be real.
const genericCache = new WeakMap<ClassInfo, { vars: JTypeVar[]; ifaces: unknown[]; sup: unknown }>();
/** the class signature javac emits, from the dex annotation or the native spec's declaration */
function typeVarsOf(info: ClassInfo): JTypeVar[] { return generics(info).vars; }
function mkPType(raw: unknown, args: unknown[]): JPType {
  const t = new JPType();
  t.raw = raw; t.args = args;
  t.key = typeKey(raw) + "<" + args.map(typeKey).join(", ") + ">";
  return t;
}
function generics(info: ClassInfo): { vars: JTypeVar[]; ifaces: unknown[]; sup: unknown } {
  let g = genericCache.get(info);
  if (g) return g;
  const cls = (info.owner ?? rt).classFor(info.name);
  const vars: JTypeVar[] = [];
  const ifaces: unknown[] = [];
  let sup: unknown = null;
  const sig = info.def ? signatureOf(classAnno(info).cls) : rt.natives.get(info.name)?.typeVars;
  if (info.def) {
    if (sig) {
      const ref = { pos: 0 }, scope: TypeScope = { decl: cls, vars };
      declaredTypeVars(sig, ref, scope);
      sup = parseTypeSig(sig, ref, scope);
      while (ref.pos < sig.length) ifaces.push(parseTypeSig(sig, ref, scope));
    }
  } else if (sig) {
    for (const name of sig.split(",")) vars.push(Object.assign(new JTypeVar(), { name, key: name, decl: cls, bounds: [] }));
  }
  // A native class states its variables only; each supertype takes as many of them as it declares.
  const apply = (i: ClassInfo) => {
    const n = typeVarsOf(i).length;
    const raw = (i.owner ?? rt).classFor(i.name);
    return n && n <= vars.length ? mkPType(raw, vars.slice(0, n)) : raw;
  };
  if (!ifaces.length) for (const i of info.interfaces) ifaces.push(apply(i));
  if (!sup) sup = info.superInfo ? apply(info.superInfo) : null;
  genericCache.set(info, (g = { vars, ifaces, sup }));
  return g;
}
export function unboxArg(v: unknown): unknown {
  // reflection passes boxed primitives; unwrap to raw for native/compiled calls
  const raw = unbox(v);
  return raw === undefined ? v : raw;
}
/** a reflective argument for a parameter of type `desc`: unboxed, then widened as Method.invoke
 *  does (an Integer reaches a long parameter as a long, a Long a double one as a double) */
function argFor(desc: string | undefined, v: unknown): unknown {
  if (!desc || !"IJFDZBCS".includes(desc)) return v;
  const raw = unboxArg(v);
  if (desc === "J") return typeof raw === "number" ? BigInt(raw) : raw;
  return typeof raw === "bigint" ? Number(raw) : raw;
}
export function boxReturn(retDesc: string, v: unknown): unknown {
  switch (retDesc[0]) {
    case "V": return null;
    case "I": case "J": case "F": case "D": case "Z": case "C": case "B": case "S": return box(retDesc[0] as BoxDesc, v as number | bigint);
    // native (TS) classes declare their fields as Object, so a primitive read through them
    // must still come back boxed
    default: return boxObject(v);
  }
}

// ── annotation instances: a JS object exposing element accessors as mangled methods
class JAnnotation extends JObj {
  anno!: EncAnnotation;
}
const annoProtoCache = new WeakMap<ClassInfo, object>();
export function mkAnnotation(anno: EncAnnotation, runtime: Runtime = rt): JAnnotation {
  const info = runtime.link(anno.type);
  const proto = buildAnnoProto(anno.type, info);
  const inst: JAnnotation = Object.create(proto);
  inst.anno = anno;
  installElements(inst, info, anno, runtime);
  return inst;
}
function installElements(target: object, info: ClassInfo, anno: EncAnnotation, runtime: Runtime = rt) {
  for (const [name, val] of Object.entries(anno.elements)) {
    const desc = elementDesc(info, name);
    const type = parseMethodDesc(desc).ret;
    const key = mangleMethod(name, desc);
    let resolved: unknown, ready = false;
    Reflect.set(target, key, () => {
      if (!ready) { resolved = resolveEncVal(val, anno.dex, runtime, type); ready = true; }
      return resolved;
    });
  }
}
function buildAnnoProto(type: string, info: ClassInfo): object {
  const cached = annoProtoCache.get(info);
  if (cached) return cached;
  // proto whose constructor.$i is the annotation interface, so R.iof / casts resolve
  const p: object = Object.create(JAnnotation.prototype);
  (p as any).constructor = { $i: info };
  (p as any)[mangleMethod("annotationType", "()Ljava/lang/Class;")] = () => (info.owner ?? rt).classFor(type);
  (p as any)[mangleMethod("toString", "()Ljava/lang/String;")] = () => "@" + dotName(type);
  // elements a use site omits answer the type's declared defaults: dalvik/annotation/AnnotationDefault
  // on the annotation interface carries, as `value`, an annotation with one element per default.
  // On the shared proto so instances only override what they name.
  const defaults = annotationDefaults(info);
  if (defaults) installElements(p, info, defaults, info.owner);
  annoProtoCache.set(info, p);
  return p;
}
/** find the return descriptor of annotation element `name` from the interface's abstract method */
function elementDesc(info: ClassInfo, name: string): string {
  if (info.def && info.dex) {
    for (const m of [...info.def.directMethods, ...info.def.virtualMethods]) {
      if (info.dex.method(m.methodIdx).name === name) return info.dex.methodDesc(m.methodIdx);
    }
  } else {
    // a TS annotation type's spec names its elements' descriptors
    for (const key of Object.keys(rt.natives.get(info.name)?.methods ?? {})) {
      const paren = key.indexOf("(");
      if (key.slice(0, paren) === name) return key.slice(paren);
    }
  }
  return "()Ljava/lang/String;"; // common default
}
function resolveEncVal(v: EncVal, dex: DexFile, runtime: Runtime, type?: string): unknown {
  if (Array.isArray(v)) {
    const values = v.map((x) => resolveEncVal(x, dex, runtime));
    const elem = type?.startsWith("[") ? type.slice(1) : "Ljava/lang/Object;";
    if (elem.length === 1 && elem in PRIM_ARRAYS) return (PRIM_ARRAYS[elem as PrimElem] as typeof Int32Array).from(values as number[]);
    return jarray(values, elem);
  }
  if (v !== null && typeof v === "object") {
    if (v.kind === "annotation") return mkAnnotation(v.anno, runtime);
    // an enum constant is a static of its class, which exists only once <clinit> has run;
    // compiled callers await a promise-valued element like any other call result
    if (v.kind === "enum") {
      const p = runtime.initClass(runtime.link(descToName(dex.type(dex.field(v.idx).cls))));
      if (p) return p.then(() => runtime.encToJs(dex, v));
    }
  }
  return runtime.encToJs(dex, v);
}

// ── core reflection marker interfaces: real classes (Method/Field/Class here, and any
// app-declared annotation type via its dex-listed `implements`) so `instanceof`/isInstance
// against them succeeds. Markers only — each concrete class supplies its own method bodies;
// these must be REGISTERED (not probed with rt.link first) because rt.link() on an unknown
// name auto-stubs it and files it as missing — there is nothing to "find" here, only to define.
for (const i of ["java/lang/reflect/AnnotatedElement",
  "java/lang/reflect/Member", "java/lang/reflect/Type", "java/lang/reflect/GenericDeclaration"]) {
  rt.register({ name: i, ctor: class extends JObj {} });
}

// Class.forName (and ClassLoader.loadClass, which delegates to it) is a by-NAME lookup,
// not a fixed dependency: the JVM contract is that the class may legitimately be absent
// and the caller must handle ClassNotFoundException. Probing for an optional component
// that way is a standard pattern, and the probe failing is the *correct* outcome — the
// caller then takes its own fallback path.
// Answering the lookup through rt.link() would auto-stub the name and file it in the
// missing-API queue as a framework API we owe an implementation for, which it is not:
// a name that is in no loaded dex and has no native is simply not a loadable class here,
// exactly as it would not be on a device that didn't ship it. So resolve the lookup
// against what is actually loadable and fail it ourselves, without linking.
function installForName(classCtor: unknown) {
  const loadable = (n: string): boolean => {
    // array classes are synthesised by link(), for a well-formed descriptor of a loadable element
    if (n[0] === "[") {
      const e = n.replace(/^\[+/, "");
      return e.length === 1 ? "ZBCSIJFD".includes(e) : e[0] === "L" && e.endsWith(";") && loadable(e.slice(1, -1));
    }
    const linked = rt.classes.get(n);
    if (linked) return !linked.stub;
    return rt.natives.has(n) || rt.dexIndex.has(n);
  };
  // synchronous unless loading or initialization suspends
  const forName = function (jn: string, initialize = 1, loader: unknown = null): JClass | Promise<JClass> {
    if (loader) return after(vcall(loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", jn) as JClass | Promise<JClass>,
      (c) => initialize && c.ci ? after(rt.initClass(c.ci), () => c) : c);
    const name = slashName(jn);
    if (!loadable(name)) throw rt.mkThrowable("java/lang/ClassNotFoundException", jn);
    return after(initialize ? rt.initClass(rt.link(name)) : null, () => rt.classFor(name) as JClass);
  };
  const c = classCtor as Record<string, unknown>;
  c[mangleMethod("forName", "(Ljava/lang/String;)Ljava/lang/Class;")] = (name: string, caller: Runtime = rt) => forName(name, 1, caller.classLoader);
  c[mangleMethod("forName", "(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;")] = forName;
}

// Class's reflective members, generic types and annotations, over real Method/Field/Constructor objects
function installClassReflection() {
  const proto = JClass.prototype as unknown as Record<string, unknown>;
  installForName(JClass);
  const M: Record<string, unknown> = {};
  M["getMethods()[Ljava/lang/reflect/Method;"] = function (this: JClass) {
    return jarray(this.ci ? classMethods(this.ci, false) : [], "Ljava/lang/reflect/Method;");
  };
  M["getGenericSuperclass()Ljava/lang/reflect/Type;"] = function (this: JClass) {
    return this.ci?.superInfo ? generics(this.ci).sup : null;
  };
  M["getGenericInterfaces()[Ljava/lang/reflect/Type;"] = function (this: JClass) {
    return types(this.ci ? generics(this.ci).ifaces : []);
  };
  M["getResourceAsStream(Ljava/lang/String;)Ljava/io/InputStream;"] = function (this: JClass, path: string) {
    // a relative name resolves against the class's own package
    const pkg = (this.ci?.name ?? "").split("/").slice(0, -1).join("/");
    return classpathStream(path.startsWith("/") ? path.slice(1) : (pkg ? pkg + "/" : "") + path, this.ci?.owner);
  };
  M["getEnclosingMethod()Ljava/lang/reflect/Method;"] = () => null;
  M["getPackage()Ljava/lang/Package;"] = function (this: JClass) {
    const n = this.ci?.name ?? "";
    return this.ci && n.includes("/") ? packageNamed(dotName(n.slice(0, n.lastIndexOf("/")))) : null;
  };
  M["getTypeParameters()[Ljava/lang/reflect/TypeVariable;"] = function (this: JClass) {
    return jarray(this.ci ? typeVarsOf(this.ci).slice() : [], "Ljava/lang/reflect/TypeVariable;");
  };
  M["getEnumConstants()[Ljava/lang/Object;"] = driven(function* (this: JClass): Gen {
    const info = this.ci;
    if (!info) return null;
    const p = rt.initClass(info); if (p) yield p;
    try { return yield vcall(info.ctor, "values", `()[L${info.name};`); } catch { return null; }
  });
  M["getDeclaringClass()Ljava/lang/Class;"] = enclosingClass;
  M["getEnclosingConstructor()Ljava/lang/reflect/Constructor;"] = () => null;
  M["getDeclaredField(Ljava/lang/String;)Ljava/lang/reflect/Field;"] = function (this: JClass, name: string) {
    const f = this.ci ? classFields(this.ci, name) : [];
    if (!f.length) throw rt.mkThrowable("java/lang/NoSuchFieldException", name);
    return f[0];
  };
  M["getField(Ljava/lang/String;)Ljava/lang/reflect/Field;"] = function (this: JClass, name: string) {
    for (let ci = this.ci; ci; ci = ci.superInfo) {
      const f = classFields(ci, name);
      if (f.length) return f[0];
    }
    throw rt.mkThrowable("java/lang/NoSuchFieldException", name);
  };
  M["getDeclaredFields()[Ljava/lang/reflect/Field;"] = function (this: JClass) {
    return jarray(this.ci ? classFields(this.ci) : [], "Ljava/lang/reflect/Field;");
  };
  M["getFields()[Ljava/lang/reflect/Field;"] = function (this: JClass) {
    const a: JField[] = [];
    for (let ci = this.ci; ci; ci = ci.superInfo) a.push(...classFields(ci));
    return jarray(a, "Ljava/lang/reflect/Field;");
  };
  // getConstructors and getConstructor see only public constructors; the declared forms see all
  const ctors = (c: JClass, declared: boolean) => (c.ci ? classCtors(c.ci) : []).filter((x) => declared || x.flags & 1);
  M["getConstructors()[Ljava/lang/reflect/Constructor;"] = function (this: JClass) { return jarray(ctors(this, false), "Ljava/lang/reflect/Constructor;"); };
  M["getDeclaredConstructors()[Ljava/lang/reflect/Constructor;"] = function (this: JClass) { return jarray(ctors(this, true), "Ljava/lang/reflect/Constructor;"); };
  const findCtor = (declared: boolean) => function (this: JClass, params: JClass[]) {
    const want = (params ?? []).map(classDesc).join("");
    const c = ctors(this, declared).find((x) => parseMethodDesc(x.desc).params.join("") === want);
    if (!c) throw rt.mkThrowable("java/lang/NoSuchMethodException", dotName(this.ci?.name ?? "?") + ".<init>(" + want + ")");
    return c;
  };
  M["getConstructor([Ljava/lang/Class;)Ljava/lang/reflect/Constructor;"] = findCtor(false);
  M["getDeclaredConstructor([Ljava/lang/Class;)Ljava/lang/reflect/Constructor;"] = findCtor(true);
  // real inner-class metadata lives in the dalvik.annotation.InnerClass system
  // annotation (accessFlags there carries STATIC, unlike class_def flags)
  const innerAnno = (ci: ClassInfo | null | undefined) =>
    ci?.def ? classAnno(ci).cls.find((x) => x.type === "dalvik/annotation/InnerClass") : undefined;
  M["getModifiers()I"] = function (this: JClass) {
    const ic = innerAnno(this.ci);
    const f = ic?.elements["accessFlags"];
    if (typeof f === "number") return f;
    return this.ci?.def?.flags ?? 1;
  };
  // ART's class-def flags, which getModifiers overrides with the InnerClass flags of a member
  M["getAccessFlags()I"] = function (this: JClass) { return this.ci?.def?.flags ?? this.ci?.flags ?? 1; };
  M["isMemberClass()Z"] = function (this: JClass) {
    const ic = innerAnno(this.ci);
    return ic && ic.elements["name"] != null ? 1 : 0;
  };
  // member classes are listed by the dalvik.annotation.MemberClasses system annotation
  M["getDeclaredClasses()[Ljava/lang/Class;"] = function (this: JClass) {
    const ci = this.ci, mc = ci?.def ? classAnno(ci).cls.find((x) => x.type === "dalvik/annotation/MemberClasses") : undefined;
    const v = mc?.elements["value"];
    const out = Array.isArray(v) ? v.map((e) => (e && typeof e === "object" && "idx" in e ? (ci!.owner ?? rt).classFor(descToName(ci!.dex!.type(e.idx))) : null)).filter(Boolean) : [];
    return jarray(out, "Ljava/lang/Class;");
  };
  // the public member classes of this class and its superclasses
  M["getClasses()[Ljava/lang/Class;"] = function (this: JClass) {
    const out: JClass[] = [];
    for (let ci = this.ci; ci; ci = ci.superInfo) {
      for (const member of (M["getDeclaredClasses()[Ljava/lang/Class;"] as (this: JClass) => JClass[]).call((ci.owner ?? rt).classFor(ci.name)))
        if (vcall(member, "getModifiers", "()I") & 1) out.push(member);
    }
    return jarray(out, "Ljava/lang/Class;");
  };
  M["getDeclaredMethods()[Ljava/lang/reflect/Method;"] = function (this: JClass) {
    return jarray(this.ci ? classMethods(this.ci, true) : [], "Ljava/lang/reflect/Method;");
  };
  const findMethod = (declaredOnly: boolean) => function (this: JClass, name: string, params: JClass[]) {
    const wantParams = (params ?? []).map((c) => classDesc(c)).join("");
    const m = (this.ci ? classMethods(this.ci, declaredOnly) : []).find((mm) => mm.name === name && parseMethodDesc(mm.desc).params.join("") === wantParams);
    if (!m) throw rt.mkThrowable("java/lang/NoSuchMethodException", name);
    return m;
  };
  M["getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;"] = findMethod(false);
  M["getDeclaredMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;"] = findMethod(true);
  const annotations = (info: ClassInfo) => {
    const out: { annotation: EncAnnotation; runtime: Runtime }[] = [];
    const seen = new Set<string>();
    for (let current: ClassInfo | null = info; current; current = current.superInfo) {
      const runtime = current.owner ?? rt;
      for (const annotation of classAnno(current).cls) {
        if (annotation.visibility !== 1 || seen.has(annotation.type)) continue;
        if (current !== info && !classAnno(runtime.link(annotation.type)).cls.some((meta) => meta.type === "java/lang/annotation/Inherited")) continue;
        seen.add(annotation.type);
        out.push({ annotation, runtime });
      }
    }
    return out;
  };
  M["getAnnotation(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;"] = function (this: JClass, cls: JClass) {
    if (!this.ci) return null;
    const found = annotations(this.ci).find(({ annotation, runtime }) => annotation.type === cls?.ci?.name && runtime.link(annotation.type) === cls.ci);
    return found ? mkAnnotation(found.annotation, found.runtime) : null;
  };
  M["isAnnotationPresent(Ljava/lang/Class;)Z"] = function (this: JClass, cls: JClass) {
    if (!this.ci) return 0;
    return annotations(this.ci).some(({ annotation, runtime }) => annotation.type === cls?.ci?.name && runtime.link(annotation.type) === cls.ci) ? 1 : 0;
  };
  M["getAnnotations()[Ljava/lang/annotation/Annotation;"] = function (this: JClass) {
    return jarray(this.ci ? annotations(this.ci).map(({ annotation, runtime }) => mkAnnotation(annotation, runtime)) : [], "Ljava/lang/annotation/Annotation;");
  };
  M["getDeclaredAnnotations()[Ljava/lang/annotation/Annotation;"] = function (this: JClass) {
    return jarray(this.ci ? classAnno(this.ci).cls.filter((an) => an.visibility === 1).map((an) => mkAnnotation(an, this.ci!.owner)) : [], "Ljava/lang/annotation/Annotation;");
  };
  // attach with proper mangled keys onto the live prototype
  for (const [sig, fn] of Object.entries(M)) {
    proto[mangleMethod(...splitSig(sig))] = fn;
  }
}
export function classDesc(c: JClass): string {
  if (c?.primName) return PRIM_DESC[c.primName] ?? "I";
  if (c?.arrDesc) return c.arrDesc;
  return c?.ci ? "L" + c.ci.name + ";" : "Ljava/lang/Object;";
}
// link Method and Constructor now so their prototypes carry the native methods
rt.link("java/lang/reflect/Method");
rt.link("java/lang/reflect/Constructor");
rt.link("java/lang/reflect/Field");
installClassReflection();

// ── java.lang.reflect.Proxy: one synthetic class per interface set. Every interface method, and
// Object's equals/hashCode/toString which Java routes the same way, boxes its arguments into the
// InvocationHandler and unboxes what comes back.
rt.markers("java/lang/reflect/InvocationHandler");
class JProxy extends JObj { h: unknown = null; }
const proxyClasses = new Map<string, ClassInfo>();
let nextProxyId = 0;
const D_INVOKE = "(Ljava/lang/Object;Ljava/lang/reflect/Method;[Ljava/lang/Object;)Ljava/lang/Object;";
type Decl = [ClassInfo, string, string, number];
/** what an interface declares, as the proxy sees it: bytecode when there is any, else the
 *  hand-written spec plus the app's own references plus the platform's declaration of the same name */
function interfaceMethods(ci: ClassInfo, out: Map<string, Decl>): void {
  if (ci.def && ci.dex) {
    for (const m of ci.def.virtualMethods) { const n = ci.dex.method(m.methodIdx).name, d = ci.dex.methodDesc(m.methodIdx); out.set(n + d, [ci, n, d, m.flags]); }
    for (const i of ci.interfaces) interfaceMethods(i, out);
    return;
  }
  for (const k of Object.keys(rt.natives.get(ci.name)?.methods ?? {})) if (!k.startsWith("static ")) out.set(k, [ci, ...splitSig(k), 0x401]);
  for (const [k, d] of rt.methodRefs(ci.name)) out.set(k, [ci, k.slice(0, k.length - d.length), d, 0x401]);
  const decl = rt.classDefOf(ci.name);
  if (decl) {
    const { dex, def } = decl;
    for (const m of def.virtualMethods) { const n = dex.method(m.methodIdx).name, d = dex.methodDesc(m.methodIdx); out.set(n + d, [ci, n, d, m.flags]); }
    for (const t of def.interfaces) interfaceMethods(rt.link(descToName(dex.type(t))), out);
  }
  for (const i of ci.interfaces) interfaceMethods(i, out);
}
function proxyMethod(info: ClassInfo, owner: ClassInfo, n: string, desc: string, mods: number): (...a: unknown[]) => unknown {
  const { params, ret } = parseMethodDesc(desc), method = mkMethod(owner, n, desc, false, () => null, mods);
  const fn = async function (this: JProxy, ...args: unknown[]) {
    const r = await vcall(this.h, "invoke", D_INVOKE, this, method, jarray(args.map((a, i) => boxReturn(params[i], a)), "Ljava/lang/Object;"));
    return ret === "V" ? undefined : ret[0] === "L" || ret[0] === "[" ? r : unboxArg(r);
  };
  info.ctor.prototype[mangleMethod(n, desc)] = fn;
  return fn;
}
const proxyIfaces = new WeakMap<ClassInfo, ClassInfo[]>();
/** one class per interface set: a proxy over the same interfaces shares it */
function proxyClass(ifaces: ClassInfo[]): ClassInfo {
  const key = ifaces.map((i) => i.name).join(";");
  const cached = proxyClasses.get(key);
  if (cached) return cached;
  const name = "java/lang/reflect/$Proxy" + nextProxyId++;
  rt.register({ name, ctor: class extends JProxy {}, ifaces: ifaces.map((i) => i.name) });
  const info = rt.link(name);
  proxyIfaces.set(info, ifaces);
  const methods = new Map<string, Decl>();
  const object = rt.link("java/lang/Object");
  for (const [n, d] of [["equals", "(Ljava/lang/Object;)Z"], ["hashCode", "()I"], ["toString", "()Ljava/lang/String;"]]) methods.set(n + d, [object, n, d, 0x1]);
  for (const i of ifaces) interfaceMethods(i, methods);
  for (const [owner, n, desc, mods] of methods.values()) proxyMethod(info, owner, n, desc, mods);
  proxyClasses.set(key, info);
  return info;
}
// a method no declaration named: the first call names it, and the proxy materialises it then,
// owned by the interface that declares it if any of them does, else the first
lateMethod.find = (obj, n, desc) => {
  if (!(obj instanceof JProxy)) return undefined;
  const info = (obj.constructor as { $i?: ClassInfo }).$i ?? rt.link("java/lang/Object");
  const ifaces = proxyIfaces.get(info) ?? [];
  if (!ifaces.length) return undefined;
  const owner = ifaces.find((i) => { const m = new Map<string, Decl>(); interfaceMethods(i, m); return m.has(n + desc); }) ?? ifaces[0];
  return proxyMethod(info, owner, n, desc, 0x401);
};
rt.register({
  name: "java/lang/reflect/Proxy", ctor: JProxy,
  methods: {
    "static newProxyInstance(Ljava/lang/ClassLoader;[Ljava/lang/Class;Ljava/lang/reflect/InvocationHandler;)Ljava/lang/Object;": (_l: unknown, ifaces: JClass[], h: unknown) => {
      const p = new (proxyClass(ifaces.map((c) => c.ci!)).ctor)() as JProxy;
      p.h = h;
      return p;
    },
    "static getProxyClass(Ljava/lang/ClassLoader;[Ljava/lang/Class;)Ljava/lang/Class;": (_l: unknown, ifaces: JClass[]) => rt.classFor(proxyClass(ifaces.map((c) => c.ci!)).name),
    "static isProxyClass(Ljava/lang/Class;)Z": (c: JClass) => (c.ci?.ctor.prototype instanceof JProxy ? 1 : 0),
    "static getInvocationHandler(Ljava/lang/Object;)Ljava/lang/reflect/InvocationHandler;": (o: unknown) => (o instanceof JProxy ? o.h : null),
  },
});
