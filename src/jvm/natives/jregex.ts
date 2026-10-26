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
import { newObj } from "./jentry.ts";
import { handle, deref, release } from "../../android/handles.ts";
import { UNICODE_BLOCKS } from "./unicode-blocks.ts";

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
  /** the form String's regex methods use, made on first use */
  string?: StringPattern;
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
/** what a first pass over the Java source learns, which the rewrite depends on: its groups and the JS capture of each, the flags
 *  embedded groups set (applied pattern-wide: JS cannot scope them), whether a class nests or intersects, which only JS's `v`
 *  syntax writes (every class is then written in it), and whether the pattern starts at the search position (`\G`) */
interface Shape {
  names: (string | null)[]; js: number[];
  multiline: boolean; dotall: boolean; unix: boolean; icase: boolean; sets: boolean; sticky: boolean; anchored: boolean;
}
const Mode = { Main: 0, Hit: 1, Req: 2, Plain: 3 } as const;
type Mode = (typeof Mode)[keyof typeof Mode];
interface Ctx extends Shape {
  src: string; i: number; mode: Mode; s: string; look: number;
  depth: number; first: boolean; anchorDepth: number; closedBelow: number;
  /** the JS captures written so far, the JS capture of each Java group, and the atomic groups written */
  captures: number; capture: number[]; atomics: number;
}
const LT = "\\n-\\r\\x85\\u2028\\u2029";
/** ICU's \h: tab and the space separators */
const HSPACE = "\\t \\xA0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000";
/** ICU's \X, an extended grapheme cluster as far as JS's properties spell one: CR LF, a control, or a regional indicator pair, an
 *  emoji joiner sequence or any other character, extended by marks and joiners (Hangul jamo sequences and prepended marks break apart) */
const GRAPHEME = "(?:\\r\\n|[\\p{Cc}\\p{Zl}\\p{Zp}]|(?:\\p{RI}\\p{RI}|\\p{ExtPict}(?:[\\p{Gr_Ext}\\p{EMod}]*\\u200D\\p{ExtPict})*|[^\\p{Cc}\\p{Zl}\\p{Zp}])[\\p{Gr_Ext}\\p{EMod}\\u200D\\p{Mc}]*)";

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
  const c: Ctx = { ...shape, src, i: 0, mode, s, look: 0, depth: 0, first: true, anchorDepth: -1, closedBelow: Infinity, captures: 0, capture: [], atomics: 0 };
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
      if (c.sticky && c.depth === 0) throw new SyntaxError("\\G that starts one alternative only is unsupported");
      continue;
    }
    const groups = names.length, atom = unit(c, names), q = quantifier(c);
    // a possessive quantifier is the greedy one, atomic
    out += q.length > 1 && q.endsWith("+") ? atomic(c, atom + q.slice(0, -1), groups) : atom + q;
  }
  return out;
}
/** `body` as an atomic group: a lookahead captures its first match and a backreference consumes that, so nothing backtracks into it */
function atomic(c: Ctx, body: string, groups: number): string {
  // its capture precedes those of the groups in the body
  for (let g = groups; g < c.capture.length; g++) c.capture[g]++;
  c.captures++;
  const id = `__wdA${c.atomics++}`;
  return `(?:(?=(?<${id}>${body}))\\k<${id}>)`;
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
  // the JS flags never hold m: a multi-line start is spelled out with ICU's line terminators
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
  if (ch === "[") return consume(c, klass(c));
  if (ch === ".") { c.i++; return consume(c, c.dotall ? "." : c.unix ? "[^\\n]" : `[^${LT}]`); }
  if (ch === "^") {
    c.i++;
    if (first && !c.multiline) c.anchorDepth = c.depth;
    return caret(c, c.multiline);
  }
  if (ch === "$") { c.i++; return dollar(c, c.multiline, c.unix); }
  if (ch !== "\\") {
    // a quantifier with nothing to repeat, and braces that are not one
    if ("*+?{}".includes(ch)) throw new SyntaxError("Dangling meta character '" + ch + "'");
    const n = src.codePointAt(i)! > 0xffff ? 2 : 1;
    c.i += n;
    // ICU reads a `]` outside a class as itself
    return consume(c, ch === "]" ? "\\]" : src.slice(i, i + n));
  }
  const e = src[i + 1] ?? "";
  c.i += 2;
  switch (e) {
    case "A": if (first) c.anchorDepth = c.depth; return assertion(c, c.multiline ? "(?<![\\s\\S])" : "^");
    case "z": return c.mode === Mode.Hit || c.mode === Mode.Req ? `(?:${c.s}|${PAST})` : END(c);
    case "Z": return dollar(c, false, false);
    case "b": case "B": return c.mode === Mode.Hit ? `(?:${c.s}|${PAST}|\\${e})` : assertion(c, "\\" + e);
    case "G":
      // where the search starts: a pattern that starts with it matches only there
      if (i !== 0) throw new SyntaxError("\\G past the start of a pattern is unsupported");
      c.sticky = true;
      return "";
    case "h": return consume(c, `[${HSPACE}]`);
    case "H": return consume(c, `[^${HSPACE}]`);
    case "v": return consume(c, `[${LT}]`);
    case "V": return consume(c, `[^${LT}]`);
    case "R": return consume(c, `(?:\\r\\n|[${LT}])`);
    case "X": return consume(c, GRAPHEME);
    case "p": case "P": return consume(c, property(c, e === "P", false));
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
  }
  if (e >= "1" && e <= "9") {
    let n = +e;
    while (/\d/.test(src[c.i] ?? "") && n * 10 + +src[c.i] <= c.names.length) n = n * 10 + +src[c.i++];
    return backref(c, n);
  }
  // the class escapes \d \s \w and their complements are JS's; other letters JS rejects, as ICU does
  return consume(c, charEscape(c, e) ?? "\\" + e);
}
/** a literal character, as JS text that is valid in and out of classes in either syntax */
const literal = (ch: string) => "^$\\.*+?()[]{}|/".includes(ch) ? "\\" + ch : ch < "\x80" ? "\\x" + ch.charCodeAt(0).toString(16).padStart(2, "0") : ch;
/** the character Java's `\<e>` names, as JS text valid anywhere; null when that is not a character escape */
function charEscape(c: Ctx, e: string): string | null {
  const src = c.src;
  switch (e) {
    case "t": case "n": case "r": case "f": return "\\" + e;
    case "a": return "\\x07";
    case "e": return "\\x1B";
    case "x": {
      // ICU's \xh and \xhh, and \x{h...}
      const m = /^(?:\{([0-9a-fA-F]+)\}|[0-9a-fA-F]{1,2})/.exec(src.slice(c.i, c.i + 10));
      if (!m) throw new SyntaxError("Illegal hexadecimal escape sequence");
      c.i += m[0].length;
      return `\\u{${m[1] ?? m[0]}}`;
    }
    case "u": c.i += 4; return "\\u" + src.slice(c.i - 4, c.i);
    case "0": {
      let n = 0, k = 0;
      for (; k < 3 && /[0-7]/.test(src[c.i] ?? "") && n * 8 + +src[c.i] <= 0o377; k++) n = n * 8 + +src[c.i++];
      if (!k) throw new SyntaxError("Illegal octal escape sequence");
      return `\\u{${n.toString(16)}}`;
    }
    // ICU reads a \c that ends the pattern as those two characters
    case "c": return c.i < src.length ? `\\u{${(src.charCodeAt(c.i++) ^ 64).toString(16)}}` : "\\\\c";
  }
  return e === "" || /[A-Za-z0-9]/.test(e) ? null : literal(e);
}
/** class characters JS needs escaped in `u` syntax and in `v` syntax */
const U_CLASS = "\\]^-", V_CLASS = "()[]{}/-\\|&!#%,:;<=>@`~$*+.?^";
/** the Java class at `c.i`, as JS */
function klass(c: Ctx): string {
  const src = c.src;
  const negate = src[++c.i] === "^" ? (c.i++, "^") : "";
  // the operands of && (only a nested class unites with them in JS), each a union
  const parts = [""];
  for (let first = true; ; first = false) {
    const ch = src[c.i];
    if (ch === undefined) throw new SyntaxError("Unclosed character class");
    // a `]` that opens a class is a member
    if (ch === "]" && !first) { c.i++; break; }
    if (ch === "[") { c.sets = true; parts[parts.length - 1] += klass(c); continue; }
    if (ch === "&" && src[c.i + 1] === "&") { c.sets = true; c.i += 2; parts.push(""); continue; }
    const [atom, single] = classAtom(c);
    let item = atom;
    if (single &&src[c.i] === "-" && c.i + 1 < src.length && src[c.i + 1] !== "]" && src[c.i + 1] !== "[") {
      c.i++;
      const [end, bounds] = classAtom(c);
      if (!bounds) throw new SyntaxError("Illegal character range");
      item += "-" + end;
    }
    parts[parts.length - 1] += item;
  }
  return `[${negate}${parts.length === 1 ? parts[0] : parts.map((p) => `[${p}]`).join("&&")}]`;
}
/** a class member: its JS text, and whether it is one character, which can bound a range */
function classAtom(c: Ctx): [string, boolean] {
  const src = c.src, ch = src[c.i];
  if (ch !== "\\") {
    const n = src.codePointAt(c.i)! > 0xffff ? 2 : 1;
    c.i += n;
    return [(c.sets ? V_CLASS : U_CLASS).includes(ch) ? "\\" + ch : src.slice(c.i - n, c.i), true];
  }
  const e = src[c.i + 1] ?? "";
  c.i += 2;
  switch (e) {
    case "Q": {
      const end = src.indexOf("\\E", c.i), stop = end < 0 ? src.length : end;
      let out = "";
      for (const ch of src.slice(c.i, stop)) out += literal(ch);
      c.i = end < 0 ? stop : stop + 2;
      return [out, false];
    }
    case "p": case "P": return [property(c, e === "P", true), false];
    case "h": return [HSPACE, false];
    case "v": return [LT, false];
    case "H": case "V": c.sets = true; return [`[^${e === "H" ? HSPACE : LT}]`, false];
    case "d": case "D": case "s": case "S": case "w": case "W": case "b": return ["\\" + e, false];
  }
  const lit = charEscape(c, e);
  return lit === null ? ["\\" + e, false] : [lit, true];
}
/** `\p{name}` or `\pL` at `c.i`: a JS property escape, or the ranges ICU's name stands for, as a class or as class members */
function property(c: Ctx, negated: boolean, inClass: boolean): string {
  const src = c.src;
  let name = src[c.i++] ?? "";
  if (name === "{") {
    const close = src.indexOf("}", c.i);
    if (close < 0) throw new SyntaxError("Unclosed property name");
    name = src.slice(c.i, close);
    c.i = close + 1;
  }
  const ranges = POSIX[name.replace(/^I[sn]/, "")] ?? blockRange(name);
  if (ranges === undefined) {
    // ICU reads `Is` as introducing a category, a script or a binary property
    const bare = name.startsWith("Is") ? name.slice(2) : name;
    return `\\${negated ? "P" : "p"}{${jsProperty(bare) ?? bare}}`;
  }
  if (!inClass) return `[${negated ? "^" : ""}${ranges}]`;
  if (!negated) return ranges;
  // a complement within a class is a nested class
  c.sets = true;
  return `[^${ranges}]`;
}
function backref(c: Ctx, ref: string | number): string {
  // a digit after the reference would extend it
  if (c.mode === Mode.Main) return typeof ref === "number" ? `(?:\\${c.js[ref - 1] ?? ref})` : `\\k<${ref}>`;
  const r = `\\k<${typeof ref === "number" ? c.names[ref - 1] ?? `__wdG${ref}` : ref}>`;
  return c.mode === Mode.Hit ? `(?:${r}|${c.s}|${PAST})` : c.mode === Mode.Req ? `(?:${r}|${PAST})` : r;
}
function group(c: Ctx, names: (string | null)[]): string {
  const src = c.src, open = /^\((?:\?(?:<([A-Za-z][A-Za-z0-9]*)>|([=!:>]|<[=!])|([a-zA-Z]*(?:-[a-zA-Z]*)?)([:)])))?/.exec(src.slice(c.i, c.i + 64))!;
  const [text, name, kind, flags, flagEnd] = open;
  c.i += text.length;
  let modifiers = "";
  if (flags !== undefined) {
    const [on, off = ""] = flags.split("-");
    if (on.includes("m")) c.multiline = true;
    if (on.includes("s")) c.dotall = true;
    if (on.includes("d")) c.unix = true;
    if (flagEnd === ")") {
      if (on.includes("i")) c.icase = true;
      else if (off.includes("i") && c.icase) throw new SyntaxError("(?-i) in a case-insensitive pattern is unsupported");
      return "";
    }
    // the translation spells out the other flags; JS scopes case-insensitivity itself
    modifiers = (on.includes("i") ? "i" : "") + (off.includes("i") ? "-i" : "");
  }
  const look = kind === "=" || kind === "!";
  if (look || kind === "<=" || kind === "<!") c.first = false;
  const capturing = !kind && flags === undefined;
  const index = capturing ? names.push(name ?? null) : 0;
  if (capturing) c.capture[index - 1] = ++c.captures;
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
    const groups = names.length, body = inner(c.mode);
    if (look) out = `(?${kind}${body})`;
    else if (kind === ">") out = atomic(c, body, groups);
    else if (!capturing) out = `(?${modifiers}:${body})`;
    else if (c.mode === Mode.Main) out = `${text}${body})`;
    else if (c.mode === Mode.Plain) out = `(?:${body})`;
    else out = `(?<${name ?? `__wdG${index}`}>${body})`;
  }
  if (src[c.i] !== ")") throw new SyntaxError("Unclosed group");
  c.i++;
  if (--c.depth < c.closedBelow && c.anchorDepth >= 0) c.closedBelow = c.depth + 1;
  return out;
}

const POSIX: Record<string, string> = {
  Lower: "a-z", Upper: "A-Z", ASCII: "\\x00-\\x7F", Alpha: "a-zA-Z", Digit: "0-9", Alnum: "a-zA-Z0-9",
  Punct: "!-\\/:-@\\[-`\\{-~", Graph: "!-~", Print: " -~", Blank: " \\t", Cntrl: "\\x00-\\x1F\\x7F", XDigit: "0-9a-fA-F", Space: " \\t\\n\\x0B\\f\\r",
  javaLowerCase: "\\p{Ll}", javaUpperCase: "\\p{Lu}", javaWhitespace: "\\s", javaLetter: "\\p{L}", javaDigit: "\\p{Nd}", javaLetterOrDigit: "\\p{L}\\p{Nd}",
  javaJavaIdentifierStart: "\\p{L}\\p{Nl}\\p{Sc}\\p{Pc}", javaJavaIdentifierPart: "\\p{L}\\p{Nl}\\p{Sc}\\p{Pc}\\p{Nd}\\p{Mn}\\p{Mc}\\p{Cf}\\x00-\\x08\\x0E-\\x1B\\x7F-\\x9F",
  all: "\\u{0}-\\u{10ffff}",
};
const PROPERTY_KEYS: Record<string, string> = { gc: "General_Category", generalcategory: "General_Category", sc: "Script", script: "Script",
  scx: "Script_Extensions", scriptextensions: "Script_Extensions" };
/** a property name as ICU matches it, loosely (UAX44-LM3: case, spaces, hyphens and underscores aside) */
const looseKey = (name: string) => name.toLowerCase().replace(/[\s_-]/g, "");
/** `\p{form}` is a property JS knows; it has no table of the names it takes, so ask its parser */
const jsKnows = (form: string) => { try { new RegExp(`\\p{${form}}`, "u"); return true; } catch { return false; } };
const jsProperties = new Map<string, string | null>();
/** ICU's property name as JS spells it, or null: ICU matches names loosely and takes a lone script name, where JS
 *  takes canonical names and `Script=` */
function jsProperty(name: string): string | null {
  let known = jsProperties.get(name);
  if (known !== undefined) return known;
  const eq = name.indexOf("="), value = name.slice(eq + 1).trim();
  const key = eq < 0 ? "" : PROPERTY_KEYS[looseKey(name.slice(0, eq))];
  const spellings = [value, value.split(/[\s_-]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("_"), value.toUpperCase()];
  const forms = eq < 0 ? [...spellings, ...spellings.map((v) => `Script=${v}`)] : key ? spellings.map((v) => `${key}=${v}`) : [];
  known = forms.find(jsKnows) ?? null;
  jsProperties.set(name, known);
  return known;
}
let blocks: Map<string, string> | undefined;
/** the code point range of the block `\p{InX}`, `\p{Block=X}` or `\p{blk=X}` names */
function blockRange(name: string): string | undefined {
  const m = /^(?:In|(?:Block|blk)=)(.+)/.exec(name);
  if (!m) return undefined;
  if (!blocks) {
    blocks = new Map();
    const entries = UNICODE_BLOCKS.split(",");
    entries.forEach((entry, k) => {
      const [start, ...names] = entry.split(" "), end = k + 1 < entries.length ? parseInt(entries[k + 1], 16) - 1 : 0x10ffff;
      for (const n of names) blocks!.set(n, `\\u{${start}}-\\u{${end.toString(16)}}`);
    });
  }
  return blocks.get(looseKey(m[1]));
}
const compiled = new Map<string, CompiledPattern>();
/** Pattern.compile(source, flags), cached: apps compile one pattern again and again (String.split compiles one each call). Its
 *  RegExps are shared, so a caller of one with sticky or global flags sets lastIndex before every exec. */
function compilePattern(source: string, flags: number): CompiledPattern {
  const key = flags + "/" + source, known = compiled.get(key);
  if (known) return known;
  const java = flags & COMMENTS ? stripComments(source) : source;
  const first = translate(java, { names: [], js: [], multiline: !!(flags & MULTILINE), dotall: !!(flags & DOTALL), unix: !!(flags & UNIX_LINES),
    icase: !!(flags & CASE_INSENSITIVE), sets: false, sticky: false, anchored: true }, Mode.Main), scan = first.c;
  const shape: Shape = { names: first.groups, js: scan.capture, multiline: scan.multiline, dotall: scan.dotall, unix: scan.unix, icase: scan.icase, sets: scan.sets, sticky: scan.sticky, anchored: true };
  const main = translate(java, shape, Mode.Main);
  shape.anchored = main.c.anchorDepth >= 0 && main.c.anchored;
  const f = (shape.sets ? "vd" : "ud") + (shape.icase ? "i" : "") + (shape.dotall ? "s" : "");
  const re = new RegExp(main.out, f + (shape.sticky ? "gy" : "g"));
  const names = new Map<string, number>();
  main.groups.forEach((name, g) => { if (name) names.set(name, g + 1); });
  const p = { source: java, re, groups: main.c.capture, names, shape, sticky: new RegExp(re.source, f + "y"), whole: new RegExp(`(?:${re.source})(?![\\s\\S])`, f + "y") };
  if (compiled.size >= 4096) compiled.clear();
  compiled.set(key, p);
  return p;
}

const SENTINELS = ["\uffff", "\ufffe", "\ufdd0"];
function derived(p: CompiledPattern, s: string): [Derived, Derived] | null {
  const cache = p.derived ??= new Map();
  let d = cache.get(s);
  if (d !== undefined) return d;
  // the flags of a pattern bound to where the search starts are not derived
  if (p.shape.sticky) return null;
  const escaped = `\\u${s.charCodeAt(0).toString(16)}`;
  try {
    const f = p.re.flags.replace(/[gdy]/g, "");
    d = [Mode.Hit, Mode.Req].map((mode) => {
      const re = new RegExp(translate(p.source, p.shape, mode, escaped).out, f + "g");
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
/** Pattern.compile(source) without the match indices only Matcher reads */
function stringPattern(source: string): StringPattern | Promise<never> {
  let c: CompiledPattern;
  try { c = compilePattern(source, 0); } catch (e) { return rt.drive(syntaxError(e, source)) as Promise<never>; }
  if (c.string) return c.string;
  const flags = c.re.flags.replace(/[dgy]/g, "");
  return c.string = { all: new RegExp(c.re.source, flags + (c.shape.sticky ? "gy" : "g")), whole: new RegExp(c.whole.source, flags + "y"), groups: c.groups, names: c.names };
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
  // a sticky one starts where the last left it
  re.lastIndex = 0;
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
