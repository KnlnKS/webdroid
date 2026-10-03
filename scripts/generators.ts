// Calls of a driven-style generator (one declared to return Gen) whose generator nothing runs: one
// neither delegated to (yield*), driven (rt.drive), nor returned by a plain function to a caller
// that drives it. A callback handed to callUncaught, after or onMain has its result consumed as a
// value, so a generator it returns runs nothing either. Also a pending Java result memoised with
// `??=`, whose suspension every awaiting frame would share. Whether Java is entered from a turn a
// thread owns is checked at run time (jlang's strictThreadOwnership).
//   bun scripts/generators.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");
/** helpers that take a callback's result as a value, never running a generator it returns */
const CONSUMERS = new Set(["callUncaught", "after", "onMain"]);
/** driven-style generators every module imports, whose calls are checked in each file */
const SHARED = ["awaited"];
/** helpers that enter Java and may return a pending result */
const JAVA = new Set(["vcall", "vcallAsync", "vcallOn", "scall", "newObj", "linkInit", "staticField", "callOn"]);
/** the source files under src, parsed */
function* sources(): Generator<[string, ts.SourceFile]> {
  for (const file of new Bun.Glob("src/**/*.ts").scanSync(root)) {
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

/** `x ??= <Java entry or rt.drive>`: a pending result is a suspension that every frame awaiting it
 *  joins (src/jvm/suspend.ts), so a second caller resumes inside the first one's stack. `once`
 *  shares an in-flight computation instead. */
export function sharedSuspensions(): string[] {
  const out: string[] = [];
  for (const [file, source] of sources()) {
    const visit = (n: ts.Node) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken) {
        let value: ts.Expression = n.right;
        while (ts.isCallExpression(value) && value.expression.getText() === "Promise.resolve" && value.arguments.length) value = value.arguments[0];
        const callee = ts.isCallExpression(value) ? value.expression.getText() : "";
        if (JAVA.has(callee) || callee === "rt.drive") out.push(`${file}:${source.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${n.left.getText()}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }
  return out;
}

if (import.meta.main) {
  for (const line of sharedSuspensions()) console.log("shared suspension: " + line);
  for (const line of undelegatedGenerators()) console.log("not run: " + line);
}
