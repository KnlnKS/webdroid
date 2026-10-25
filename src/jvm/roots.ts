// Where a program starts. Nothing here is a guess about a particular app: these are the
// entry points the platform itself calls, and the two ways an apk names a class in data
// rather than in bytecode — a manifest attribute and a services file.

import { slashName } from "./abi.ts";
import { parseAXML, attrStr, type XmlNode } from "../android/axml.ts";

/** component tags whose android:name the platform loads */
const COMPONENT_TAGS = new Set(["activity", "activity-alias", "service", "provider", "receiver"]);
/** "a.b.C" or "a.b.C$D": a string shaped like a binary class name */
export const CLASS_NAME = /^[a-z][\w.]*\.[A-Z][\w$]*$/;

/** a manifest's android:name as the class it names, as PackageParser builds it */
export function qualify(pkg: string, name: string): string {
  const n = name.startsWith(".") ? pkg + name : name.includes(".") ? name : pkg + "." + name;
  return slashName(n);
}

/** the classes the platform loads by name, from the manifest and the services files, with what named each */
export function rootClasses(manifestBytes: Uint8Array, services: Record<string, string> = {}): { classes: string[]; why: Map<string, string> } {
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
