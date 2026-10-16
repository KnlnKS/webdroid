import type { UiNode } from "../types.ts";

const decode = (value: string): string => value
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCharCode(Number(decimal))).replace(/&amp;/g, "&");

export function parseUiAutomator(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  const tags = /<node\b([^>]*)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(xml))) {
    const attrs = match[1]!;
    const get = (key: string): string => new RegExp(`${key}="([^"]*)"`).exec(attrs)?.[1] ?? "";
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(attrs);
    if (!bounds) continue;
    const cls = get("class");
    nodes.push({
      text: decode(get("text")), desc: decode(get("content-desc")), cls, resId: get("resource-id"),
      bounds: [Number(bounds[1]), Number(bounds[2]), Number(bounds[3]), Number(bounds[4])],
      clickable: get("clickable") === "true", enabled: get("enabled") !== "false",
      editable: get("editable") === "true" || /EditText$/.test(cls), scrollable: get("scrollable") === "true",
    });
  }
  return nodes;
}
