// Calls of a driven-style generator (one declared to return Gen) whose generator nothing runs: one
// neither delegated to (yield*), driven (rt.drive), nor returned by a plain function to a caller
// that drives it. A callback handed to detached, after, onMain or postMain has its result consumed as a
// value, so a generator it returns runs nothing either. Also a Java entry whose result is dropped. Whether Java is entered from a turn a thread owns is checked at run time (jlang's
// strictThreadOwnership). And per-process ABI state read as a module loads.
//   pnpm ts scripts/generators.ts
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
/** helpers that take a callback's result as a value, never running a generator it returns */
const CONSUMERS = new Set(["detached", "after", "onMain", "postMain"]);
/** driven-style generators every module imports, whose calls are checked in each file */
const SHARED = ["awaited"];
/** helpers that enter Java and may return a pending result */
const JAVA = new Set(["vcall", "vcallAsync", "vcallOn", "scall", "newObj", "linkInit", "staticField", "callOn"]);
/** the source files under src, parsed */
function* sources(): Generator<[string, ts.SourceFile]> {
  for (const file of globSync("src/**/*.ts", { cwd: root }).sort()) {
    if (!file.endsWith(".d.ts")) yield [file, ts.createSourceFile(file, readFileSync(resolve(root, file), "utf8"), ts.ScriptTarget.Latest, true)];
  }
}

/** names `fn` binds itself, which shadow module declarations */
function locals(fn: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n)) && n.name && ts.isIdentifier(n.name) && n !== fn) out.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return out;
}
const consumed = (fn: ts.Node) => ts.isArrowFunction(fn) && ts.isCallExpression(fn.parent) && fn.parent.arguments.includes(fn)
  && CONSUMERS.has(fn.parent.expression.getText());

export function undelegatedGenerators(): string[] {
  const out: string[] = [];
  const isGen = (n: ts.Node): n is ts.FunctionDeclaration | ts.MethodDeclaration =>
    (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && !!n.asteriskToken && /^Gen\b/.test(n.type?.getText() ?? "");
  for (const [file, source] of sources()) {
    const functions = new Set<string>(SHARED), methods = new Set<string>();
    const collect = (n: ts.Node) => { if (isGen(n)) (ts.isMethodDeclaration(n) ? methods : functions).add(n.name!.getText()); ts.forEachChild(n, collect); };
    collect(source);
    const visit = (n: ts.Node) => {
      const callee = ts.isCallExpression(n) ? n.expression : undefined;
      if (callee && (ts.isPropertyAccessExpression(callee) ? methods.has(callee.name.text) : ts.isIdentifier(callee) && functions.has(callee.text))) {
        let p: ts.Node = n.parent, fn: ts.Node = n.parent;
        while (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isConditionalExpression(p)) p = p.parent;
        while (!ts.isFunctionLike(fn) && !ts.isSourceFile(fn)) fn = fn.parent;
        let shadowed = false;
        for (let f: ts.Node = fn; !ts.isSourceFile(f); f = f.parent) if (ts.isFunctionLike(f) && locals(f).has(callee.getText())) shadowed = true;
        const handedOn = (ts.isReturnStatement(p) || ts.isArrowFunction(p)) && !(fn as ts.FunctionLikeDeclaration).asteriskToken && !consumed(fn);
        if (!shadowed && !(ts.isYieldExpression(p) && p.asteriskToken || ts.isCallExpression(p) && p.expression.getText() === "rt.drive" || handedOn))
          out.push(`${file}:${source.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${callee.getText()}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }
  return out;
}

/** The process ABI's per-process state (host.ts's pointer width, syscall.ts's struct layouts, abi.ts's
 *  memory size) read where a module loads: modules load before an arm64 process sets it, so the
 *  value is the ARM32 default (msghdr's offsets once were). Only direct reads are seen. */
const ABI_STATE = new Set(["PTR", "KLAYOUT", "MEM_SIZE"]);
export function loadTimeAbiReads(): string[] {
  const out: string[] = [];
  for (const [file, source] of sources()) {
    if (!/\b(PTR|KLAYOUT|MEM_SIZE)\b/.test(source.text)) continue;
    const visit = (n: ts.Node) => {
      if (ts.isFunctionLike(n) || ts.isImportDeclaration(n) || ts.isTypeNode(n) ||
        ts.isPropertyDeclaration(n) && !n.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) return;
      if (ts.isIdentifier(n) && ABI_STATE.has(n.text) && !(ts.isVariableDeclaration(n.parent) && n.parent.name === n) &&
        !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !ts.isExportSpecifier(n.parent))
        out.push(`${file}:${source.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${n.text}`);
      ts.forEachChild(n, visit);
    };
    visit(source);
  }
  return out;
}

/** `void vcall(…)` or a bare `vcall(…);`: a Java entry nothing waits for, which, suspended, would
 *  go on as the running chain while that chain runs past it. detached gives it a chain. */
export function discardedEntries(): string[] {
  const out: string[] = [];
  for (const [file, source] of sources()) {
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && (JAVA.has(n.expression.getText()) || n.expression.getText() === "rt.drive")) {
        let p: ts.Node = n.parent;
        while (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p)) p = p.parent;
        if (ts.isExpressionStatement(p) || ts.isVoidExpression(p)) out.push(`${file}:${source.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${n.expression.getText()}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }
  return out;
}

if (import.meta.main) {
  for (const line of discardedEntries()) console.log("discarded: " + line);
  for (const line of loadTimeAbiReads()) console.log("load-time ABI read: " + line);
  for (const line of undelegatedGenerators()) console.log("not run: " + line);
}
