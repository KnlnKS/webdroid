// Async natives that call Java after an await. A plain async function resumes on the event loop,
// whose current thread is the main thread, so Java it calls after its first await runs as main:
// monitors, Binder calling identity and thread-confined state break (docs/implementation-history.md,
// Amazon's launch freeze). A driven generator (src/jvm/runtime.ts `driven`) resumes on the calling
// thread. This reports every async function a native registration reaches (inline, or through the
// module-level helpers it names) that reaches Java once its first await has suspended, and every
// call of a driven-style generator (one declared to return Gen) whose generator nothing runs.
//   bun run async-natives [--write-baseline]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");
export const BASELINE = resolve(root, "tests/fixtures/async-natives-baseline.json");
const JLANG = resolve(root, "src/jvm/natives/jlang.ts");
/** jlang's entries into Java, and what reads the current thread; its other helpers keep their thread */
const JAVA = new Set(["vcall", "scall", "newObj", "construct", "vcallAsync", "vcallUncaught", "linkInit", "staticField", "curThread"]);
const REGISTER = /^(?:rt|this)\.(?:register|registerJnis?|intrinsic)$/;

type Module = { decls: Map<string, ts.Node>; imports: Map<string, { from: string; name: string }> };
const modules = new Map<string, Module>();
const files = [...new Bun.Glob("src/**/*.ts").scanSync(root)].filter((f) => !f.endsWith(".d.ts")).map((f) => resolve(root, f));
const sources = new Map(files.map((file) => [file, ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)]));
for (const [file, source] of sources) {
  const module: Module = { decls: new Map(), imports: new Map() };
  for (const s of source.statements) {
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) module.decls.set(s.name.text, s);
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) { if (ts.isIdentifier(d.name)) module.decls.set(d.name.text, d); }
    else if ((ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier && (s.moduleSpecifier as ts.StringLiteral).text.startsWith(".")) {
      const from = resolve(dirname(file), (s.moduleSpecifier as ts.StringLiteral).text) + ".ts";
      const named = ts.isImportDeclaration(s) ? s.importClause?.namedBindings : s.exportClause;
      if (named && (ts.isNamedImports(named) || ts.isNamedExports(named)))
        for (const e of named.elements) module.imports.set(e.name.text, { from, name: (e.propertyName ?? e.name).text });
    }
  }
  modules.set(file, module);
}
/** the module-level declaration `name` means in `file`, through imports and re-exports */
function declaration(file: string, name: string, depth = 0): [string, ts.Node] | undefined {
  const module = modules.get(file);
  const own = module?.decls.get(name);
  if (own) return [file, own];
  const next = module?.imports.get(name);
  return next && depth < 8 ? declaration(next.from, next.name, depth + 1) : undefined;
}

const isFunction = (n: ts.Node): n is ts.FunctionLikeDeclaration => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
const isAsync = (n: ts.Node) => isFunction(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
/** identifiers `node` reads that may name a module-level declaration (not property names or its own bindings) */
function references(node: ts.Node, keep: (id: ts.Identifier) => boolean = () => true): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const visit = (n: ts.Node) => {
    const p = n.parent;
    if (ts.isIdentifier(n) && keep(n) && !((ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name === n)
      && !((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isBindingElement(p)) && p.name === n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
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

const javaMemo = new Map<ts.Node, boolean>();
/** `name` in `file` reaches Java */
function java(file: string, name: string): boolean {
  const hit = declaration(file, name);
  if (!hit || hit[0] === JLANG) return !!hit && JAVA.has((hit[1] as ts.NamedDeclaration).name!.getText());
  const [from, node] = hit;
  // a class's methods run when called, not when it is named
  if (ts.isClassDeclaration(node)) return false;
  if (javaMemo.has(node)) return javaMemo.get(node)!;
  javaMemo.set(node, false);
  const local = locals(node);
  const result = references(node).some((id) => !local.has(id.text) && id.text !== name && java(from, id.text));
  javaMemo.set(node, result);
  return result;
}

/** the Java an async function reaches after its first await suspends: what follows the first await
 *  to complete, the calls enclosing it, and the whole loop it is in */
function javaAfterAwait(file: string, fn: ts.FunctionLikeDeclaration): string[] {
  let first: ts.AwaitExpression | undefined;
  const find = (n: ts.Node) => {
    if (n !== fn && isFunction(n)) return;
    if (ts.isAwaitExpression(n) && (!first || n.end < first.end)) first = n;
    ts.forEachChild(n, find);
  };
  find(fn);
  if (!first) return [];
  let from = first.end;
  const enclosing = new Set<ts.Node>();
  for (let n: ts.Node = first.parent; n !== fn; n = n.parent) {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) enclosing.add(n.expression);
    // a loop repeats all of itself but the collection a for-of or for-in reads once
    if (ts.isIterationStatement(n, false) && !((ts.isForOfStatement(n) || ts.isForInStatement(n)) && n.expression.getStart() <= first.getStart() && first.end <= n.expression.end))
      from = Math.min(from, n.getStart());
  }
  const local = locals(fn), inside = (id: ts.Node) => { for (let n = id.parent; n !== fn; n = n.parent) if (isFunction(n)) return false; return true; };
  const after = references(fn, (id) => inside(id) && (id.getStart() >= from || id.end <= first!.getStart() && [...enclosing].some((e) => e.getStart() <= id.getStart() && id.end <= e.end)));
  return [...new Set(after.filter((id) => !local.has(id.text) && java(file, id.text)).map((id) => id.text))];
}

/** the async functions in `node`, and those the declarations it names reach, that call Java after an
 *  await: "file: key → calls" for inline ones, "file#declaration → calls" for helpers */
function hazards(file: string, node: ts.Node, seen: Set<ts.Node>, out: Map<string, string[]>, label?: string): void {
  const visit = (n: ts.Node) => {
    if (isAsync(n)) {
      const calls = javaAfterAwait(file, n as ts.FunctionLikeDeclaration);
      const site = `${relative(root, file)}${label ? "#" + label : ": " + keyOf(n)}`;
      if (calls.length) out.set(site, [...new Set([...out.get(site) ?? [], ...calls])].sort());
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  const local = locals(node);
  for (const id of references(node)) {
    if (local.has(id.text)) continue;
    const hit = declaration(file, id.text);
    if (!hit || hit[0] === JLANG || seen.has(hit[1])) continue;
    seen.add(hit[1]);
    hazards(hit[0], hit[1], seen, out, (hit[1] as ts.NamedDeclaration).name!.getText());
  }
}
/** a native's name in its table: the property or method key, else its line */
function keyOf(n: ts.Node): string {
  for (let p: ts.Node | undefined = n; p; p = p.parent)
    if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText().replace(/^\[`?|`?\]$/g, "").replace(/^"|"$/g, "");
  return "line " + (n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1);
}

export function asyncNativeHazards(): string[] {
  const out = new Map<string, string[]>(), seen = new Set<ts.Node>();
  for (const [file, source] of sources) {
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && REGISTER.test(n.expression.getText())) for (const a of n.arguments) hazards(file, a, seen, out);
      else ts.forEachChild(n, visit);
    };
    visit(source);
  }
  return [...out].map(([site, calls]) => `${site} → ${calls.join(", ")}`).sort();
}

/** calls of a generator declared to return Gen whose result is neither delegated to (yield*),
 *  driven, nor handed on by a function that is not itself a generator: such a call runs nothing */
export function undelegatedGenerators(): string[] {
  const out: string[] = [];
  const isGen = (n: ts.Node): n is ts.FunctionDeclaration | ts.MethodDeclaration =>
    (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && !!n.asteriskToken && /^Gen\b/.test(n.type?.getText() ?? "");
  for (const [file, source] of sources) {
    const functions = new Set<string>(), methods = new Set<string>();
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
        const handedOn = (ts.isReturnStatement(p) || ts.isArrowFunction(p)) && !(fn as ts.FunctionLikeDeclaration).asteriskToken;
        if (!shadowed && !(ts.isYieldExpression(p) && p.asteriskToken || ts.isCallExpression(p) && p.expression.getText() === "rt.drive" || handedOn))
          out.push(`${relative(root, file)}:${source.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${callee.getText()}`);
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
  for (const [file, source] of sources) {
    const visit = (n: ts.Node) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken) {
        let value: ts.Expression = n.right;
        while (ts.isCallExpression(value) && value.expression.getText() === "Promise.resolve" && value.arguments.length) value = value.arguments[0];
        const callee = ts.isCallExpression(value) ? value.expression.getText() : "";
        if (JAVA.has(callee) || callee === "rt.drive") out.push(`${relative(root, file)}:${source.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${n.left.getText()}`);
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
  const found = asyncNativeHazards();
  if (process.argv.includes("--write-baseline")) writeFileSync(BASELINE, JSON.stringify(found.map((line) => line.slice(0, line.indexOf(" → "))), null, 1) + "\n");
  for (const line of found) console.log(line);
  console.log(`${found.length} async functions natives reach that call Java after an await`);
}
