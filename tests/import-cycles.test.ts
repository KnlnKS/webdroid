import { expect, test } from "vite-plus/test";
import { globSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

// Split bundles can enter an import cycle at any member, so no module may read a
// class/const/let binding from its own cycle while loading (TDZ in production only).
test("modules do not read cyclic imports during evaluation", () => {
  const root = resolve(import.meta.dirname, "..");
  const files = new Set(globSync("src/**/*.ts", { cwd: root }).filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".d.ts")).map((f) => resolve(root, f)));
  type Binding = { from: string; name: string };
  type Module = { source: ts.SourceFile; imports: Map<string, Binding>; reexports: Map<string, Binding>; deps: Set<string>; tdz: Set<string> };
  const modules = new Map<string, Module>();
  const target = (from: string, spec: string) => {
    if (!spec.startsWith(".")) return null;
    const path = resolve(dirname(from), spec);
    return files.has(path) ? path : null;
  };
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const module: Module = { source, imports: new Map(), reexports: new Map(), deps: new Set(), tdz: new Set() };
    for (const statement of source.statements) {
      const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
        const from = target(file, (statement.moduleSpecifier as ts.StringLiteral).text);
        const bindings = statement.importClause?.namedBindings;
        if (!from || !bindings || !ts.isNamedImports(bindings)) continue;
        for (const element of bindings.elements) if (!element.isTypeOnly) {
          module.imports.set(element.name.text, { from, name: (element.propertyName ?? element.name).text });
          module.deps.add(from);
        }
      } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const from = target(file, (statement.moduleSpecifier as ts.StringLiteral).text);
        if (!from) continue;
        for (const element of statement.exportClause.elements) module.reexports.set(element.name.text, { from, name: (element.propertyName ?? element.name).text });
        module.deps.add(from);
      } else if (exported && ts.isClassDeclaration(statement) && statement.name) module.tdz.add(statement.name.text);
      else if (exported && ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name)) module.tdz.add(d.name.text);
    }
    modules.set(file, module);
  }
  // A binding may be re-exported from an import; follow it to its declaring module.
  const declaration = (file: string, name: string): Binding => {
    const module = modules.get(file)!;
    const next = module.reexports.get(name) ?? (module.tdz.has(name) ? undefined : module.imports.get(name));
    return next ? declaration(next.from, next.name) : { from: file, name };
  };

  const index = new Map<string, number>(), low = new Map<string, number>(), component = new Map<string, number>(), stack: string[] = [];
  let counter = 0, components = 0;
  const connect = (file: string) => {
    index.set(file, counter); low.set(file, counter++); stack.push(file);
    for (const dep of modules.get(file)!.deps) {
      if (!index.has(dep)) { connect(dep); low.set(file, Math.min(low.get(file)!, low.get(dep)!)); }
      else if (!component.has(dep)) low.set(file, Math.min(low.get(file)!, index.get(dep)!));
    }
    if (low.get(file) === index.get(file)) { let member; do { member = stack.pop()!; component.set(member, components); } while (member !== file); components++; }
  };
  for (const file of files) if (!index.has(file)) connect(file);

  const deferred = (node: ts.Node) => ts.isFunctionLike(node) || (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) ||
    (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
    ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || (ts.isPropertyDeclaration(node) && !ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword));
  const violations: string[] = [];
  for (const [file, module] of modules) {
    const visit = (node: ts.Node): void => {
      if (deferred(node)) return;
      const parent = node.parent;
      if (ts.isIdentifier(node) && module.imports.has(node.text) && !(parent && (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === node)) {
        const origin = declaration(file, node.text);
        if (component.get(origin.from) === component.get(file) && modules.get(origin.from)!.tdz.has(origin.name)) {
          const { line } = module.source.getLineAndCharacterOfPosition(node.getStart());
          violations.push(`${relative(root, file)}:${line + 1} reads ${origin.name} from ${relative(root, origin.from)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(module.source, visit);
  }
  expect(violations).toEqual([]);
}, 30_000); // parses every module: under 1 s alone, several under a loaded parallel run
