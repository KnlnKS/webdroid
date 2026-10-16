import { createHash } from "node:crypto";
import type { UiNode } from "../../tests/e2e/types.ts";
import type { Random } from "./random.ts";

export type SemanticIdentity = {
  resourceId?: string;
  text?: string;
  description?: string;
  className: string;
  ordinal: number;
};

type Point = { x: number; y: number };

export type UiAction =
  | { type: "tap"; target: SemanticIdentity; at: Point }
  | { type: "type"; target: SemanticIdentity; at: Point; text: string }
  | { type: "scroll"; target: SemanticIdentity; from: Point; to: Point; durationMs: number }
  | { type: "back" | "enter" }
  | { type: "background"; durationMs: number }
  | { type: "configuration"; orientation: "portrait" | "landscape" }
  | { type: "fallback-tap"; at: Point };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function point(value: unknown, label: string): Point {
  const input = object(value, label);
  return { x: finite(input.x, `${label}.x`), y: finite(input.y, `${label}.y`) };
}

function identity(value: unknown, label: string): SemanticIdentity {
  const input = object(value, label);
  if (typeof input.className !== "string" || typeof input.ordinal !== "number" || !Number.isInteger(input.ordinal) || input.ordinal < 0)
    throw new Error(`${label} is invalid`);
  const output: SemanticIdentity = { className: input.className, ordinal: input.ordinal };
  if (typeof input.resourceId === "string") output.resourceId = input.resourceId;
  if (typeof input.text === "string") output.text = input.text;
  if (typeof input.description === "string") output.description = input.description;
  return output;
}

export function validateUiAction(value: unknown, label = "action"): UiAction {
  const input = object(value, label);
  switch (input.type) {
    case "tap": return { type: input.type, target: identity(input.target, `${label}.target`), at: point(input.at, `${label}.at`) };
    case "type": {
      if (typeof input.text !== "string") throw new Error(`${label}.text must be a string`);
      return { type: input.type, target: identity(input.target, `${label}.target`), at: point(input.at, `${label}.at`), text: input.text };
    }
    case "scroll": return { type: input.type, target: identity(input.target, `${label}.target`), from: point(input.from, `${label}.from`),
      to: point(input.to, `${label}.to`), durationMs: finite(input.durationMs, `${label}.durationMs`) };
    case "back": case "enter": return { type: input.type };
    case "background": return { type: input.type, durationMs: finite(input.durationMs, `${label}.durationMs`) };
    case "configuration":
      if (input.orientation !== "portrait" && input.orientation !== "landscape") throw new Error(`${label}.orientation is invalid`);
      return { type: input.type, orientation: input.orientation };
    case "fallback-tap": return { type: input.type, at: point(input.at, `${label}.at`) };
    default: throw new Error(`${label}.type is invalid`);
  }
}

const visible = (node: UiNode): boolean => node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1];
const usable = (node: UiNode): boolean => node.enabled && visible(node);
const normalized = (value: string): string => value.replace(/\s+/g, " ").trim();

function selector(node: UiNode): string {
  if (node.resId) return `id:${node.resId}`;
  if (normalized(node.text)) return `text:${normalized(node.text)}`;
  if (normalized(node.desc)) return `desc:${normalized(node.desc)}`;
  return `class:${node.cls}`;
}

function identityWithOrdinal(node: UiNode, ordinal: number): SemanticIdentity {
  return {
    ...(node.resId ? { resourceId: node.resId } : {}),
    ...(normalized(node.text) ? { text: normalized(node.text) } : {}),
    ...(normalized(node.desc) ? { description: normalized(node.desc) } : {}),
    className: node.cls,
    ordinal,
  };
}

function identityMatches(node: UiNode, identity: SemanticIdentity): boolean {
  if (identity.resourceId) return node.resId === identity.resourceId;
  if (identity.text) return normalized(node.text) === identity.text;
  if (identity.description) return normalized(node.desc) === identity.description;
  return node.cls === identity.className;
}

export function matchIdentity(nodes: readonly UiNode[], identity: SemanticIdentity): UiNode | null {
  return nodes.filter((node) => usable(node) && identityMatches(node, identity))[identity.ordinal] ?? null;
}

function center(node: UiNode, width: number, height: number): Point {
  return {
    x: ((node.bounds[0] + node.bounds[2]) / 2) / width,
    y: ((node.bounds[1] + node.bounds[3]) / 2) / height,
  };
}

export function uiActions(nodes: readonly UiNode[], width: number, height: number): UiAction[] {
  const semantic: UiAction[] = [];
  const ordinals = new Map<string, number>();
  for (const node of nodes) {
    if (!usable(node)) continue;
    const key = selector(node), ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    if (!node.clickable && !node.editable && !node.scrollable) continue;
    const target = identityWithOrdinal(node, ordinal), at = center(node, width, height);
    if (node.clickable) semantic.push({ type: "tap", target, at });
    if (node.editable) for (const text of ["a", "0", "test", " ", "webdroid"])
      semantic.push({ type: "type", target, at, text });
    if (node.scrollable) {
      const x = at.x;
      semantic.push({ type: "scroll", target, from: { x, y: Math.min(0.85, at.y + 0.2) }, to: { x, y: Math.max(0.15, at.y - 0.2) }, durationMs: 400 });
    }
  }
  const global: UiAction[] = [
    { type: "back" }, { type: "enter" }, { type: "background", durationMs: 250 },
    { type: "configuration", orientation: "portrait" },
    { type: "configuration", orientation: "landscape" },
  ];
  if (semantic.length) return [...semantic, ...global];
  const fallback: UiAction[] = [];
  for (const y of [0.25, 0.5, 0.75]) for (const x of [0.25, 0.5, 0.75])
    fallback.push({ type: "fallback-tap", at: { x, y } });
  return [...global, ...fallback];
}

export function generateUiAction(random: Random, nodes: readonly UiNode[], width: number, height: number): UiAction {
  return random.pick(uiActions(nodes, width, height));
}

function hashStructure(structure: readonly string[]): string {
  return createHash("sha256").update(structure.join("\n")).digest("hex").slice(0, 24);
}

export function uiStateKey(nodes: readonly UiNode[]): string {
  const visibleNodes = nodes.filter(visible);
  const width = Math.max(1, ...visibleNodes.map((node) => node.bounds[2]));
  const height = Math.max(1, ...visibleNodes.map((node) => node.bounds[3]));
  return hashStructure(visibleNodes.map((node) => JSON.stringify([
    node.resId, node.cls, normalized(node.text), normalized(node.desc),
    node.enabled, node.clickable, node.editable, node.scrollable,
    node.clickable || node.editable || node.scrollable
      ? node.bounds.map((coordinate, index) => Math.round(16 * coordinate / (index % 2 ? height : width))) : null,
  ])));
}

export function uiScrollFamilyKey(nodes: readonly UiNode[]): string {
  const scrollables = nodes.filter((node) => usable(node) && node.scrollable);
  const outside = nodes.filter((node) => visible(node) && !node.scrollable && (node.text || node.desc) &&
    !scrollables.some((parent) => node.bounds[0] >= parent.bounds[0] && node.bounds[1] >= parent.bounds[1] &&
      node.bounds[2] <= parent.bounds[2] && node.bounds[3] <= parent.bounds[3]));
  return hashStructure([
    ...scrollables.map((node) => JSON.stringify([node.resId, node.cls])),
    ...outside.map((node) => JSON.stringify([node.resId, node.cls, normalized(node.text), normalized(node.desc)])),
  ]);
}

export function uiActionKey(action: UiAction): string {
  if ("target" in action) {
    const target = action.target;
    if (action.type === "scroll") return JSON.stringify([action.type, target.resourceId ?? target.className,
      action.from.x, action.from.y]);
    const selector = target.resourceId ? ["id", target.resourceId] : target.text ? ["text", target.text] :
      target.description ? ["desc", target.description] : ["class", target.className];
    return JSON.stringify([action.type, selector, target.ordinal, action.type === "type" ? action.text : ""]);
  }
  if (action.type === "fallback-tap") return JSON.stringify([action.type, action.at]);
  if (action.type === "configuration") return JSON.stringify([action.type, action.orientation]);
  return action.type;
}

export function semanticKeys(nodes: readonly UiNode[]): string[] {
  return nodes.filter(usable).filter((node) => node.resId || node.text || node.desc)
    .map(selector).sort();
}
