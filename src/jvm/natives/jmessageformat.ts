// java.text.MessageFormat and android.icu.text.MessageFormat over one pattern engine. ICU adds
// named arguments, plural/select/selectordinal and optional apostrophe quoting to the JDK syntax.

import { rt, JObj, type NativeSpec } from "../runtime";
import { vcall, boxInt, stringOf, type JSB } from "./jlang";
import { newStringSet } from "./jutil";
import { JDate } from "./jtime";
import { defaultLocale, localeTag, type JLocale } from "./jvalues";
import { JAttribute, attributedIterator, styled, withPattern, formatAt, STYLE_NAMES, type JDateFormat } from "./jtext";
import { numberFormatFor, type JNumberFormat } from "./jnumberformat";

type Part = string | Arg | typeof HASH;
interface Arg {
  id: string | number; type: string; style: string; offset: number; cases: Map<string, Part[]> | null;
  /** the subformat a number, date or time argument builds */
  number?: JNumberFormat; date?: JDateFormat;
}
const HASH = { hash: true } as const;
const COMPLEX = new Set(["plural", "select", "selectordinal"]);

const badPattern = (why: string) => rt.mkThrowable("java/lang/IllegalArgumentException", why);

/** Parse a pattern. JDK quoting treats every apostrophe as a quote; ICU's default only quotes
 *  when the apostrophe precedes a syntax character (and `#` inside a plural). */
function parse(p: string, icu: boolean, inPlural = false, from = 0, nested = false): [Part[], number] {
  const parts: Part[] = [];
  let text = "", i = from, quoted = false;
  const flush = () => { if (text) parts.push(text); text = ""; };
  const special = (c: string | undefined) => c === "{" || c === "}" || c === "|" || (inPlural && c === "#");
  while (i < p.length) {
    const c = p[i];
    if (c === "'") {
      if (p[i + 1] === "'") { text += "'"; i += 2; continue; }
      if (quoted || !icu || special(p[i + 1])) { quoted = !quoted; i++; continue; }
      text += c; i++; continue;
    }
    if (quoted) { text += c; i++; continue; }
    if (c === "}" && nested) { flush(); return [parts, i + 1]; }
    if (c === "#" && inPlural) { flush(); parts.push(HASH); i++; continue; }
    if (c === "{") { flush(); const [arg, next] = parseArg(p, icu, i + 1); parts.push(arg); i = next; continue; }
    if (c === "}" && icu) throw badPattern("Unmatched '}' braces in the pattern");
    text += c; i++;
  }
  if (nested) throw badPattern("Unmatched '{' braces in the pattern");
  flush();
  return [parts, i];
}

/** the text up to the brace closing an argument's style, braces and quotes balanced */
function styleText(p: string, from: number): [string, number] {
  let depth = 0, quoted = false;
  for (let i = from; i < p.length; i++) {
    const c = p[i];
    if (c === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (c === "{") depth++;
    else if (c === "}" && depth-- === 0) return [p.slice(from, i), i + 1];
  }
  throw badPattern("Unmatched '{' braces in the pattern");
}

function parseArg(p: string, icu: boolean, from: number): [Arg, number] {
  const idEnd = p.slice(from).search(/[,}]/);
  if (idEnd < 0) throw badPattern("Unmatched '{' braces in the pattern");
  const name = p.slice(from, from + idEnd).trim();
  let i = from + idEnd;
  if (!/^\d+$/.test(name) && !(icu && /^[^\s\p{P}]+$/u.test(name))) throw badPattern("can't parse argument number: " + name);
  const arg: Arg = { id: /^\d+$/.test(name) ? Number(name) : name, type: "", style: "", offset: 0, cases: null };
  if (p[i] === "}") return [arg, i + 1];
  const typeEnd = p.slice(i + 1).search(/[,}]/);
  if (typeEnd < 0) throw badPattern("Unmatched '{' braces in the pattern");
  arg.type = p.slice(i + 1, i + 1 + typeEnd).trim().toLowerCase();
  i += 1 + typeEnd;
  if (p[i] === "}") return [arg, i + 1];
  if (!icu || !COMPLEX.has(arg.type)) {
    [arg.style, i] = styleText(p, i + 1);
    arg.style = arg.style.trim();
    return [arg, i];
  }
  arg.cases = new Map();
  for (i++; ;) {
    while (/\s/.test(p[i] ?? "")) i++;
    if (p[i] === "}") return [arg, i + 1];
    const key = /^[^\s{}]+/.exec(p.slice(i))?.[0];
    if (!key) throw badPattern("Bad " + arg.type + " pattern syntax");
    i += key.length;
    if (key.startsWith("offset:")) { arg.offset = Number(key.slice(7)); continue; }
    while (/\s/.test(p[i] ?? "")) i++;
    if (p[i] !== "{") throw badPattern("Bad " + arg.type + " pattern syntax");
    const [sub, next] = parse(p, icu, arg.type !== "select", i + 1, true);
    arg.cases.set(key, sub);
    i = next;
  }
}

type Values = (id: string | number) => Promise<unknown>;
type Run = { start: number; end: number; id: string | number };
interface Out { text: string; runs: Run[] }

async function numberOf(v: unknown): Promise<number | bigint | null> {
  if (typeof v === "number" || typeof v === "bigint") return v;
  if (!rt.iof(v, "java/lang/Number")) return null;
  // a boxed primitive (or BigInteger) formats exactly; any other Number through doubleValue
  const boxed = (v as { v?: unknown }).v;
  return typeof boxed === "number" || typeof boxed === "bigint" ? boxed : await vcall(v, "doubleValue", "()D") as number;
}

function eachArg(parts: Part[], f: (a: Arg) => void): void {
  for (const p of parts) if (typeof p === "object" && "id" in p) { f(p); p.cases?.forEach((c) => eachArg(c, f)); }
}
/** build a typed argument's subformat in `locale`, as the JDK's applyPattern does */
function subformat(a: Arg, locale: JLocale): void {
  if (a.type === "number") a.number ??= numberFormatFor(a.style, locale);
  else if ((a.type === "date" || a.type === "time") && !a.date) {
    const named = a.style ? STYLE_NAMES.indexOf(a.style.toUpperCase()) : 2;
    a.date = named < 0 ? withPattern(a.style, locale) : a.type === "date" ? styled(named, null, locale) : styled(null, named, locale);
  }
}

/** JDK ChoiceFormat: ascending `limit#text` (at least) or `limit<text` (above) alternatives */
function choose(style: string, n: number): string {
  let chosen: string | null = null;
  for (const alt of style.split("|")) {
    const m = /^\s*(-?\u221e|-?\d+(?:\.\d+)?)\s*([#<\u2264])(.*)$/s.exec(alt);
    if (!m) throw badPattern("Choice Pattern incorrect: " + style);
    const limit = m[1].endsWith("\u221e") ? (m[1].startsWith("-") ? -Infinity : Infinity) : Number(m[1]);
    if (chosen !== null && !(m[2] === "<" ? n > limit : n >= limit)) break;
    chosen = m[3];
  }
  return chosen ?? "";
}

class Formatter {
  constructor(readonly values: Values, readonly mf: JMessageFormat) {}
  out: Out = { text: "", runs: [] };

  async parts(parts: Part[], plural: string | null): Promise<void> {
    for (const part of parts) {
      if (typeof part === "string") this.out.text += part;
      else if ("hash" in part) this.out.text += plural ?? "#";
      else await this.arg(part);
    }
  }

  async arg(a: Arg): Promise<void> {
    const start = this.out.text.length, v = await this.values(a.id);
    if (v === undefined) { this.out.text += `{${a.id}}`; return; }
    if (a.cases) await this.complex(a, v);
    else this.out.text += await this.simple(a, v);
    this.out.runs.push({ start, end: this.out.text.length, id: a.id });
  }

  async complex(a: Arg, v: unknown): Promise<void> {
    const cases = a.cases!;
    if (a.type === "select") {
      const key = await stringOf(v);
      return this.parts(cases.get(key) ?? cases.get("other") ?? [], null);
    }
    const n = await numberOf(v);
    if (n === null) throw badPattern(`'${String(v)}' is not a Number`);
    const shown = Number(n) - a.offset;
    const key = cases.has("=" + Number(n)) ? "=" + Number(n)
      : new Intl.PluralRules(localeTag(this.mf.locale), { type: a.type === "selectordinal" ? "ordinal" : "cardinal" }).select(shown);
    return this.parts(cases.get(key) ?? cases.get("other") ?? [], this.mf.stock().fmt(shown));
  }

  async simple(a: Arg, v: unknown): Promise<string> {
    if (v === null) return "null";
    // a choice's nested pattern is parsed here, so its arguments build their subformats now
    subformat(a, this.mf.locale);
    const n = await numberOf(v);
    if (a.type === "number" || (!a.type && n !== null)) {
      if (n === null) throw badPattern("Cannot format given Object as a Number");
      return (a.number ?? this.mf.stock()).fmt(n);
    }
    if (a.type === "choice") {
      if (n === null) throw badPattern("Cannot format given Object as a Number");
      const text = choose(a.style, Number(n));
      if (!text.includes("{")) return text;
      const nested = new Formatter(this.values, this.mf);
      await nested.parts(parse(text, this.mf.icu)[0], null);
      return nested.out.text;
    }
    if (a.date) {
      if (!(v instanceof JDate)) throw badPattern("Cannot format given Object as a Date");
      return formatAt(a.date, v.t);
    }
    // an untyped Date argument, as the JDK formats it: DateFormat.getDateTimeInstance(SHORT, SHORT)
    if (v instanceof JDate) return formatAt(styled(3, 3, this.mf.locale), v.t);
    return stringOf(v);
  }
}

class JMessageFormat extends JObj {
  pattern = "";
  parts: Part[] = [];
  locale: JLocale = defaultLocale;
  icu = false;
  private stockFormat: JNumberFormat | null = null;
  apply(pattern: string | null): void {
    if (pattern === null) return rt.npe();
    this.parts = parse(pattern, this.icu)[0];
    this.pattern = pattern;
    eachArg(this.parts, (a) => subformat(a, this.locale));
  }
  /** the locale's NumberFormat, for untyped numbers and plural `#` */
  stock(): JNumberFormat { return this.stockFormat ??= numberFormatFor("", this.locale); }
  /** the JDK's setLocale affects only later patterns; ICU's rebuilds this pattern's subformats */
  setLocale(locale: JLocale | null): void {
    this.locale = locale ?? defaultLocale;
    this.stockFormat = null;
    if (this.icu) this.apply(this.pattern);
  }
  /** the argument source for an Object[] or, in ICU, a Map of names to values */
  async values(args: unknown): Promise<Values> {
    if (args === null) return async () => undefined;
    if (Array.isArray(args)) return async (id) => typeof id === "number" && id < args.length ? args[id] : undefined;
    if (!this.icu || !rt.iof(args, "java/util/Map")) throw badPattern("Cannot format given Object as a message");
    return async (id) => {
      const key = typeof id === "number" ? String(id) : id;
      return await vcall(args, "containsKey", "(Ljava/lang/Object;)Z", key) ? vcall(args, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", key) : undefined;
    };
  }
  async format(args: unknown): Promise<Out> {
    const f = new Formatter(await this.values(args), this);
    await f.parts(this.parts, null);
    return f.out;
  }
  ids(): (string | number)[] {
    const ids: (string | number)[] = [];
    eachArg(this.parts, (a) => ids.push(a.id));
    return ids;
  }
}

/** one ARGUMENT attribute per argument run; later runs (enclosing arguments) override the ones
 *  nested inside them, as AttributedString does */
function argumentIterator(out: Out, key: JAttribute, icu: boolean) {
  const owner: (string | number | undefined)[] = new Array(out.text.length), segments = [];
  for (const r of out.runs) owner.fill(r.id, r.start, r.end);
  for (let i = 0; i < owner.length;) {
    let j = i + 1;
    while (j < owner.length && owner[j] === owner[i]) j++;
    const id = owner[i];
    segments.push({ start: i, end: j, value: id === undefined ? undefined : typeof id === "number" || !icu ? boxInt(Number(id)) : id });
    i = j;
  }
  return attributedIterator(out.text, key, segments);
}

async function formatText(this: JMessageFormat, args: unknown): Promise<string> { return (await this.format(args)).text; }
async function formatInto(this: JMessageFormat, args: unknown, sb: JSB): Promise<JSB> { sb.s += await formatText.call(this, args); return sb; }
function register(cls: string, icu: boolean): void {
  let field: JAttribute | null = null;
  const argument = () => field ??= new (rt.link(`${cls}$Field`).ctor as typeof JAttribute)("message argument field");
  rt.register({ name: `${cls}$Field`, ctor: class extends JAttribute {}, sup: "java/text/Format$Field", statics: { get ARGUMENT() { return argument(); } } });
  const init = function (this: JMessageFormat, pattern: string, locale?: JLocale | null) {
    this.icu = icu;
    if (locale) this.locale = locale;
    this.apply(pattern);
  };
  const formatStatic = (pattern: string, args: unknown) => {
    const f = new (rt.link(cls).ctor as typeof JMessageFormat)();
    init.call(f, pattern);
    return formatText.call(f, args);
  };
  const methods: NativeSpec["methods"] = {
    "<init>(Ljava/lang/String;)V": init,
    "<init>(Ljava/lang/String;Ljava/util/Locale;)V": init,
    "static format(Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/String;": formatStatic,
    "format([Ljava/lang/Object;)Ljava/lang/String;": formatText,
    "format(Ljava/lang/Object;)Ljava/lang/String;": formatText,
    "format(Ljava/lang/Object;Ljava/lang/StringBuffer;Ljava/text/FieldPosition;)Ljava/lang/StringBuffer;": formatInto,
    "format([Ljava/lang/Object;Ljava/lang/StringBuffer;Ljava/text/FieldPosition;)Ljava/lang/StringBuffer;": formatInto,
    "formatToCharacterIterator(Ljava/lang/Object;)Ljava/text/AttributedCharacterIterator;": async function (this: JMessageFormat, args: unknown) {
      if (args === null) throw rt.mkThrowable("java/lang/NullPointerException", "formatToCharacterIterator must be passed non-null object");
      return argumentIterator(await this.format(args), argument(), icu);
    },
    "applyPattern(Ljava/lang/String;)V": function (this: JMessageFormat, p: string) { this.apply(p); },
    "toPattern()Ljava/lang/String;": function (this: JMessageFormat) { return this.pattern; },
    "setLocale(Ljava/util/Locale;)V": function (this: JMessageFormat, l: JLocale | null) { this.setLocale(l); },
    "getLocale()Ljava/util/Locale;": function (this: JMessageFormat) { return this.locale; },
    "clone()Ljava/lang/Object;": function (this: JMessageFormat) { return Object.assign(new (this.constructor as typeof JMessageFormat)(), this); },
    "equals(Ljava/lang/Object;)Z": function (this: JMessageFormat, o: unknown) { return +(o instanceof JMessageFormat && o.pattern === this.pattern); },
  };
  if (icu) Object.assign(methods, {
    "static format(Ljava/lang/String;Ljava/util/Map;)Ljava/lang/String;": formatStatic,
    "format(Ljava/util/Map;)Ljava/lang/String;": formatText,
    "usesNamedArguments()Z": function (this: JMessageFormat) { return +this.ids().some((id) => typeof id === "string"); },
    "getArgumentNames()Ljava/util/Set;": function (this: JMessageFormat) { return newStringSet(this.ids().map(String)); },
  });
  rt.register({ name: cls, ctor: class extends JMessageFormat {}, sup: icu ? "android/icu/text/UFormat" : "java/text/Format", methods });
}
register("java/text/MessageFormat", false);
register("android/icu/text/MessageFormat", true);
