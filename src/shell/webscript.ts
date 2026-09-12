import ts from "typescript";

export function webScript(source: string): string {
  if (!source.includes("location") && !source.includes("\\u")) return source;
  const file = ts.createSourceFile("/webview.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits: { start: number; end: number; text: string }[] = [];
  let checker: ts.TypeChecker | undefined;
  const symbols = () => checker ??= ts.createProgram([file.fileName], { allowJs: true, noLib: true, noResolve: true }, {
    ...ts.createCompilerHost({}),
    getSourceFile: name => name === file.fileName ? file : undefined,
    fileExists: name => name === file.fileName,
    readFile: name => name === file.fileName ? source : undefined,
  }).getTypeChecker();
  const owner = (node: ts.Expression) => edits.push(
    { start: node.getStart(file), end: node.getStart(file), text: "(__wdLocationOwner(" },
    { start: node.end, end: node.end, text: "))" });
  const visit = (node: ts.Node) => {
    if ((ts.isPropertyAccessExpression(node) && node.name.text === "location"
      || ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "location")
      && node.expression.kind !== ts.SyntaxKind.SuperKeyword && !ts.isOptionalChain(node.expression)) {
      owner(node.expression);
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer
      && node.name.elements.some(element => (element.propertyName ?? element.name).getText(file) === "location")) {
      owner(node.initializer);
    } else if (ts.isIdentifier(node) && node.text === "location") {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.name === node
        || ts.isPropertyAssignment(parent) && parent.name === node
        || ts.isBindingElement(parent) && parent.propertyName === node
        || ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) return;
      for (let ancestor: ts.Node | undefined = parent; ancestor; ancestor = ancestor.parent) if (ts.isWithStatement(ancestor)) return;
      if (ts.isShorthandPropertyAssignment(parent)) {
        if (!symbols().getShorthandAssignmentValueSymbol(parent)) edits.push({ start: node.end, end: node.end, text: ": __wdLocationOwner().location" });
      } else if (!symbols().getSymbolAtLocation(node)) {
        edits.push({ start: node.getStart(file), end: node.end, text: "(__wdLocationOwner().location)" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!edits.length) return source;
  edits.sort((a, b) => a.start - b.start);
  let at = 0;
  const parts: string[] = [];
  for (const edit of edits) { parts.push(source.slice(at, edit.start), edit.text); at = edit.end; }
  parts.push(source.slice(at));
  return parts.join("");
}
