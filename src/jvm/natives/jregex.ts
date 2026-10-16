// libcore's java.util.regex runs over ICU's regex natives (com.android.icu.util.regex): these
// answer them with JS RegExp translated from the Java syntax, and so do String's regex methods.
// A match reports every group's [start, end) into the caller's offsets array, -1 for a group
// that did not take part.
//
// ICU's `.`, `^` and `$` see the line terminators \n \v \f \r U+0085 U+2028 U+2029 (only \n under
// UNIX_LINES), so they are rewritten here rather than left to JS's own set. hitEnd/requireEnd
// are ICU RegexMatcher flags: set when an explored path reads at the end of input (hitEnd) or an
// end anchor succeeds there (requireEnd), kept across find() calls until the next reset, and set
// by a find() that fails. They are computed only when asked, by rerunning the operation with
// derived patterns over the input plus a sentinel character: the derived pattern consumes the
// sentinel at the first point where ICU would set the flag, and then succeeds unconditionally,
// so its first match in ICU's search order uses the sentinel exactly when the flag was set.

import { rt, driven, type Gen } from "../runtime.ts";
import { jarray } from "../abi.ts";
import { javaClassSets } from "../regex-sets.ts";
import { newObj } from "./jentry.ts";
import { handle, deref, release } from "../../android/handles.ts";

interface Derived { find: RegExp; sticky: RegExp; whole: RegExp }
interface CompiledPattern {
  source: string;
  /** global, with indices; sticky and whole-region variants are derived from it */
  re: RegExp;
  sticky: RegExp;
  whole: RegExp;
  /** JS capture index of each Java group (1-based); synthetic atomic-group captures are skipped */
  groups: number[];
  names: Map<string, number>;
  shape: Shape;
  /** hitEnd/requireEnd patterns per sentinel, compiled on first use; null when they do not compile */
  derived?: Map<string, [Derived, Derived] | null>;
}
const Op = { None: 0, LookingAt: 1, Matches: 2 } as const;
type Op = (typeof Op)[keyof typeof Op];
interface MatcherState {
  pattern: CompiledPattern;
  input: string;
  regionStart: number;
  regionEnd: number;
  transparent: boolean;
  /** the last match's [start, end), or null */
  last: [number, number] | null;
  /** where find() resumes without a previous match (ICU fMatchEnd) */
  next: number;
  /** a match succeeded since the last reset: a failed find() then stays failed */
  matched: boolean;
  // Flag history since the last reset, replayed on demand: the resetting operation, how many
  // find() searches followed it, and whether a find() failed without searching.
  base: Op;
  finds: number;
  forced: boolean;
  pendingBase: boolean;
  evaluated: number;
  evalFrom: number;
  hitEnd: boolean;
  requireEnd: boolean;
  /** the latest find()'s result, so a read right after it need not search again */
  found: [number, number] | null;
  /** the region with the sentinel appended, cached until the input or bounds change */
  probe: { text: string; base: number; s: string | undefined; withEnd: string } | null;
}

// Pattern's flag bits
const UNIX_LINES = 1, CASE_INSENSITIVE = 2, COMMENTS = 4, MULTILINE = 8, DOTALL = 32;

/** COMMENTS mode: unescaped whitespace and #-comments outside classes are not part of the pattern */
function stripComments(source: string): string {
  let out = "", inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") { out += c + (source[++i] ?? ""); continue; }
    if (inClass) { if (c === "]") inClass = false; out += c; continue; }
    if (c === "[") { inClass = true; out += c; continue; }
    if (/\s/.test(c)) continue;
    if (c === "#") { while (i < source.length && source[i] !== "\n") i++; continue; }
    out += c;
  }
  return out;
}
/** each capturing group of a JS source in order, with its name when it has one */
function captures(source: string): (string | null)[] {
  const out: (string | null)[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c !== "(") continue;
    if (source[i + 1] !== "?") out.push(null);
    else if (source[i + 2] === "<" && !/[=!]/.test(source[i + 3] ?? "")) out.push(/^\(\?<([^>]+)>/.exec(source.slice(i))![1]);
  }
  return out;
}

/** what a first pass over the Java source learns: its groups, and flags set by embedded groups
 *  (applied pattern-wide, as javaToJs folds them) */
interface Shape { names: (string | null)[]; multiline: boolean; dotall: boolean; unix: boolean; anchored: boolean }
const Mode = { Main: 0, Hit: 1, Req: 2, Plain: 3 } as const;
type Mode = (typeof Mode)[keyof typeof Mode];
interface Ctx extends Shape {
  src: string; i: number; mode: Mode; s: string; look: number;
  depth: number; first: boolean; anchorDepth: number; closedBelow: number;
}
const LT = "\\n-\\r\\x85\\u2028\\u2029";
/** ICU's \h: tab and the space separators */
const HSPACE = "\\t \\xA0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000";

function classEnd(src: string, i: number): number {
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i + 1;
  }
  return i;
}
function quantifier(c: Ctx): string {
  const m = /^(?:[*+?]|\{\d+(?:,\d*)?\})[?+]?/.exec(c.src.slice(c.i, c.i + 24));
  if (!m) return "";
  c.i += m[0].length;
  return m[0];
}
/** the source rewritten for `c.mode`: Main is the matching pattern; Hit and Req consume the
 *  sentinel where ICU sets hitEnd/requireEnd and then match anything; Plain treats the sentinel
 *  as the end of input without flag events */
function translate(src: string, shape: Shape, mode: Mode, s = ""): { out: string; groups: (string | null)[]; c: Ctx } {
  const c: Ctx = { ...shape, src, i: 0, mode, s, look: 0, depth: 0, first: true, anchorDepth: -1, closedBelow: Infinity };
  let out = "";
  const groups: (string | null)[] = [];
  // unbalanced `)` stays for the RegExp compiler to reject
  while (c.i < src.length) { out += seq(c, groups); if (c.i < src.length) { out += ")"; c.i++; } }
  return { out, groups, c };
}
function seq(c: Ctx, names: (string | null)[]): string {
  let out = "";
  while (c.i < c.src.length && c.src[c.i] !== ")") {
    if (c.src[c.i] === "|") {
      c.i++; out += "|";
      if (c.anchorDepth >= 0 && c.depth <= c.anchorDepth && c.depth < c.closedBelow) c.anchored = false;
      continue;
    }
    out += unit(c, names) + quantifier(c);
  }
  return out;
}
const END = (c: Ctx) => c.mode === Mode.Main ? "(?![\\s\\S])" : `(?=${c.s})`;
/** past the sentinel, which ends the derived patterns' text */
const PAST = "(?![\\s\\S])";
/** a zero-width assertion: after the sentinel, everything holds */
const assertion = (c: Ctx, core: string) => c.mode === Mode.Hit || c.mode === Mode.Req ? `(?:${core}|${PAST})` : core;
function consume(c: Ctx, atom: string): string {
  switch (c.mode) {
    case Mode.Main: return atom;
    case Mode.Hit: return `(?:${atom}|${c.s}|${PAST})`;
    case Mode.Req: return `(?:(?!${c.s})${atom}|${PAST})`;
    case Mode.Plain: return `(?:(?!${c.s})${atom})`;
  }
}
// The matching pattern tests the next or previous character against a negated class first,
// which JSC answers about as fast as its own anchors.
function dollar(c: Ctx, multiline: boolean, unix: boolean): string {
  const nl = unix ? "\\n" : LT, notCrLf = unix ? "" : "(?!(?<=\\r)\\n)";
  if (c.mode === Mode.Main) {
    return multiline ? `(?:(?![^${nl}])${notCrLf})` : `(?:(?![^${nl}])(?=${unix ? "\\n" : `(?:\\r\\n|[${LT}])`}?(?![\\s\\S]))${notCrLf})`;
  }
  const end = END(c), s = c.s;
  const beforeLine = `${notCrLf}(?=[${nl}])`;
  if (!multiline) {
    const cond = `${notCrLf}(?=${unix ? "\\n" : `(?:\\r\\n|[${LT}])`}?${end})`;
    return c.mode === Mode.Plain ? `(?:${cond})` : `(?:${cond}[^${s}]*${s}|${PAST})`;
  }
  // multi-line `$` sets the flags only at the very end
  return c.mode === Mode.Plain ? `(?:${end}|${beforeLine})` : `(?:${s}|${PAST}|${beforeLine})`;
}
function caret(c: Ctx, multiline: boolean): string {
  // javaToJs folds an embedded (?m) into the JS flags, so a multi-line pattern spells out its start
  if (!multiline) return assertion(c, "^");
  const nl = c.unix ? "\\n" : LT;
  // ICU's multi-line `^` does not match at the end of input, except in UNIX_LINES mode
  const notEnd = c.unix ? "" : c.mode === Mode.Main ? "(?!(?<=[\\s\\S])(?![\\s\\S]))" : `(?!(?<=[\\s\\S])${c.s})`;
  return assertion(c, `(?:(?<![^${nl}])${notEnd})`);
}
function unit(c: Ctx, names: (string | null)[]): string {
  const src = c.src, i = c.i, ch = src[i];
  const first = c.first;
  if (ch !== "(") c.first = false;
  if (ch === "(") return group(c, names);
  if (ch === "[") { c.i = classEnd(src, i); return consume(c, src.slice(i, c.i)); }
  if (ch === ".") { c.i++; return consume(c, c.dotall ? "." : c.unix ? "[^\\n]" : `[^${LT}]`); }
  if (ch === "^") {
    c.i++;
    if (first && !c.multiline) c.anchorDepth = c.depth;
    return caret(c, c.multiline);
  }
  if (ch === "$") { c.i++; return dollar(c, c.multiline, c.unix); }
  if (ch !== "\\") {
    const n = src.codePointAt(i)! > 0xffff ? 2 : 1;
    c.i += n;
    return consume(c, src.slice(i, i + n));
  }
  const e = src[i + 1] ?? "";
  c.i += 2;
  switch (e) {
    case "A": if (first) c.anchorDepth = c.depth; return assertion(c, c.multiline ? "(?<![\\s\\S])" : "^");
    case "z": return c.mode === Mode.Hit || c.mode === Mode.Req ? `(?:${c.s}|${PAST})` : END(c);
    case "Z": return dollar(c, false, false);
    case "b": case "B": return c.mode === Mode.Hit ? `(?:${c.s}|${PAST}|\\${e})` : assertion(c, "\\" + e);
    case "G": return "\\G";
    case "h": return consume(c, `[${HSPACE}]`);
    case "H": return consume(c, `[^${HSPACE}]`);
    case "v": return consume(c, `[${LT}]`);
    case "V": return consume(c, `[^${LT}]`);
    case "R": return consume(c, `(?:\\r\\n|[${LT}])`);
    case "Q": {
      const end = src.indexOf("\\E", c.i), stop = end < 0 ? src.length : end;
      const lit = src.slice(c.i, stop);
      c.i = end < 0 ? stop : stop + 2;
      if (c.mode === Mode.Main) return lit.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
      let out = "";
      for (const ch of lit) out += consume(c, ch.replace(/[.*+?^${}()|[\]\\\/]/, "\\$&"));
      return out;
    }
    case "k": {
      const m = /^<([^>]*)>/.exec(src.slice(c.i));
      if (!m) break;
      c.i += m[0].length;
      return backref(c, m[1]);
    }
    case "p": case "P": case "x": case "N":
      if (src[c.i] === "{") c.i = src.indexOf("}", c.i) + 1 || src.length;
      else c.i += e === "x" ? 2 : e === "N" ? 0 : 1;
      break;
    case "u": c.i += 4; break;
    case "c": c.i++; break;
    case "0": { let n = 0; while (n < 3 && /[0-7]/.test(src[c.i] ?? "")) { c.i++; n++; } break; }
    default:
      if (e >= "1" && e <= "9") {
        let n = +e;
        while (/\d/.test(src[c.i] ?? "") && n * 10 + +src[c.i] <= c.names.length) n = n * 10 + +src[c.i++];
        return backref(c, n);
      }
  }
  return consume(c, src.slice(i, c.i));
}
function backref(c: Ctx, ref: string | number): string {
  if (c.mode === Mode.Main) return typeof ref === "number" ? `\\${ref}` : `\\k<${ref}>`;
  const r = `\\k<${typeof ref === "number" ? c.names[ref - 1] ?? `__wdG${ref}` : ref}>`;
  return c.mode === Mode.Hit ? `(?:${r}|${c.s}|${PAST})` : c.mode === Mode.Req ? `(?:${r}|${PAST})` : r;
}
function group(c: Ctx, names: (string | null)[]): string {
  const src = c.src, open = /^\((?:\?(?:<([A-Za-z][A-Za-z0-9]*)>|([=!:>]|<[=!])|([a-zA-Z]*(?:-[a-zA-Z]*)?)([:)])))?/.exec(src.slice(c.i, c.i + 64))!;
  const [text, name, kind, flags, flagEnd] = open;
  c.i += text.length;
  if (flags !== undefined) {
    const on = flags.split("-")[0];
    if (on.includes("m")) c.multiline = true;
    if (on.includes("s")) c.dotall = true;
    if (on.includes("d")) c.unix = true;
    if (flagEnd === ")") return text;
  }
  const look = kind === "=" || kind === "!";
  if (look || kind === "<=" || kind === "<!") c.first = false;
  const capturing = !kind && flags === undefined;
  const index = capturing ? names.push(name ?? null) : 0;
  c.depth++;
  const inner = (mode: Mode) => {
    const saved = c.mode;
    c.mode = mode;
    const out = seq(c, names);
    c.mode = saved;
    return out;
  };
  const derived = c.mode === Mode.Hit || c.mode === Mode.Req;
  let out: string;
  if (look && derived) {
    // the lookahead's first match in ICU's order: when it took the sentinel, so does the path
    const at = c.i, groupCount = names.length, id = `__wdL${c.look++}`;
    const body = inner(c.mode);
    c.i = at; names.length = groupCount;
    const plain = inner(Mode.Plain);
    const event = `(?=(?<${id}>${body}))\\k<${id}>${PAST}`;
    out = kind === "=" ? `(?=(?<${id}>${body}))(?:\\k<${id}>${PAST}|)` : `(?:${event}|${PAST}|(?!${plain}))`;
  } else if (kind === "<=" || kind === "<!") {
    const body = inner(c.mode === Mode.Main ? Mode.Main : Mode.Plain);
    out = assertion(c, `(?${kind}${body})`);
  } else {
    const body = inner(c.mode);
    if (look) out = `(?${kind}${body})`;
    else if (!capturing) out = `${text}${body})`;
    else if (c.mode === Mode.Main) out = `${text}${body})`;
    else if (c.mode === Mode.Plain) out = `(?:${body})`;
    else out = `(?<${name ?? `__wdG${index}`}>${body})`;
  }
  if (src[c.i] === ")") c.i++;
  if (--c.depth < c.closedBelow && c.anchorDepth >= 0) c.closedBelow = c.depth + 1;
  return out;
}

const POSIX: Record<string, string> = {
  Lower: "a-z", Upper: "A-Z", ASCII: "\\x00-\\x7F", Alpha: "a-zA-Z", Digit: "0-9", Alnum: "a-zA-Z0-9",
  Punct: "!-\\/:-@\\[-`{-~", Graph: "!-~", Print: " -~", Blank: " \\t", Cntrl: "\\x00-\\x1F\\x7F", XDigit: "0-9a-fA-F", Space: " \\t\\n\\x0B\\f\\r",
  javaLowerCase: "\\p{Ll}", javaUpperCase: "\\p{Lu}", javaWhitespace: "\\s", javaLetter: "\\p{L}", javaDigit: "\\p{Nd}", javaLetterOrDigit: "\\p{L}\\p{Nd}",
};
/**
 * Translated syntax that JS RegExp still rejects, rewritten in place: embedded flag groups
 * `(?imsx)` (folded into the flags — Java scopes them from that point on, JS cannot),
 * possessive quantifiers (made greedy), the POSIX/java.lang.Character classes `\p{Alpha}` and
 * atomic groups. Returns the JS source plus extra flags.
 */
function javaToJs(src: string): [string, string] {
  let extra = "";
  let out = src.replace(/\(\?([a-zA-Z]+)(?:-[a-zA-Z]+)?\)/g, (_m, on: string) => {
    for (const c of on) if ("ims".includes(c) && !extra.includes(c)) extra += c;
    return "";
  });
  out = out.replace(/([*+?]|\{\d+(?:,\d*)?\})\+/g, "$1");
  // Java's \x{h...} is JS's \u{h...}
  out = out.replace(/(?<!\\)((?:\\\\)*)\\x\{([0-9a-fA-F]+)\}/g, "$1\\u{$2}");
  out = out.replace(/\\([pP])\{(?:Is|In)?([A-Za-z]+)\}/g, (m, neg: string, name: string) => {
    const cls = POSIX[name];
    return cls ? (neg === "P" ? `[^${cls}]` : `[${cls}]`) : m;
  });
  if (out.includes("(?>")) out = atomicGroups(out);
  return [out, extra];
}
function atomicGroups(src: string): string {
  // A lookahead fixes the chosen alternative before its backreference consumes it.
  // Synthetic captures would shift Java group numbers, so leave those patterns unsupported.
  let escaped = false, inClass = false, depth = 0, atomic = 0, captures = false;
  const opens: number[] = [];
  const pairs = new Map<number, number>();
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "]" && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (c === "(") {
      if (src.startsWith("(?>", i)) atomic++;
      else if (src[i + 1] !== "?" || (src.startsWith("(?<", i) && !/[=!]/.test(src[i + 3] ?? ""))) captures = true;
      opens.push(i); depth++;
    } else if (c === ")") {
      if (depth) pairs.set(opens.pop()!, i);
      depth--;
    }
  }
  if (!atomic) return src;
  if (captures) throw new SyntaxError("Atomic group with capturing groups is unsupported");
  let n = 0;
  const rewrite = (start: number, end: number): string => {
    let result = "";
    for (let i = start; i < end; i++) {
      const close = pairs.get(i);
      if (close === undefined) { result += src[i]; continue; }
      const body = rewrite(i + (src.startsWith("(?>", i) ? 3 : 1), close);
      if (src.startsWith("(?>", i)) {
        const name = `__wdAtomic${n++}`;
        result += `(?:(?=(?<${name}>${body}))\\k<${name}>)`;
      } else result += `(${body})`;
      i = close;
    }
    return result;
  };
  return rewrite(0, src.length);
}
const regexMemo = new Map<string, RegExp>();
/** translated source + JS flags → RegExp, memoised. Callers that use sticky/global flags must
 *  set lastIndex before every exec. */
function javaRegex(source: string, flags: string): RegExp {
  const key = flags + "/" + source;
  let re = regexMemo.get(key);
  if (!re) {
    if (regexMemo.size > 4096) regexMemo.clear();
    try { re = new RegExp(source, flags); }
    catch {
      const [js, extra] = javaToJs(source);
      let f = flags;
      for (const c of extra) if (!f.includes(c)) f += c;
      try { re = new RegExp(js, f); }
      catch {
        try { re = new RegExp(javaClassSets(js), f.replace(/[uv]/g, "") + "v"); }
        catch { re = new RegExp(js, f.replace("u", "")); }
      }
    }
    regexMemo.set(key, re);
  }
  return re;
}

function compilePattern(source: string, flags: number): CompiledPattern {
  const java = flags & COMMENTS ? stripComments(source) : source;
  // a first pass finds the groups and the embedded flags that the rewrite depends on
  const scan = translate(java, { names: [], multiline: !!(flags & MULTILINE), dotall: !!(flags & DOTALL), unix: !!(flags & UNIX_LINES), anchored: true }, Mode.Main);
  const shape: Shape = { names: scan.groups, multiline: scan.c.multiline, dotall: scan.c.dotall, unix: scan.c.unix, anchored: true };
  const main = translate(java, shape, Mode.Main);
  shape.anchored = main.c.anchorDepth >= 0 && main.c.anchored;
  let f = "ud";
  if (flags & CASE_INSENSITIVE) f += "i";
  if (shape.dotall) f += "s";
  let re: RegExp;
  try { re = javaRegex(main.out, f + "g"); } catch { re = javaRegex(main.out.replace(/\(\?<(?![=!])/g, "(?:<"), f.replace("u", "") + "g"); }
  const plain = re.flags.replace(/[gy]/g, "");
  const groups: number[] = [], names = new Map<string, number>();
  captures(re.source).forEach((name, i) => {
    if (name?.startsWith("__wdAtomic")) return;
    groups.push(i + 1);
    if (name) names.set(name, groups.length);
  });
  return { source: java, re, groups, names, shape, sticky: new RegExp(re.source, plain + "y"), whole: new RegExp(`(?:${re.source})(?![\\s\\S])`, plain + "y") };
}

const SENTINELS = ["\uffff", "\ufffe", "\ufdd0"];
function derived(p: CompiledPattern, s: string): [Derived, Derived] | null {
  const cache = p.derived ??= new Map();
  let d = cache.get(s);
  if (d !== undefined) return d;
  const escaped = `\\u${s.charCodeAt(0).toString(16)}`;
  try {
    const f = p.re.flags.replace(/[gdy]/g, "");
    d = [Mode.Hit, Mode.Req].map((mode) => {
      const re = javaRegex(translate(p.source, p.shape, mode, escaped).out, f + "g");
      const flags = re.flags.replace("g", "");
      return { find: re, sticky: new RegExp(re.source, flags + "y"), whole: new RegExp(`(?:${re.source})(?:(?=${escaped})|${PAST})`, flags + "y") };
    }) as [Derived, Derived];
  } catch { d = null; }
  cache.set(s, d);
  return d;
}

function region(m: MatcherState): [string, number] {
  const base = m.transparent ? 0 : m.regionStart;
  return [m.input.slice(base, m.regionEnd), base];
}
/** run `re` over the matcher's region from `from`, filling offsets on a match */
function run(m: MatcherState, re: RegExp, from: number, offsets: Int32Array): number {
  const [text, base] = region(m);
  re.lastIndex = from - base;
  const match = re.exec(text);
  if (!match) { m.last = null; return 0; }
  const start = match.index + base, end = start + match[0].length;
  m.last = [start, end];
  m.matched = true;
  offsets[0] = start; offsets[1] = end;
  m.pattern.groups.forEach((js, g) => {
    const span = match.indices?.[js];
    offsets[2 * g + 2] = span ? span[0] + base : -1;
    offsets[2 * g + 3] = span ? span[1] + base : -1;
  });
  return 1;
}

/** a fresh flag history, as ICU's reset(); `op` is the operation that starts it */
function resetFlags(m: MatcherState, op: Op): void {
  m.base = op; m.pendingBase = op !== Op.None;
  m.finds = 0; m.evaluated = 0; m.forced = false; m.hitEnd = false; m.requireEnd = false;
  m.matched = false;
}
function find(m: MatcherState, from: number, offsets: Int32Array): number {
  if (m.evaluated === m.finds) m.evalFrom = from;
  m.finds++;
  const r = run(m, m.pattern.re, from, offsets);
  m.found = m.last;
  return r;
}
/** where the search after `last` starts, or -1 when the region is exhausted */
function resume(m: MatcherState, last: [number, number]): number {
  if (last[0] !== last[1]) return last[1];
  return last[1] >= m.regionEnd ? -1 : nextIndex(m.input, last[1]);
}
/** fold one operation into the flags, rerunning it to learn its result when not the latest */
function fold(m: MatcherState, op: Op | "find", from: number): void {
  const p = m.pattern;
  if (m.probe === null) {
    const [text, base] = region(m), s = SENTINELS.find((c) => !text.includes(c));
    m.probe = { text, base, s, withEnd: text + (s ?? "") };
  }
  const { text, base, s, withEnd } = m.probe;
  const pair = s === undefined ? null : derived(p, s);
  const len = text.length;
  let last: [number, number] | null = null;
  if (op === "find") {
    if (m.evaluated === m.finds - 1) last = m.found;
    else {
      const re = p.re;
      re.lastIndex = from - base;
      const r = re.exec(text);
      if (r) last = [r.index + base, r.index + base + r[0].length];
    }
    m.evalFrom = last ? resume(m, last) : from;
  } else {
    const re = op === Op.LookingAt ? p.sticky : p.whole;
    re.lastIndex = m.regionStart - base;
    const r = re.exec(text);
    if (r) last = [r.index + base, r.index + base + r[0].length];
  }
  if (!pair) {
    // no derived pattern: the match reaching the end stands in for both flags
    const atEnd = !last || last[1] === m.regionEnd;
    if (atEnd) m.hitEnd = true;
    if (last && atEnd && /\$|\\[zZ]/.test(p.source)) m.requireEnd = true;
    return;
  }
  const flags = pair.map((d) => {
    if (op === "find") {
      const anchoredMiss = p.shape.anchored && from > m.regionStart;
      if (anchoredMiss) return false;
      const re = p.shape.anchored ? d.sticky : d.find;
      re.lastIndex = from - base;
      const r = re.exec(withEnd);
      // past the sentinel everything matches, but no search starts there
      if (!r || r.index > len) return false;
      if (!last) return true;
      const start = r.index + base;
      return start < last[0] || (start === last[0] && r.index + r[0].length > len);
    }
    const re = op === Op.LookingAt ? d.sticky : d.whole;
    re.lastIndex = m.regionStart - base;
    const r = re.exec(withEnd);
    return !!r && r.index + r[0].length > len;
  });
  // a find() that fails sets hitEnd unless only the region start could match
  if (flags[0] || (op === "find" && !last && !p.shape.anchored)) m.hitEnd = true;
  if (flags[1]) m.requireEnd = true;
}
function settle(m: MatcherState): void {
  if (m.pendingBase) { m.pendingBase = false; fold(m, m.base, m.regionStart); }
  while (m.evaluated < m.finds && !(m.hitEnd && m.requireEnd)) { fold(m, "find", m.evalFrom); m.evaluated++; }
  m.evaluated = m.finds;
  if (m.forced) m.hitEnd = true;
}

const matcher = (address: bigint) => deref<MatcherState>(address);
const nextIndex = (s: string, i: number) => i + ((s.codePointAt(i) ?? 0) > 0xffff ? 2 : 1);
const FREE = handle((address: bigint) => release(address));

const patternNatives: Record<string, (...args: never[]) => unknown> = {
  "compileImpl(Ljava/lang/String;I)J": driven(function* (source: string, flags: number): Gen {
    try { return handle(compilePattern(source, flags)); }
    catch (e) { return yield* syntaxError(e, source); }
  }),
  "getMatchedGroupIndexImpl(JLjava/lang/String;)I": (address: bigint, name: string) => deref<CompiledPattern>(address).names.get(name) ?? -1,
  "openMatcherImpl(J)J": (address: bigint) => handle({ pattern: deref<CompiledPattern>(address), input: "", regionStart: 0, regionEnd: 0,
    transparent: false, last: null, next: 0, matched: false, base: Op.None, finds: 0, forced: false, pendingBase: false,
    evaluated: 0, evalFrom: 0, hitEnd: false, requireEnd: false, found: null, probe: null } satisfies MatcherState),
  "getNativeFinalizer()J": () => FREE,
};
rt.registerJnis("com/android/icu/util/regex/PatternNative", patternNatives);

const matcherNatives: Record<string, (...args: never[]) => unknown> = {
  "setInputImpl(JLjava/lang/String;II)V": (address: bigint, input: string, start: number, end: number) => {
    const m = matcher(address);
    Object.assign(m, { input, regionStart: start, regionEnd: end, last: null, next: start, probe: null });
    resetFlags(m, Op.None);
  },
  "findImpl(JI[I)Z": (address: bigint, from: number, offsets: Int32Array) => {
    const m = matcher(address);
    resetFlags(m, Op.None);
    m.next = from;
    return find(m, from, offsets);
  },
  "findNextImpl(J[I)Z": (address: bigint, offsets: Int32Array) => {
    const m = matcher(address);
    // after an empty match the search moves on by a character, or it would find it again;
    // after a failure it stays failed
    const from = m.last ? resume(m, m.last) : m.matched ? -1 : m.next;
    if (from < 0) { m.last = null; m.forced = true; return 0; }
    return find(m, from, offsets);
  },
  "lookingAtImpl(J[I)Z": (address: bigint, offsets: Int32Array) => {
    const m = matcher(address);
    resetFlags(m, Op.LookingAt);
    m.next = m.regionStart;
    return run(m, m.pattern.sticky, m.regionStart, offsets);
  },
  "matchesImpl(J[I)Z": (address: bigint, offsets: Int32Array) => {
    const m = matcher(address);
    resetFlags(m, Op.Matches);
    m.next = m.regionStart;
    return run(m, m.pattern.whole, m.regionStart, offsets);
  },
  "groupCountImpl(J)I": (address: bigint) => matcher(address).pattern.groups.length,
  "hitEndImpl(J)Z": (address: bigint) => { const m = matcher(address); settle(m); return +m.hitEnd; },
  "requireEndImpl(J)Z": (address: bigint) => { const m = matcher(address); settle(m); return +m.requireEnd; },
  // anchoring bounds are what a region search gets, since it searches the region's text
  "useAnchoringBoundsImpl(JZ)V": () => {},
  "useTransparentBoundsImpl(JZ)V": (address: bigint, value: number) => { const m = matcher(address); m.transparent = !!value; m.probe = null; },
  "getNativeFinalizer()J": () => FREE,
};
rt.registerJnis("com/android/icu/util/regex/MatcherNative", matcherNatives);

function* syntaxError(e: unknown, source: string): Gen<never> {
  throw yield newObj("java/util/regex/PatternSyntaxException", "(Ljava/lang/String;Ljava/lang/String;I)V", (e as Error).message, source, -1);
}

// String's regex methods, which libcore's String answers through Pattern and Matcher
interface StringPattern { all: RegExp; first?: RegExp; whole: RegExp; groups: number[]; names: Map<string, number> }
const stringPatterns = new Map<string, StringPattern>();
/** Pattern.compile(source), cached per source, without the match indices only Matcher reads */
function stringPattern(source: string): StringPattern | Promise<never> {
  let p = stringPatterns.get(source);
  if (p === undefined) {
    let c: CompiledPattern;
    try { c = compilePattern(source, 0); } catch (e) { return rt.drive(syntaxError(e, source)) as Promise<never>; }
    const flags = c.re.flags.replace(/[dgy]/g, "");
    p = { all: new RegExp(c.re.source, flags + "g"), whole: new RegExp(c.whole.source, flags + "y"), groups: c.groups, names: c.names };
    if (stringPatterns.size >= 1024) stringPatterns.clear();
    stringPatterns.set(source, p);
  }
  return p;
}
export function stringMatches(s: string, source: string): number | Promise<never> {
  const p = stringPattern(source);
  if (p instanceof Promise) return p;
  p.whole.lastIndex = 0;
  return p.whole.test(s) ? 1 : 0;
}

const iae = (msg: string) => rt.mkThrowable("java/lang/IllegalArgumentException", msg);
/** Matcher's replacement syntax as literal text and JS capture indices */
function replacementParts(r: string, p: StringPattern): (string | number)[] {
  const parts: (string | number)[] = [];
  const count = p.groups.length;
  let text = "";
  for (let i = 0; i < r.length; i++) {
    const ch = r[i];
    if (ch === "\\") {
      if (++i === r.length) throw iae("character to be escaped is missing");
      text += r[i];
      continue;
    }
    if (ch !== "$") { text += ch; continue; }
    if (++i === r.length) throw iae("Illegal group reference: group index is missing");
    let group: number;
    if (r[i] === "{") {
      const name = /^[A-Za-z0-9]*/.exec(r.slice(i + 1))![0];
      i += name.length + 1;
      if (!name) throw iae("named capturing group has 0 length name");
      if (r[i] !== "}") throw iae("named capturing group is missing trailing '}'");
      if (name[0] <= "9") throw iae(`capturing group name {${name}} starts with digit character`);
      const named = p.names.get(name);
      if (named === undefined) throw iae(`No group with name {${name}}`);
      group = named;
    } else {
      group = r.charCodeAt(i) - 48;
      if (group < 0 || group > 9) throw iae("Illegal group reference");
      for (let d; i + 1 < r.length && (d = r.charCodeAt(i + 1) - 48) >= 0 && d <= 9 && group * 10 + d <= count; i++) group = group * 10 + d;
      if (group > count) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", `No group ${group}`);
    }
    if (text) parts.push(text);
    text = "";
    parts.push(group ? p.groups[group - 1] : 0);
  }
  if (text) parts.push(text);
  return parts;
}
export function stringReplace(s: string, source: string, replacement: string, all: boolean): string | Promise<never> {
  const p = stringPattern(source);
  if (p instanceof Promise) return p;
  const re = all ? p.all : p.first ??= new RegExp(p.all.source, p.all.flags.replace("g", ""));
  if (replacement.indexOf("$") < 0 && replacement.indexOf("\\") < 0) return s.replace(re, replacement);
  // Matcher reads the replacement only for a match, so a malformed one fails only then
  let parts: (string | number)[] | null = null, error: unknown;
  try { parts = replacementParts(replacement, p); } catch (e) { error = e; }
  return s.replace(re, (...match: (string | undefined)[]) => {
    if (!parts) throw error;
    let out = "";
    for (const part of parts) out += typeof part === "string" ? part : match[part] ?? "";
    return out;
  });
}

const LITERAL = /^[^\\[\](){}.*+?^$|]+$/;
export function stringSplit(s: string, source: string, limit: number): string[] | Promise<never> {
  const parts: string[] = [];
  let end = 0;
  // String.split's fastpath also takes an escaped non-alphanumeric character
  const literal = source.length === 2 && source[0] === "\\" ? (/[^0-9A-Za-z]/.test(source[1]) ? source[1] : null) : LITERAL.test(source) ? source : null;
  if (literal !== null) {
    for (let at; (limit <= 0 || parts.length < limit - 1) && (at = s.indexOf(literal, end)) >= 0; end = at + literal.length) parts.push(s.slice(end, at));
  } else {
    const p = stringPattern(source);
    if (p instanceof Promise) return p;
    const re = p.all;
    re.lastIndex = 0;
    for (let m; (limit <= 0 || parts.length < limit - 1) && (m = re.exec(s));) {
      const at = m.index, length = m[0].length;
      if (!length) {
        re.lastIndex = nextIndex(s, at);
        // a zero-width match at the start gives no leading empty string
        if (!at) continue;
      }
      parts.push(s.slice(end, at));
      end = at + length;
    }
  }
  if (!end) return jarray([s], "Ljava/lang/String;");
  parts.push(s.slice(end));
  if (!limit) while (parts.length && !parts[parts.length - 1]) parts.pop();
  return jarray(parts, "Ljava/lang/String;");
}
