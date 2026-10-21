// Where a program starts. Nothing here is a guess about a particular app: these are the
// entry points the platform itself calls, and the two ways an apk names a class in data
// rather than in bytecode — a manifest attribute and a services file.

import { slashName } from "./abi.ts";
import type { Program } from "./reach.ts";
import { parseAXML, attrStr, type XmlNode } from "../android/axml.ts";

interface Roots {
  classes: string[];              // classes the platform instantiates and calls into
  methods: string[];              // their whole declared surface: nothing in the apk calls it
  why: Map<string, string>;       // what named each root, for the report
}

/** component tags whose android:name the platform loads */
const COMPONENT_TAGS = new Set(["activity", "activity-alias", "service", "provider", "receiver"]);
/** "a.b.C" or "a.b.C$D": a string shaped like a binary class name */
const CLASS_NAME = /^[a-z][\w.]*\.[A-Z][\w$]*$/;

/** a manifest's android:name as the class it names, as PackageParser builds it */
export function qualify(pkg: string, name: string): string {
  const n = name.startsWith(".") ? pkg + name : name.includes(".") ? name : pkg + "." + name;
  return slashName(n);
}

/** the classes the platform loads by name, from the manifest and the services files, with what named each */
export function rootClasses(manifestBytes: Uint8Array, services: Record<string, string> = {}): Pick<Roots, "classes" | "why"> {
  const manifest = parseAXML(manifestBytes);
  const pkg = attrStr(manifest, "package") ?? "";
  const classes: string[] = [];
  const why = new Map<string, string>();
  const note = (cls: string, reason: string) => {
    if (!why.has(cls)) { classes.push(cls); why.set(cls, reason); }
  };

  const walk = (node: XmlNode, path: string) => {
    for (const c of node.children) {
      if (COMPONENT_TAGS.has(c.name)) {
        const n = attrStr(c, "name");
        if (n) note(qualify(pkg, n), `<${c.name}>`);
        // an alias's targetActivity is the class that actually runs; the alias name need
        // not be a class at all, which is how an alias LAUNCHER auto-stubs today
        const t = attrStr(c, "targetActivity");
        if (t) note(qualify(pkg, t), `<${c.name} targetActivity>`);
      }
      // <meta-data android:value="com.example.Thing"> is how androidx-startup, WorkManager
      // and most SDK initialisers name a class that appears in no bytecode
      if (c.name === "meta-data") {
        const v = attrStr(c, "value");
        if (v && CLASS_NAME.test(v)) note(slashName(v), `<meta-data> under ${path}`);
      }
      walk(c, COMPONENT_TAGS.has(c.name) ? `<${c.name} ${attrStr(c, "name") ?? ""}>` : path);
    }
  };

  const app = manifest.children.find((c) => c.name === "application");
  if (app) {
    const appName = attrStr(app, "name");
    if (appName) note(qualify(pkg, appName), "<application android:name>");
    walk(app, "<application>");
  }

  // META-INF/services/<iface> lists implementations ServiceLoader instantiates by name
  for (const [file, body] of Object.entries(services)) {
    for (const line of body.split("\n")) {
      const s = line.replace(/#.*/, "").trim();
      if (s) note(slashName(s), file);
    }
  }
  return { classes, why };
}

export function rootsOf(manifestBytes: Uint8Array, p: Program, services: Record<string, string> = {}): Roots {
  const { classes, why } = rootClasses(manifestBytes, services);
  // A component's whole surface is a root: the platform calls onCreate/onBind/onReceive/
  // query/... and nothing in the apk does.
  const methods: string[] = [];
  for (const c of classes) {
    const def = p.def(c);
    const dex = p.dexOf(c);
    if (!def || !dex) continue;
    for (const m of [...def.directMethods, ...def.virtualMethods]) {
      methods.push(c + "." + dex.method(m.methodIdx).name + dex.methodDesc(m.methodIdx));
    }
  }
  return { classes, methods, why };
}

/** Classes named by a string constant that also exist in the program. Over-approximate on
 *  purpose — it does not check that the string reaches Class.forName — because a missed
 *  root silently shrinks the work queue, while a spurious one only adds code that compiles.
 *  This is what covers reflection, DI graphs and ServiceLoader lookups spelled in code. */
export function reflectiveRoots(p: Program, dexes: { stringCount: number; stringLen(i: number): number; string(i: number): string }[]): string[] {
  const out = new Set<string>();
  for (const dex of dexes) {
    for (let i = 0; i < dex.stringCount; i++) {
      // cheap shape tests before the decode, the regex and the map lookup
      const len = dex.stringLen(i);
      if (len < 5 || len > 200) continue;
      const s = dex.string(i);
      if (s.charCodeAt(0) > 122 || !s.includes(".")) continue;
      if (!CLASS_NAME.test(s)) continue;
      const n = slashName(s);
      if (p.has(n)) out.add(n);
    }
  }
  return [...out];
}

