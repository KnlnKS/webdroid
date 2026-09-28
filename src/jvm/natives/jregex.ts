// libcore's java.util.regex runs over ICU's regex natives (com.android.icu.util.regex): these
// answer them with JS RegExp, via jlang's translation of the Java syntax. A match reports every
// group's [start, end) into the caller's offsets array, -1 for a group that did not take part.
// hitEnd errs toward true: a caller such as Scanner then reads more input rather than accepting a
// token that more input could have extended.

import { rt, driven, type Gen } from "../runtime";
import { javaRegex, newObj } from "./jlang";
import { handle, deref, release } from "../../android/handles";

interface CompiledPattern {
  source: string;
  /** global, with indices; sticky and whole-region variants are derived from it */
  re: RegExp;
  sticky: RegExp;
  whole: RegExp;
  /** JS capture index of each Java group (1-based); synthetic atomic-group captures are skipped */
  groups: number[];
  names: Map<string, number>;
}
interface MatcherState {
  pattern: CompiledPattern;
  input: string;
  regionStart: number;
  regionEnd: number;
  transparent: boolean;
  /** the last match's [start, end), or null */
  last: [number, number] | null;
  hitEnd: boolean;
  requireEnd: boolean;
}

// Pattern's flag bits; UNIX_LINES (1) only narrows which terminators `.` and the anchors see,
// and JS has one set
const CASE_INSENSITIVE = 2, COMMENTS = 4, MULTILINE = 8, DOTALL = 32;

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

function compilePattern(source: string, flags: number): CompiledPattern {
  const java = flags & COMMENTS ? stripComments(source) : source;
  let f = "ud";
  if (flags & CASE_INSENSITIVE) f += "i";
  if (flags & MULTILINE) f += "m";
  if (flags & DOTALL) f += "s";
  let re: RegExp;
  try { re = javaRegex(java, f + "g"); } catch { re = javaRegex(java.replace(/\(\?</g, "(?:<"), f.replace("u", "") + "g"); }
  const plain = re.flags.replace(/[gy]/g, "");
  const groups: number[] = [], names = new Map<string, number>();
  captures(re.source).forEach((name, i) => {
    if (name?.startsWith("__wdAtomic")) return;
    groups.push(i + 1);
    if (name) names.set(name, groups.length);
  });
  return { source: java, re, groups, names, sticky: new RegExp(re.source, plain + "y"), whole: new RegExp(`(?:${re.source})(?![\\s\\S])`, plain + "y") };
}

/** run `re` over the matcher's region from `from`, filling offsets on a match */
function run(m: MatcherState, re: RegExp, from: number, offsets: Int32Array): number {
  const base = m.transparent ? 0 : m.regionStart, text = m.input.slice(base, m.regionEnd);
  re.lastIndex = from - base;
  const match = re.exec(text);
  if (!match) { m.last = null; m.hitEnd = true; m.requireEnd = false; return 0; }
  const start = match.index + base, end = start + match[0].length;
  m.last = [start, end];
  m.hitEnd = end === m.regionEnd;
  m.requireEnd = m.hitEnd && /\$|\\[zZb]/.test(m.pattern.source);
  offsets[0] = start; offsets[1] = end;
  m.pattern.groups.forEach((js, g) => {
    const span = match.indices?.[js];
    offsets[2 * g + 2] = span ? span[0] + base : -1;
    offsets[2 * g + 3] = span ? span[1] + base : -1;
  });
  return 1;
}

const matcher = (address: bigint) => deref<MatcherState>(address);
const nextIndex = (s: string, i: number) => i + ((s.codePointAt(i) ?? 0) > 0xffff ? 2 : 1);
const FREE = handle((address: bigint) => release(address));

const patternNatives: Record<string, (...args: never[]) => unknown> = {
  "compileImpl(Ljava/lang/String;I)J": driven(function* (source: string, flags: number): Gen {
    try { return handle(compilePattern(source, flags)); }
    catch (e) {
      throw yield newObj("java/util/regex/PatternSyntaxException", "(Ljava/lang/String;Ljava/lang/String;I)V", (e as Error).message, source, -1);
    }
  }),
  "getMatchedGroupIndexImpl(JLjava/lang/String;)I": (address: bigint, name: string) => deref<CompiledPattern>(address).names.get(name) ?? -1,
  "openMatcherImpl(J)J": (address: bigint) => handle({ pattern: deref<CompiledPattern>(address), input: "", regionStart: 0, regionEnd: 0,
    transparent: false, last: null, hitEnd: false, requireEnd: false } satisfies MatcherState),
  "getNativeFinalizer()J": () => FREE,
};
for (const [sig, fn] of Object.entries(patternNatives)) rt.registerJni("com/android/icu/util/regex/PatternNative", sig, fn);

const matcherNatives: Record<string, (...args: never[]) => unknown> = {
  "setInputImpl(JLjava/lang/String;II)V": (address: bigint, input: string, start: number, end: number) => {
    Object.assign(matcher(address), { input, regionStart: start, regionEnd: end, last: null, hitEnd: false, requireEnd: false });
  },
  "findImpl(JI[I)Z": (address: bigint, from: number, offsets: Int32Array) => { const m = matcher(address); return run(m, m.pattern.re, from, offsets); },
  "findNextImpl(J[I)Z": (address: bigint, offsets: Int32Array) => {
    const m = matcher(address);
    // after an empty match the search moves on by a character, or it would find it again
    const from = !m.last ? m.regionStart : m.last[0] === m.last[1] ? nextIndex(m.input, m.last[1]) : m.last[1];
    if (from > m.regionEnd) { m.last = null; m.hitEnd = true; return 0; }
    return run(m, m.pattern.re, from, offsets);
  },
  "lookingAtImpl(J[I)Z": (address: bigint, offsets: Int32Array) => { const m = matcher(address); return run(m, m.pattern.sticky, m.regionStart, offsets); },
  "matchesImpl(J[I)Z": (address: bigint, offsets: Int32Array) => { const m = matcher(address); return run(m, m.pattern.whole, m.regionStart, offsets); },
  "groupCountImpl(J)I": (address: bigint) => matcher(address).pattern.groups.length,
  "hitEndImpl(J)Z": (address: bigint) => +matcher(address).hitEnd,
  "requireEndImpl(J)Z": (address: bigint) => +matcher(address).requireEnd,
  // anchoring bounds are what a region search gets, since it searches the region's text
  "useAnchoringBoundsImpl(JZ)V": () => {},
  "useTransparentBoundsImpl(JZ)V": (address: bigint, value: number) => { matcher(address).transparent = !!value; },
  "getNativeFinalizer()J": () => FREE,
};
for (const [sig, fn] of Object.entries(matcherNatives)) rt.registerJni("com/android/icu/util/regex/MatcherNative", sig, fn);
