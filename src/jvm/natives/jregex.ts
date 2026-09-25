import { rt, JObj } from "../runtime";
import { javaMatches, javaRegex, jToString, type JSB } from "./jlang";
import { jarray } from "../abi";

// ── java.util.regex over JS RegExp
class JPattern extends JObj { src = ""; flags = 0; }
class JMatcher extends JObj {
  re!: RegExp;
  input = "";
  m: RegExpExecArray | null = null;
  lastEnd = 0;
  appendPos = 0;
  regionS = 0;
  regionE = -1;    // -1 = input.length
  rEnd(): number { return this.regionE < 0 ? this.input.length : this.regionE; }
  sticky(): RegExp { return javaRegex(this.re.source, this.re.flags.replace(/[gy]/g, "") + "y"); }
  /** both ends anchored, so the engine backtracks into another alternative instead of settling
   *  for the first branch that matched a prefix */
  anchored(): RegExp { return javaRegex("(?:" + this.re.source + ")$", this.re.flags.replace(/[gy]/g, "") + "y"); }
}
function appendRepl(m: JMatcher, sb: JSB, r: string): JMatcher {
  if (!m.m) throw rt.mkThrowable("java/lang/IllegalStateException", "No match available");
  let out = "";
  for (let i = 0; i < r.length; i++) {
    const c = r[i];
    if (c === "\\") { out += r[++i] ?? ""; continue; }
    if (c === "$") {
      if (r[i + 1] === "{") {
        const j = r.indexOf("}", i);
        if (j < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "named capturing group is missing trailing '}'");
        out += m.m.groups?.[r.slice(i + 2, j)] ?? ""; i = j; continue;
      }
      let j = i + 1, num = "";
      while (j < r.length && /[0-9]/.test(r[j]) && Number(num + r[j]) < m.m.length) num += r[j++];
      if (!num) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Illegal group reference");
      out += m.m[Number(num)] ?? ""; i = j - 1; continue;
    }
    out += c;
  }
  sb.s += m.input.slice(m.appendPos, m.m.index) + out;
  m.appendPos = m.m.index + m.m[0].length;
  return m;
}
function namedGroup(matcher: JMatcher, name: string): { value: string | undefined; indices: [number, number] | undefined } {
  if (!matcher.m) throw rt.mkThrowable("java/lang/IllegalStateException", "No match available");
  if (name == null) rt.npe();
  if (!matcher.m.groups || !(name in matcher.m.groups))
    throw rt.mkThrowable("java/lang/IllegalArgumentException", `No group with name <${name}>`);
  return { value: matcher.m.groups[name], indices: matcher.m.indices?.groups?.[name] };
}
function toJsRegex(p: string, flags: number, global: boolean): RegExp {
  let f = "ud"; // `d`: group indices, which start(n)/end(n) report
  if (flags & 2) f += "i";
  if (flags & 8) f += "m";
  if (flags & 32) f += "s";
  if (global) f += "g";
  try { return javaRegex(p, f); }
  catch { return javaRegex(p.replace(/\(\?</g, "(?:<"), f.replace("u", "")); }
}
const compile = (p: string, flags = 0) => { const pt = new JPattern(); pt.src = p; pt.flags = flags; return pt; };
const quoteRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patternRe = (p: JPattern) => toJsRegex(p.flags & 16 ? quoteRe(p.src) : p.src, p.flags, true);
function splitPattern(pattern: JPattern, sequence: unknown, limit: number): string[] {
  const input = jToString(sequence), re = patternRe(pattern), out: string[] = [];
  re.lastIndex = 0;
  let index = 0;
  for (let match = re.exec(input); match; match = re.exec(input)) {
    const end = match.index + match[0].length;
    if (index === 0 && match.index === 0 && end === 0) {
      re.lastIndex += (input.codePointAt(re.lastIndex) ?? 0) > 0xffff ? 2 : 1;
      continue;
    }
    if (limit > 0 && out.length === limit - 1) {
      out.push(input.slice(index));
      return jarray(out, "Ljava/lang/String;");
    }
    out.push(input.slice(index, match.index));
    index = end;
    if (end === match.index) re.lastIndex += (input.codePointAt(re.lastIndex) ?? 0) > 0xffff ? 2 : 1;
  }
  if (index === 0) return jarray([input], "Ljava/lang/String;");
  out.push(input.slice(index));
  if (limit === 0) while (out.at(-1) === "") out.pop();
  return jarray(out, "Ljava/lang/String;");
}
rt.register({
  name: "java/util/regex/Pattern", ctor: JPattern, ifaces: ["java/io/Serializable"],
  statics: { CASE_INSENSITIVE: 2, MULTILINE: 8, DOTALL: 32, LITERAL: 16, UNICODE_CASE: 64 },
  methods: {
    "static compile(Ljava/lang/String;)Ljava/util/regex/Pattern;": compile,
    "static compile(Ljava/lang/String;I)Ljava/util/regex/Pattern;": compile,
    "static quote(Ljava/lang/String;)Ljava/lang/String;": quoteRe,
    "static matches(Ljava/lang/String;Ljava/lang/CharSequence;)Z": (p: string, s: unknown) => javaMatches(p, jToString(s)),
    "matcher(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;": function (this: JPattern, s: unknown) {
      const m = new JMatcher();
      m.re = patternRe(this);
      m.input = s == null ? "" : jToString(s);
      return m;
    },
    "pattern()Ljava/lang/String;": function (this: JPattern) { return this.src; },
    "toString()Ljava/lang/String;": function (this: JPattern) { return this.src; },
    "split(Ljava/lang/CharSequence;)[Ljava/lang/String;": function (this: JPattern, s: unknown) { return splitPattern(this, s, 0); },
    "split(Ljava/lang/CharSequence;I)[Ljava/lang/String;": function (this: JPattern, s: unknown, limit: number) { return splitPattern(this, s, limit); },
  },
});
rt.markers("java/util/regex/MatchResult");
rt.register({
  name: "java/util/regex/Matcher", ctor: JMatcher, ifaces: ["java/util/regex/MatchResult"],
  methods: {
    "find()Z": function (this: JMatcher) {
      this.re.lastIndex = Math.max(this.lastEnd, this.regionS);
      this.m = this.re.exec(this.input);
      if (this.m && this.m.index + this.m[0].length <= this.rEnd()) {
        this.lastEnd = this.m.index + Math.max(1, this.m[0].length);
        return 1;
      }
      this.m = null;
      return 0;
    },
    "matches()Z": function (this: JMatcher) {
      const re = this.anchored();
      re.lastIndex = this.regionS;
      this.m = re.exec(this.input.slice(0, this.rEnd()));
      return this.m ? 1 : 0;
    },
    "lookingAt()Z": function (this: JMatcher) {
      const re = this.sticky();
      re.lastIndex = this.regionS;
      this.m = re.exec(this.input);
      return this.m ? 1 : 0;
    },
    "group()Ljava/lang/String;": function (this: JMatcher) { return this.m?.[0] ?? null; },
    "group(I)Ljava/lang/String;": function (this: JMatcher, i: number) { return this.m?.[i] ?? null; },
    "groupCount()I": function (this: JMatcher) { return (this.m?.length ?? 1) - 1; },
    "start()I": function (this: JMatcher) { return this.m?.index ?? -1; },
    "end()I": function (this: JMatcher) { return this.m ? this.m.index + this.m[0].length : -1; },
    "start(I)I": function (this: JMatcher, g: number) {
      if (!this.m) throw rt.mkThrowable("java/lang/IllegalStateException", "No match available");
      if (g === 0) return this.m.index;
      const ix = (this.m as unknown as { indices?: (number[] | undefined)[] }).indices?.[g];
      return ix ? ix[0] : -1;
    },
    "end(I)I": function (this: JMatcher, g: number) {
      if (!this.m) throw rt.mkThrowable("java/lang/IllegalStateException", "No match available");
      if (g === 0) return this.m.index + this.m[0].length;
      const ix = (this.m as unknown as { indices?: (number[] | undefined)[] }).indices?.[g];
      return ix ? ix[1] : -1;
    },
    "start(Ljava/lang/String;)I": function (this: JMatcher, name: string) { return namedGroup(this, name).indices?.[0] ?? -1; },
    "end(Ljava/lang/String;)I": function (this: JMatcher, name: string) { return namedGroup(this, name).indices?.[1] ?? -1; },
    "group(Ljava/lang/String;)Ljava/lang/String;": function (this: JMatcher, name: string) { return namedGroup(this, name).value ?? null; },
    "toMatchResult()Ljava/util/regex/MatchResult;": function (this: JMatcher) {
      const c = new JMatcher(); c.re = this.re; c.input = this.input; c.m = this.m; c.lastEnd = this.lastEnd; return c;
    },
    // appendReplacement/appendTail: the classic find() loop that rewrites a string piecewise.
    // The replacement's $n / ${name} refer to this match's groups; a backslash escapes.
    "appendReplacement(Ljava/lang/StringBuffer;Ljava/lang/String;)Ljava/util/regex/Matcher;": function (this: JMatcher, sb: JSB, r: string) { return appendRepl(this, sb, r); },
    "appendReplacement(Ljava/lang/StringBuilder;Ljava/lang/String;)Ljava/util/regex/Matcher;": function (this: JMatcher, sb: JSB, r: string) { return appendRepl(this, sb, r); },
    "appendTail(Ljava/lang/StringBuffer;)Ljava/lang/StringBuffer;": function (this: JMatcher, sb: JSB) { sb.s += this.input.slice(this.appendPos); return sb; },
    "appendTail(Ljava/lang/StringBuilder;)Ljava/lang/StringBuilder;": function (this: JMatcher, sb: JSB) { sb.s += this.input.slice(this.appendPos); return sb; },
    "static quoteReplacement(Ljava/lang/String;)Ljava/lang/String;": (s: string) => s.replace(/[\\$]/g, "\\$&"),
    "usePattern(Ljava/util/regex/Pattern;)Ljava/util/regex/Matcher;": function (this: JMatcher, p: JPattern) {
      this.re = patternRe(p);
      this.m = null;
      return this;
    },
    "pattern()Ljava/util/regex/Pattern;": function (this: JMatcher) { const p = new JPattern(); p.src = this.re.source; return p; },
    "replaceAll(Ljava/lang/String;)Ljava/lang/String;": function (this: JMatcher, r: string) {
      return this.input.replace(javaRegex(this.re.source, this.re.flags), r);
    },
    "replaceFirst(Ljava/lang/String;)Ljava/lang/String;": function (this: JMatcher, r: string) {
      return this.input.replace(javaRegex(this.re.source, this.re.flags.replace("g", "")), r);
    },
    "reset()Ljava/util/regex/Matcher;": function (this: JMatcher) {
      this.lastEnd = 0; this.appendPos = 0;
      this.m = null;
      this.regionS = 0; this.regionE = -1;
      return this;
    },
    "reset(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;": function (this: JMatcher, s: unknown) {
      this.input = String(s ?? "");
      this.lastEnd = 0; this.appendPos = 0;
      this.m = null;
      return this;
    },
    "hitEnd()Z": () => 0,
    "useAnchoringBounds(Z)Ljava/util/regex/Matcher;": function (this: JMatcher) { return this; },
    "useTransparentBounds(Z)Ljava/util/regex/Matcher;": function (this: JMatcher) { return this; },
    "region(II)Ljava/util/regex/Matcher;": function (this: JMatcher, s: number, e: number) {
      this.regionS = s; this.regionE = e; this.lastEnd = s; this.m = null;
      return this;
    },
    "regionStart()I": function (this: JMatcher) { return this.regionS; },
    "regionEnd()I": function (this: JMatcher) { return this.rEnd(); },
    "find(I)Z": function (this: JMatcher, from: number) {
      this.re.lastIndex = from;
      this.m = this.re.exec(this.input);
      if (this.m) { this.lastEnd = this.m.index + Math.max(1, this.m[0].length); return 1; }
      return 0;
    },
  },
});
