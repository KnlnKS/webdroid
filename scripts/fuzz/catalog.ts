import { readFileSync } from "node:fs";
import { androidPlatform } from "../android-sdk.ts";
import { FRAMEWORK_RE, nativeClassSupport, nativeFieldSupport, nativeMethodSupport, type NativeSupport } from "../native-surface.ts";
import type { DexFile } from "../../src/jvm/dex.ts";
import type { Runtime } from "../../src/jvm/runtime.ts";
import { descToName } from "../../src/jvm/abi.ts";
import { API_RECIPE_MEMBER_IDS } from "./generate.ts";

export type ApiKind = "class" | "method" | "field";
export type ApiSource = "public" | "reached-hidden";
export type Support = NativeSupport | "bytecode-candidate" | "platform-absent";

export type ApiMember = {
  kind: ApiKind;
  owner: string;
  signature: string;
  source: ApiSource;
  since: number;
  removed: number | null;
  support: Support;
  exercised: boolean;
  sites: number;
};

export type ApiCatalog = {
  schemaVersion: 1;
  sdk: number;
  members: ApiMember[];
  totals: Record<Support, number>;
};

type Decl = Omit<ApiMember, "source" | "support" | "exercised">;
export type ReachedSurface = { classes: Map<string, number>; methods: Map<string, number>; fields: Map<string, number> };

const attr = (line: string, name: string): string | null =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(line)?.[1] ?? null;

const unescapeXml = (text: string): string => text
  .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
  .replaceAll("&apos;", "'").replaceAll("&amp;", "&");

const version = (line: string, name: string, fallback: number): number => {
  const value = attr(line, name);
  return value === null ? fallback : Number(value);
};

export function parseApiVersions(xml: string, sdk: number): Decl[] {
  const members: Decl[] = [];
  let owner = "", classSince = 1, classRemoved: number | null = null;
  for (const raw of xml.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("<class ")) {
      owner = unescapeXml(attr(line, "name") ?? "");
      classSince = version(line, "since", 1);
      const removed = attr(line, "removed");
      classRemoved = removed === null ? null : Number(removed);
      if (classSince <= sdk) members.push({ kind: "class", owner, signature: owner, since: classSince, removed: classRemoved, sites: 0 });
      continue;
    }
    if (!owner || (!line.startsWith("<method ") && !line.startsWith("<field "))) continue;
    const since = version(line, "since", classSince);
    if (since > sdk) continue;
    const removedValue = attr(line, "removed");
    members.push({
      kind: line.startsWith("<method ") ? "method" : "field",
      owner,
      signature: unescapeXml(attr(line, "name") ?? ""),
      since,
      removed: removedValue === null ? classRemoved : Number(removedValue),
      sites: 0,
    });
  }
  return members;
}

type FrameworkSurface = { classes: Set<string>; methods: Set<string>; fields: Set<string> };

const recipeExercised = (member: Decl): boolean =>
  API_RECIPE_MEMBER_IDS.has(`${member.kind}:${member.owner}.${member.signature}`);

export function frameworkSurface(dexes: DexFile[]): FrameworkSurface {
  const surface: FrameworkSurface = { classes: new Set(), methods: new Set(), fields: new Set() };
  for (const dex of dexes) for (let i = 0; i < dex.classDefCount; i++) {
    const owner = descToName(dex.type(dex.classDef2Type(i)));
    surface.classes.add(owner);
    const def = dex.classDef(i);
    for (const field of [...def.staticFields, ...def.instanceFields]) surface.fields.add(`${owner}.${dex.field(field.fieldIdx).name}`);
    for (const method of [...def.directMethods, ...def.virtualMethods])
      surface.methods.add(`${owner}.${dex.method(method.methodIdx).name}${dex.methodDesc(method.methodIdx)}`);
  }
  return surface;
}

function supportOf(runtime: Runtime, framework: FrameworkSurface, member: Decl, sdk: number): Support {
  if (member.removed !== null && member.removed <= sdk) return "platform-absent";
  const key = member.kind === "class" ? member.owner : `${member.owner}.${member.signature}`;
  const native = member.kind === "class" ? nativeClassSupport(runtime, key)
    : member.kind === "method" ? nativeMethodSupport(runtime, key) : nativeFieldSupport(runtime, key);
  if (native !== "missing") return native;
  const present = member.kind === "class" ? framework.classes.has(key)
    : member.kind === "method" ? framework.methods.has(key) : framework.fields.has(key);
  return present ? "bytecode-candidate" : "missing";
}

export function buildCatalog(options: { sdk: number; xml: string; runtime: Runtime; frameworkDexes: DexFile[] }): ApiCatalog {
  const framework = frameworkSurface(options.frameworkDexes);
  const members = parseApiVersions(options.xml, options.sdk).map((decl): ApiMember => ({
    ...decl,
    source: "public",
    support: supportOf(options.runtime, framework, decl, options.sdk),
    exercised: recipeExercised(decl),
  })).sort((a, b) => a.owner.localeCompare(b.owner) || a.kind.localeCompare(b.kind) || a.signature.localeCompare(b.signature));
  const totals: Record<Support, number> = {
    delegate: 0, placeholder: 0, "bytecode-candidate": 0, missing: 0, "platform-absent": 0,
  };
  for (const member of members) totals[member.support]++;
  return { schemaVersion: 1, sdk: options.sdk, members, totals };
}

export function addReachedMembers(catalog: ApiCatalog, reached: ReachedSurface, runtime: Runtime, frameworkDexes: DexFile[]): ApiCatalog {
  const framework = frameworkSurface(frameworkDexes);
  const identity = (kind: ApiKind, owner: string, signature: string) => `${kind}:${owner}.${signature}`;
  const known = new Map(catalog.members.map((member) => [identity(member.kind, member.owner, member.signature), member]));
  const add = (kind: ApiKind, key: string, sites: number) => {
    const dot = key.indexOf(".");
    const owner = kind === "class" ? key : key.slice(0, dot);
    const signature = kind === "class" ? key : key.slice(dot + 1);
    if (!FRAMEWORK_RE.test(owner)) return;
    const id = identity(kind, owner, signature);
    const existing = known.get(id);
    if (existing) { existing.sites += sites; return; }
    const decl: Decl = { kind, owner, signature, since: 1, removed: null, sites };
    const member: ApiMember = {
      ...decl,
      source: "reached-hidden",
      support: supportOf(runtime, framework, decl, catalog.sdk),
      exercised: false,
    };
    known.set(id, member);
    catalog.members.push(member);
    catalog.totals[member.support]++;
  };
  for (const [key, sites] of reached.classes) add("class", key, sites);
  for (const [key, sites] of reached.methods) add("method", key, sites);
  for (const [key, sites] of reached.fields) add("field", key, sites);
  catalog.members.sort((a, b) => a.owner.localeCompare(b.owner) || a.kind.localeCompare(b.kind) || a.signature.localeCompare(b.signature));
  return catalog;
}

export function sdkApiXml(sdk: number): string {
  return readFileSync(`${androidPlatform(sdk)}/data/api-versions.xml`, "utf8");
}
