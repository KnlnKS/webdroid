import { parse } from "acorn";
import { ancestor } from "acorn-walk";
import { analyze } from "eslint-scope";
import type { Program } from "estree";

type Span = { start: number; end: number };
type Edit = { start: number; end: number; text: string };

export function webScript(source: string): string {
  if (!source.includes("location") && !source.includes("\\u")) return source;
  let tree;
  try { tree = parse(source, { ecmaVersion: "latest", sourceType: "module", ranges: true, allowAwaitOutsideFunction: true }); }
  catch {
    try { tree = parse(source, { ecmaVersion: "latest", sourceType: "script", ranges: true, allowReturnOutsideFunction: true }); }
    catch { return source; }
  }
  const scope = analyze(tree as Program, { ecmaVersion: 2024, sourceType: tree.sourceType });
  const globals = new Set(scope.globalScope?.through.map((reference) => reference.identifier));
  const edits: Edit[] = [];
  const owner = (span: Span) => edits.push(
    { start: span.start, end: span.start, text: "(__wdLocationOwner(" },
    { start: span.end, end: span.end, text: "))" },
  );

  ancestor(tree, {
    MemberExpression(node) {
      const member = node as typeof node & { object: Span & { type: string }; property: { type: string; name?: string; value?: unknown }; computed: boolean; optional?: boolean };
      if (member.optional || member.object.type === "Super") return;
      if (member.computed ? member.property.type === "Literal" && member.property.value === "location"
        : member.property.type === "Identifier" && member.property.name === "location") owner(member.object);
    },
    VariableDeclarator(node) {
      const declaration = node as typeof node & { id: { type: string; properties?: { key: { name?: string; value?: unknown } }[] }; init?: Span };
      if (declaration.id.type === "ObjectPattern" && declaration.init && declaration.id.properties?.some((property) =>
        property.type === "Property" && (property.key.type === "Identifier" && property.key.name === "location"
          || property.key.type === "Literal" && property.key.value === "location"))) owner(declaration.init);
    },
    Identifier(node, _state, ancestors) {
      if (node.name !== "location" || !globals.has(node)) return;
      if (ancestors.some((item) => item.type === "WithStatement")) return;
      const parent = ancestors.at(-2) as { type: string; shorthand?: boolean } | undefined;
      if (parent?.type === "Property" && parent.shorthand) {
        edits.push({ start: node.end, end: node.end, text: ": __wdLocationOwner().location" });
      } else edits.push({ start: node.start, end: node.end, text: "(__wdLocationOwner().location)" });
    },
  });
  if (!edits.length) return source;
  edits.sort((a, b) => a.start - b.start);
  let at = 0;
  const parts: string[] = [];
  for (const edit of edits) {
    if (edit.start < at) continue;
    parts.push(source.slice(at, edit.start), edit.text);
    at = edit.end;
  }
  parts.push(source.slice(at));
  return parts.join("");
}
