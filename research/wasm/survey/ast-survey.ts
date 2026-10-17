// Type-checker-backed survey of Java-object coupling. Run: node research/wasm/survey/ast-survey.ts
// Writes research/wasm/survey/out/ast.json. Static only (no execution of webdroid code).
import ts from "typescript";
import { mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from "fs";
import { join, relative } from "path";

const ROOT = join(import.meta.dirname, "../../..");
const SCOPES: Record<string, string> = {
  "jvm/natives": "src/jvm/natives", "jvm/core": "src/jvm", android: "src/android",
  native: "src/native", shell: "src/shell", "src/top": "src",
};
const walk = (d: string, out: string[] = []): string[] => {
  for (const n of readdirSync(d)) {
    const p = join(d, n); const s = statSync(p);
    if (s.isDirectory()) { if (n !== "node_modules" && n !== "fixtures" && n !== "webpage") walk(p, out); }
    else if (/\.ts$/.test(n) && !/\.test\.ts$|testkit|\.d\.ts$|oracle\.cases/.test(n)) out.push(p);
  }
  return out;
};
const scopeOf = (rel: string) =>
  rel.startsWith("src/jvm/natives/") ? "jvm/natives" : rel.startsWith("src/jvm/") ? "jvm/core" :
  rel.startsWith("src/android/") ? "android" : rel.startsWith("src/native/") ? "native" :
  rel.startsWith("src/shell/") ? "shell" : "src/top";
const files = walk(join(ROOT, "src"));
const cfg = ts.getParsedCommandLineOfConfigFile(join(ROOT, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!;
const program = ts.createProgram({ rootNames: files, options: cfg.options });
const tc = program.getTypeChecker();

// ---- Java-type test: class (transitively) extending JObj
const javaSym = new Map<ts.Symbol, boolean>();
function symIsJava(s: ts.Symbol | undefined, depth = 0): boolean {
  if (!s || depth > 12) return false;
  if (javaSym.has(s)) return javaSym.get(s)!;
  javaSym.set(s, false);
  let r = s.name === "JObj";
  if (!r) for (const d of s.declarations ?? []) {
    if ((ts.isClassDeclaration(d) || ts.isClassExpression(d)) && d.heritageClauses) for (const h of d.heritageClauses) if (h.token === ts.SyntaxKind.ExtendsKeyword)
      for (const t of h.types) { const bt = tc.getTypeAtLocation(t.expression); if (symIsJava(bt.symbol, depth + 1)) r = true; }
  }
  javaSym.set(s, r); return r;
}
const parts = (t: ts.Type): ts.Type[] => t.isUnion() ? t.types : t.isIntersection() ? t.types : [t];
const isAny = (t: ts.Type) => (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
const isJava = (t: ts.Type) => parts(t).some((p) => symIsJava(p.getSymbol() ?? p.aliasSymbol));
const PRIMF = ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.StringLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never | ts.TypeFlags.EnumLike;
const isPrimT = (t: ts.Type) => parts(t).every((p) => (p.flags & PRIMF) !== 0);
const isObjectish = (t: ts.Type) => parts(t).some((p) => (p.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) !== 0 || isAny(p));
const TA = /^(Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|Float32|Float64|BigInt64|BigUint64)Array$/;
const isTyped = (t: ts.Type) => parts(t).some((p) => TA.test(p.getSymbol()?.name ?? ""));
const isStr = (t: ts.Type) => parts(t).some((p) => (p.flags & ts.TypeFlags.StringLike) !== 0);
const isBig = (t: ts.Type) => parts(t).some((p) => (p.flags & ts.TypeFlags.BigIntLike) !== 0);
const isArr = (t: ts.Type) => parts(t).some((p) => tc.isArrayType(p) || tc.isTupleType(p));

const CALLS = new Set(["vcall", "vcallAsync", "vcallOn", "scall", "callOn", "newObj", "after", "staticField", "linkInit", "implement"]);
const HANDLE = new Set(["handle", "weakHandle", "ownedHandle", "take", "release"]);
const MAPS = new Set(["Map", "WeakMap", "Set", "WeakSet", "WeakRef", "FinalizationRegistry"]);
const REGS = new Set(["register", "registerJnis", "delegate", "registerJni", "intrinsic"]);
const ASSIGN = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]);

type Counts = Record<string, number>;
const newC = (): Counts => ({});
const inc = (c: Counts, k: string, n = 1) => { c[k] = (c[k] ?? 0) + n; };

function isWrite(n: ts.Node): boolean {
  const p = n.parent;
  if (ts.isBinaryExpression(p) && p.left === n && ASSIGN.has(p.operatorToken.kind)) return true;
  if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return true;
  return false;
}
function calleeName(e: ts.CallExpression): string | undefined {
  const c = e.expression;
  return ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : undefined;
}

/** site counts over a node subtree */
function sites(root: ts.Node, c: Counts, fnLocalThis?: ts.Type): void {
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n)) {
      const rt = tc.getTypeAtLocation(n.expression);
      const name = n.name.text;
      const sym = tc.getSymbolAtLocation(n.name);
      const decl = sym?.declarations?.[0];
      const isMethod = !!decl && (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl) || ts.isFunctionLike(decl) && !ts.isPropertyDeclaration(decl));
      if (name.startsWith("$")) inc(c, "dollarProp");
      if (name === "constructor") inc(c, "dotConstructor");
      if (name === "$i") inc(c, "dotI");
      if (name === "$t") inc(c, "dotT");
      if (isJava(rt) && decl && !isMethod && (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl) || ts.isParameter(decl) || ts.isGetAccessor(decl) || ts.isSetAccessor(decl)) && !ts.isCallExpression(n.parent) ) {
        const self = n.expression.kind === ts.SyntaxKind.ThisKeyword;
        inc(c, (self ? "fieldSelf" : "fieldOther") + (isWrite(n) ? "W" : "R"));
      } else if (isJava(rt) && isMethod && ts.isCallExpression(n.parent) && n.parent.expression === n) {
        inc(c, "tsMethodCallOnJava");
      } else if (isAny(rt) && n.expression.kind !== ts.SyntaxKind.ThisKeyword) {
        inc(c, "anyAccess" + (isWrite(n) ? "W" : "R"));
      }
    } else if (ts.isElementAccessExpression(n)) {
      const it = tc.getTypeAtLocation(n.argumentExpression);
      const rt = tc.getTypeAtLocation(n.expression);
      const numeric = (it.flags & ts.TypeFlags.NumberLike) !== 0;
      if (!numeric && (isStr(it) || isAny(it)) && (isJava(rt) || isAny(rt) || (rt.flags & ts.TypeFlags.Object && !isTyped(rt) && !isArr(rt) && !MAPS.has(rt.getSymbol()?.name ?? "")))) inc(c, "dynNameAccess" + (isWrite(n) ? "W" : "R"));
    } else if (ts.isCallExpression(n)) {
      const nm = calleeName(n);
      if (nm && CALLS.has(nm)) inc(c, "call_" + nm);
      if (nm && HANDLE.has(nm)) inc(c, "handleOp");
      if (nm === "deref") inc(c, "deref");
      if (nm === "driven") inc(c, "driven");
      if (nm === "csText") inc(c, "csText");
      if (nm === "jarray") inc(c, "jarray");
      if (nm && /^(mangle(Method|StaticField|Field)|lateMethod|setPublic|directName|xname)$/.test(nm)) inc(c, "mangleHelper");
      if (nm && /^(getDeclared|setDeclared|declaredField|fieldOf|instanceFieldOf)$/.test(nm)) inc(c, "declaredFieldHelper");
      if (nm === "getPrototypeOf" || nm === "setPrototypeOf" || nm === "defineProperty" && /prototype/.test(n.getText().slice(0, 120))) inc(c, "protoOps");
    } else if (ts.isYieldExpression(n)) { inc(c, n.asteriskToken ? "yieldStar" : "yield");
    } else if (ts.isFunctionLike(n) && (n as ts.FunctionLikeDeclaration).asteriskToken) { inc(c, "generatorFns");
    } else if (ts.isNewExpression(n)) {
      const nm = ts.isIdentifier(n.expression) ? n.expression.text : "";
      if (MAPS.has(nm)) {
        inc(c, "new_" + nm);
        const ta = n.typeArguments ?? [];
        const ty = tc.getTypeAtLocation(n);
        const args = (ty as any).typeArguments as ts.Type[] | undefined;
        const objs = (args ?? []).some((a) => isJava(a) || isAny(a) || ((a.flags & ts.TypeFlags.Object) !== 0 && !isTyped(a)));
        if (objs || ta.length === 0) inc(c, "retainerObjectish_" + nm);
        if ((args ?? []).some(isJava)) inc(c, "retainerJavaTyped_" + nm);
      }
      if (TA.test(nm)) inc(c, "new_typedArray");
    } else if (ts.isInstanceOfExpression?.(n) || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)) {
      const b = n as ts.BinaryExpression;
      const rt = tc.getTypeAtLocation(b.right);
      const sym = rt.getSymbol();
      const jc = (rt.getProperties().length >= 0) && (symIsJava(sym) || /^(J[A-Z]\w*|Native\w*)$/.test(sym?.name ?? "") && symIsJava(sym));
      inc(c, jc ? "instanceofJava" : "instanceofOther");
    } else if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind)) {
      const lt = tc.getTypeAtLocation(n.left), rt = tc.getTypeAtLocation(n.right);
      const nullish = (e: ts.Expression) => e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined");
      if (!nullish(n.left) && !nullish(n.right)) {
        if (isJava(lt) || isJava(rt)) inc(c, "identityJavaTyped");
        else if (!isPrimT(lt) && !isPrimT(rt) && !isAny(lt) && !isAny(rt)) inc(c, "identityObjTyped");
        else if ((isAny(lt) || isAny(rt)) && !isPrimT(lt) && !isPrimT(rt)) inc(c, "identityAnyBoth");
      }
    } else if (ts.isTypeOfExpression(n)) {
      if (ts.isBinaryExpression(n.parent) && /string/.test(n.parent.getText())) inc(c, "typeofStringTest");
    } else if (ts.isBigIntLiteral(n)) inc(c, "bigintLiteral");
    else if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      const s = n.name ? tc.getSymbolAtLocation(n.name) : undefined;
      const ty = n.name ? tc.getTypeAtLocation(n.name) : undefined;
      if (ty && isJava(ty)) {
        inc(c, "javaClasses");
        const members = (n as ts.ClassDeclaration).members;
        classes.push({ file: relative(ROOT, n.getSourceFile().fileName), name: n.name!.text, fields: members.filter((m) => ts.isPropertyDeclaration(m) && !m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword)).length, methods: members.filter((m) => ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)).length });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
}

// ---- per-file site counts + registration entries
function descCats(key: string): { shape: string; ret: string; isStatic: boolean } {
  const isStatic = key.startsWith("static ");
  const k = isStatic ? key.slice(7) : key;
  const i = k.indexOf("("), j = k.lastIndexOf(")");
  if (i < 0 || j < 0) return { shape: "?", ret: "?", isStatic };
  const d = k.slice(i + 1, j); let cats = new Set<string>(); let n = 0;
  const one = (t: string) => t === "J" ? "J" : "IZBSCFD".includes(t[0]) ? "P" : t === "Ljava/lang/String;" || t === "Ljava/lang/CharSequence;" ? "S" : t[0] === "[" ? (/^\[+[IZBSCFDJ]$/.test(t) && t.length === 2 ? "T" : "A") : "O";
  for (let x = 0; x < d.length;) { let st = x; while (d[x] === "[") x++; if (d[x] === "L") x = d.indexOf(";", x) + 1; else x++; cats.add(one(d.slice(st, x))); n++; }
  const r = k.slice(j + 1); const rc = r === "V" ? "V" : one(r);
  return { shape: [...cats].sort().join("") || "-", ret: rc, isStatic };
}
type Entry = { shape: string; dret: string; isStatic: boolean; file: string; kind: string; cls?: string; key: string; flags: string[]; params: number; paramCats: string[]; thisJava: boolean; usesThis: boolean; ret: string };
const perFile: Record<string, { loc: number; scope: string; c: Counts }> = {};
const entries: Entry[] = [];
const classes: { file: string; name: string; fields: number; methods: number }[] = [];
const regCalls: { file: string; kind: string; cls?: string; entries: number; spreads: number; line: number }[] = [];

function paramCat(t: ts.Type | undefined, annotated: boolean): string {
  if (!annotated || !t) return "U";
  if (isAny(t)) return "U";
  if (isJava(t)) return "O";
  if (isStr(t)) return "S";
  if (isTyped(t)) return "T";
  if (isBig(t)) return "J";
  if (isArr(t)) return "A";
  if (isPrimT(t)) return "P";
  return "O";
}
function fnOf(init: ts.Node | undefined, depth = 0): ts.FunctionLikeDeclaration | undefined {
  if (!init || depth > 4) return undefined;
  if (ts.isFunctionExpression(init) || ts.isArrowFunction(init) || ts.isMethodDeclaration(init) || ts.isFunctionDeclaration(init)) return init;
  if (ts.isParenthesizedExpression(init)) return fnOf(init.expression, depth + 1);
  if (ts.isCallExpression(init)) { for (const a of init.arguments) { const f = fnOf(a, depth + 1); if (f) return f; } }
  if (ts.isIdentifier(init)) {
    const d = tc.getSymbolAtLocation(init)?.declarations?.[0];
    if (d && ts.isVariableDeclaration(d)) return fnOf(d.initializer, depth + 1);
    if (d && ts.isFunctionDeclaration(d)) return d;
  }
  return undefined;
}
function keyText(p: ts.PropertyName): string | undefined {
  if (ts.isStringLiteral(p) || ts.isNoSubstitutionTemplateLiteral(p) || ts.isIdentifier(p)) return p.text;
  return undefined;
}
function analyseEntry(sf: ts.SourceFile, rel: string, kind: string, cls: string | undefined, key: string, val: ts.Node) {
  const fn = fnOf(val);
  const flags = new Set<string>();
  let params: string[] = [], thisJava = false, usesThis = false, ret = "?";
  if (!fn) { flags.add(ts.isStringLiteral(val) ? "alias" : "unresolved"); }
  else {
    const c = newC();
    if (fn.body) sites(fn.body, c);
    const sig = tc.getSignatureFromDeclaration(fn);
    for (const p of fn.parameters) {
      if (ts.isIdentifier(p.name) && p.name.text === "this") { thisJava = isJava(tc.getTypeAtLocation(p)); continue; }
      params.push(paramCat(tc.getTypeAtLocation(p), !!p.type));
    }
    if (sig) { const rt = tc.getReturnTypeOfSignature(sig); ret = fn.type ? paramCat(rt, true) : "-"; if (/Promise|Generator/.test(tc.typeToString(rt))) ret = "G" + ret; }
    const bodyText = fn.body?.getText() ?? "";
    usesThis = /\bthis\b/.test(bodyText);
    if ((c.declaredFieldHelper ?? 0) + (c.fieldSelfR ?? 0) + (c.fieldSelfW ?? 0) + (c.fieldOtherR ?? 0) + (c.fieldOtherW ?? 0) + (c.dollarProp ?? 0) + (c.dynNameAccessR ?? 0) + (c.dynNameAccessW ?? 0) > 0) flags.add("F");
    if (Object.keys(c).some((k) => k.startsWith("call_") && k !== "call_after") || (c.yieldStar ?? 0) || (c.yield ?? 0) || (c.call_after ?? 0)) flags.add("C");
    if (Object.keys(c).some((k) => k.startsWith("retainer") || k.startsWith("new_Weak") || k.startsWith("new_Final")) || (c.handleOp ?? 0)) flags.add("R");
    if ((c.instanceofJava ?? 0) || (c.identityJavaTyped ?? 0) || (c.identityObjTyped ?? 0) || (c.dotConstructor ?? 0) || (c.dotI ?? 0) || (c.protoOps ?? 0)) flags.add("I");
    if ((c.anyAccessR ?? 0) + (c.anyAccessW ?? 0) > 0) flags.add("X"); // untyped (any) property access: Java field/method by unknown name
    if (c.csText || c.typeofStringTest) flags.add("S");
    if (c.jarray || c.dotT) flags.add("A");
    const pc = params.concat([ret]);
    if (pc.some((p) => /O/.test(p))) flags.add("O");
    if (pc.some((p) => /S/.test(p))) flags.add("S");
    if (pc.some((p) => /T|A/.test(p))) flags.add("A");
    if (pc.some((p) => /J/.test(p))) flags.add("L");
    if (pc.some((p) => /U/.test(p))) flags.add("U");
    if (thisJava) flags.add("Tj");
  }
  const dc = descCats(key);
  entries.push({ shape: dc.shape, dret: dc.ret, isStatic: dc.isStatic, file: rel, kind, cls, key, flags: [...flags], params: params.length, paramCats: params, thisJava, usesThis, ret });
}

for (const sf of program.getSourceFiles()) {
  const rel = relative(ROOT, sf.fileName);
  if (!files.includes(sf.fileName)) continue;
  const c = newC();
  sites(sf, c);
  perFile[rel] = { loc: sf.getLineAndCharacterOfPosition(sf.end).line + 1, scope: scopeOf(rel), c };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const nm = calleeName(n);
      const isRtReg = nm && REGS.has(nm) && !(ts.isPropertyAccessExpression(n.expression) && !/^(rt|R|this|runtime|\w*[rR]t)$/.test(n.expression.expression.getText()) );
      if (isRtReg && nm) {
        const kind = nm === "register" ? "spec" : nm === "intrinsic" ? "intrinsic" : "jni";
        const objArg = n.arguments.find(ts.isObjectLiteralExpression) as ts.ObjectLiteralExpression | undefined;
        const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        if (nm === "registerJni" && n.arguments.length === 3) {
          regCalls.push({ file: rel, kind, entries: 1, spreads: 0, line });
          analyseEntry(sf, rel, kind, tc.typeToString(tc.getTypeAtLocation(n.arguments[0])), n.arguments[1].getText(), n.arguments[2]);
        } else if (objArg) {
          let clsName: string | undefined;
          let table: ts.ObjectLiteralExpression | undefined = objArg;
          if (kind === "spec") {
            const mp = objArg.properties.find((p) => ts.isPropertyAssignment(p) && keyText(p.name) === "methods") as ts.PropertyAssignment | undefined;
            const np = objArg.properties.find((p) => ts.isPropertyAssignment(p) && keyText(p.name) === "name") as ts.PropertyAssignment | undefined;
            clsName = np && ts.isStringLiteralLike(np.initializer) ? np.initializer.text : np?.initializer.getText();
            table = mp && ts.isObjectLiteralExpression(mp.initializer) ? mp.initializer : undefined;
            if (mp && !table) { regCalls.push({ file: rel, kind, cls: clsName, entries: 0, spreads: 1, line }); }
          } else { const a0 = n.arguments[0]; clsName = a0 && ts.isStringLiteralLike(a0) ? a0.text : a0?.getText(); }
          if (table) {
            let ne = 0, sp = 0;
            for (const p of table.properties) {
              if (ts.isSpreadAssignment(p)) { sp++; continue; }
              if (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) {
                const k = keyText(p.name); if (!k) { sp++; continue; }
                ne++; analyseEntry(sf, rel, kind, clsName, k, ts.isPropertyAssignment(p) ? p.initializer : p);
              }
            }
            regCalls.push({ file: rel, kind, cls: clsName, entries: ne, spreads: sp, line });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
mkdirSync(join(import.meta.dirname, "out"), { recursive: true });
writeFileSync(join(import.meta.dirname, "out/ast.json"), JSON.stringify({ perFile, entries, regCalls, classes }, null, 1));
console.log("files", Object.keys(perFile).length, "entries", entries.length, "regCalls", regCalls.length);
