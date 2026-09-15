import type { UiNode } from "../../tests/e2e/types";
import { Random } from "./random";

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

const usable = (node: UiNode): boolean => node.enabled && node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1];
const normalized = (value: string): string => value.replace(/\s+/g, " ").trim();

function selector(node: UiNode): string {
  if (node.resId) return `id:${node.resId}`;
  if (normalized(node.text)) return `text:${normalized(node.text)}`;
  if (normalized(node.desc)) return `desc:${normalized(node.desc)}`;
  return `class:${node.cls}`;
}

export function identityOf(nodes: readonly UiNode[], node: UiNode): SemanticIdentity {
  const key = selector(node);
  const peers = nodes.filter((candidate) => usable(candidate) && selector(candidate) === key);
  return {
    ...(node.resId ? { resourceId: node.resId } : {}),
    ...(normalized(node.text) ? { text: normalized(node.text) } : {}),
    ...(normalized(node.desc) ? { description: normalized(node.desc) } : {}),
    className: node.cls,
    ordinal: Math.max(0, peers.indexOf(node)),
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

export function generateUiAction(random: Random, nodes: readonly UiNode[], width: number, height: number): UiAction {
  const interactive = nodes.filter(usable);
  const semantic: UiAction[] = [];
  for (const node of interactive) {
    const target = identityOf(nodes, node), at = center(node, width, height);
    if (node.clickable) semantic.push({ type: "tap", target, at });
    if (node.editable) semantic.push({ type: "type", target, at, text: random.pick(["a", "0", "test", " ", "webdroid"]) });
    if (node.scrollable) {
      const x = at.x;
      semantic.push({ type: "scroll", target, from: { x, y: Math.min(0.85, at.y + 0.2) }, to: { x, y: Math.max(0.15, at.y - 0.2) }, durationMs: 400 });
    }
  }
  if (semantic.length && random.chance(0.8)) return random.pick(semantic);
  const global: UiAction[] = [
    { type: "back" }, { type: "enter" }, { type: "background", durationMs: 250 },
    { type: "configuration", orientation: random.chance(0.5) ? "portrait" : "landscape" },
  ];
  if (semantic.length) return random.pick(global);
  if (random.chance(0.7)) return random.pick(global);
  return { type: "fallback-tap", at: { x: random.next(), y: random.next() } };
}

export function semanticKeys(nodes: readonly UiNode[]): string[] {
  return nodes.filter(usable).filter((node) => node.resId || node.text || node.desc)
    .map(selector).sort();
}
