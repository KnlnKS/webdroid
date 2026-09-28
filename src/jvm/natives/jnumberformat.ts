// java.text NumberFormat/DecimalFormat, android.icu.text's NumberFormat family and android.icu.number.
// Each carries a locale tag, style, currency, fraction digits and grouping over shared Intl formatters.

import { rt, JObj, type NativeSpec, driven, type Gen, fieldGetters, fieldSetters } from "../runtime";
import { vcall, box, JDouble, mkEnumSet, type JSimpleEnum } from "./jlang";
import { defaultLocale, localeTag, currency, currencyDigits, localeCurrency, intlNumber, type JCurrency, type JLocale } from "./jvalues";

type NumberStyle = "decimal" | "percent" | "currency";
type CurrencyDisplay = Intl.NumberFormatOptions["currencyDisplay"];
/** the Intl options for a format's fields; Java rounds HALF_EVEN */
const numberOptions = (style: NumberStyle, code: string, minFrac: number, maxFrac: number, grouping?: boolean, display?: CurrencyDisplay) => {
  const shown = style === "currency";
  const options: Intl.NumberFormatOptions & { roundingMode: "halfEven" } = { style, currency: shown ? code : undefined, currencyDisplay: shown ? display : undefined,
    minimumFractionDigits: minFrac, maximumFractionDigits: maxFrac, useGrouping: grouping, roundingMode: "halfEven" };
  return options;
};

export class JNumberFormat extends JObj {
  tag = localeTag(defaultLocale);
  style: NumberStyle = "decimal";
  currency = localeCurrency(defaultLocale) ?? "XXX";
  minFrac = 0; maxFrac = 3; grouping = true;
  /** the formatter for the fields above; `update` clears it */
  intl: Intl.NumberFormat | null = null;
  fmt(v: number | bigint): string {
    return (this.intl ??= intlNumber(this.tag, numberOptions(this.style, this.currency, this.minFrac, this.maxFrac, this.grouping))).format(v);
  }
}
const update = <F extends JNumberFormat>(f: F, change: Partial<JDecimalFormat>): F => Object.assign(f, change, { intl: null });
const digitCount = (n: number) => Math.min(20, Math.max(0, n));
/** a currency format shows its currency's own fraction digits */
function setCurrency<F extends JNumberFormat>(f: F, code: string): F {
  if (f.style !== "currency") return update(f, { currency: code });
  const digits = currencyDigits(code);
  return update(f, { currency: code, minFrac: digits, maxFrac: digits });
}
const nfMethods: NativeSpec["methods"] = {
  "format(D)Ljava/lang/String;": function (this: JNumberFormat, v: number) { return this.fmt(v); },
  "format(J)Ljava/lang/String;": function (this: JNumberFormat, v: bigint) { return this.fmt(v); },
  "format(Ljava/lang/Object;)Ljava/lang/String;": function (this: JNumberFormat, o: unknown) {
    if (typeof o === "number" || typeof o === "bigint") return this.fmt(o);
    if (!rt.iof(o, "java/lang/Number")) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Cannot format given Object as a Number");
    const n = vcall(o, "doubleValue", "()D");
    return n instanceof Promise ? n.then((v: number) => this.fmt(v)) : this.fmt(n);
  },
  "parse(Ljava/lang/String;)Ljava/lang/Number;": function (this: JNumberFormat, s: string) {
    const v = parseFloat(s.replace(/,/g, ""));
    if (Number.isNaN(v)) throw rt.mkThrowable("java/text/ParseException", "Unparseable number: " + s);
    return box(JDouble, v);
  },
  "setMaximumFractionDigits(I)V": function (this: JNumberFormat, n: number) { const maxFrac = digitCount(n); update(this, { maxFrac, minFrac: Math.min(this.minFrac, maxFrac) }); },
  "setMinimumFractionDigits(I)V": function (this: JNumberFormat, n: number) { const minFrac = digitCount(n); update(this, { minFrac, maxFrac: Math.max(minFrac, this.maxFrac) }); },
  "getMinimumFractionDigits()I": function (this: JNumberFormat) { return this.minFrac; },
  "getMaximumFractionDigits()I": function (this: JNumberFormat) { return this.maxFrac; },
  "setGroupingUsed(Z)V": function (this: JNumberFormat, g: number) { update(this, { grouping: !!g }); },
  "setRoundingMode(Ljava/math/RoundingMode;)V": () => {},
  "setMinimumIntegerDigits(I)V": () => {},
  "setParseIntegerOnly(Z)V": () => {},
  "setCurrency(Ljava/util/Currency;)V": function (this: JNumberFormat, c: JCurrency | null) { setCurrency(this, (c ?? rt.npe()).code); },
  "getCurrency()Ljava/util/Currency;": function (this: JNumberFormat) { return currency(this.currency); },
};
class JDecimalFormat extends JNumberFormat {
  posPrefix = ""; posSuffix = ""; negPrefix: string | null = null; negSuffix: string | null = null;
  /** a pattern's unquoted % or ‰ scales the number */
  multiplier = 1;
  fmt(v: number | bigint): string {
    const neg = typeof v === "bigint" ? v < 0n : v < 0 || Object.is(v, -0);
    const abs = neg ? -v : v, body = super.fmt(this.multiplier === 1 ? abs : Number(abs) * this.multiplier);
    return neg ? (this.negPrefix ?? "-" + this.posPrefix) + body + (this.negSuffix ?? this.posSuffix) : this.posPrefix + body + this.posSuffix;
  }
}
const nfInstance = (locale = defaultLocale) => {
  rt.link("java/text/DecimalFormat");
  return update(new JDecimalFormat(), { tag: localeTag(locale), currency: localeCurrency(locale) ?? "XXX" });
};
const integerInstance = (locale = defaultLocale) => update(nfInstance(locale), { maxFrac: 0 });
const percentInstance = (locale = defaultLocale) => update(nfInstance(locale), { style: "percent", maxFrac: 0 });
const currencyInstance = (locale = defaultLocale) => { const f = update(nfInstance(locale), { style: "currency" }); return setCurrency(f, f.currency); };
/** the subformat a MessageFormat `{n,number,style}` argument builds, as the JDK's makeFormat does */
export function numberFormatFor(style: string, locale: JLocale): JNumberFormat {
  switch (style.toLowerCase()) {
    case "": return nfInstance(locale);
    case "integer": return integerInstance(locale);
    case "percent": return percentInstance(locale);
    case "currency": return currencyInstance(locale);
    default: { const f = nfInstance(locale); applyDecimalPattern.call(f, style); return f; }
  }
}
rt.register({
  name: "java/text/NumberFormat", ctor: JNumberFormat, sup: "java/text/Format", ifaces: ["java/lang/Cloneable"],
  methods: {
    ...nfMethods,
    "static getInstance()Ljava/text/NumberFormat;": nfInstance,
    "static getInstance(Ljava/util/Locale;)Ljava/text/NumberFormat;": nfInstance,
    "static getNumberInstance()Ljava/text/NumberFormat;": nfInstance,
    "static getNumberInstance(Ljava/util/Locale;)Ljava/text/NumberFormat;": nfInstance,
    "static getIntegerInstance()Ljava/text/NumberFormat;": integerInstance,
    "static getIntegerInstance(Ljava/util/Locale;)Ljava/text/NumberFormat;": integerInstance,
    "static getPercentInstance()Ljava/text/NumberFormat;": percentInstance,
    "static getPercentInstance(Ljava/util/Locale;)Ljava/text/NumberFormat;": percentInstance,
    "static getCurrencyInstance()Ljava/text/NumberFormat;": currencyInstance,
    "static getCurrencyInstance(Ljava/util/Locale;)Ljava/text/NumberFormat;": currencyInstance,
  },
});

/** a pattern affix: quoted text is literal; an unquoted ¤ (with its spacing) is the currency Intl places */
const affix = (raw: string) => raw.replace(/'([^']*)'|\s*¤+\s*/g, (_, quoted?: string) => quoted === undefined ? "" : quoted || "'");
/** a DecimalFormat subpattern: prefix, number, suffix (quoted text is literal) */
const SUBPATTERN = /^((?:'[^']*'|[^#0,.;'])*)([#0,.]*(?:E0+)?)((?:'[^']*'|[^;'])*)$/;
function applyDecimalPattern(this: JDecimalFormat, p: string) {
  if (p == null) rt.npe();
  const [pos, neg] = p.split(/;(?=(?:[^']*'[^']*')*[^']*$)/), pm = SUBPATTERN.exec(pos), nm = neg === undefined ? null : SUBPATTERN.exec(neg);
  const literal = pm ? (pm[1] + pm[3]).replace(/'[^']*'/g, "") : "", body = pm?.[2] ?? p;
  const frac = /\.([0#]+)/.exec(body)?.[1] ?? "";
  update(this, {
    posPrefix: pm ? affix(pm[1]) : "", posSuffix: pm ? affix(pm[3]) : "",
    negPrefix: nm ? affix(nm[1]) : null, negSuffix: nm ? affix(nm[3]) : null,
    multiplier: literal.includes("%") ? 100 : literal.includes("‰") ? 1000 : 1,
    style: literal.includes("¤") ? "currency" : "decimal",
    grouping: body.includes(","), maxFrac: frac.length, minFrac: frac.replace(/#/g, "").length,
  });
}
rt.register({
  name: "java/text/DecimalFormat", ctor: JDecimalFormat, sup: "java/text/NumberFormat",
  methods: {
    ...nfMethods,
    "<init>()V": function () {},
    "<init>(Ljava/lang/String;)V": applyDecimalPattern,
    "<init>(Ljava/lang/String;Ljava/text/DecimalFormatSymbols;)V": applyDecimalPattern,
    "applyPattern(Ljava/lang/String;)V": applyDecimalPattern,
    "setDecimalFormatSymbols(Ljava/text/DecimalFormatSymbols;)V": () => {},
    ...fieldGetters({ "getPositivePrefix()Ljava/lang/String;": "posPrefix", "getPositiveSuffix()Ljava/lang/String;": "posSuffix" }),
    ...fieldSetters({ "setPositivePrefix(Ljava/lang/String;)V": "posPrefix", "setPositiveSuffix(Ljava/lang/String;)V": "posSuffix",
      "setNegativePrefix(Ljava/lang/String;)V": "negPrefix", "setNegativeSuffix(Ljava/lang/String;)V": "negSuffix" }),
    "getNegativePrefix()Ljava/lang/String;": function (this: JDecimalFormat) { return this.negPrefix ?? "-" + this.posPrefix; },
    "getNegativeSuffix()Ljava/lang/String;": function (this: JDecimalFormat) { return this.negSuffix ?? this.posSuffix; },
  },
});
rt.register({
  name: "java/text/DecimalFormatSymbols", ctor: class extends JObj {},
  methods: {
    "<init>()V": function () {},
    "<init>(Ljava/util/Locale;)V": function () {},
    "static getInstance()Ljava/text/DecimalFormatSymbols;": () => rt.make("java/text/DecimalFormatSymbols"),
    "static getInstance(Ljava/util/Locale;)Ljava/text/DecimalFormatSymbols;": () => rt.make("java/text/DecimalFormatSymbols"),
    "setDecimalSeparator(C)V": () => {},
    "getDecimalSeparator()C": () => 46,
    "getGroupingSeparator()C": () => 44,
  },
});

class JIcuNumberFormat extends JNumberFormat {}
const icuPercent = (locale: JLocale = defaultLocale) => update(new JIcuNumberFormat(), { tag: localeTag(locale), style: "percent", maxFrac: 0 });
class JCompactDecimalFormat extends JIcuNumberFormat {
  private formatter: Intl.NumberFormat;
  constructor(locale: JLocale = defaultLocale, display: "short" | "long" = "short") {
    super();
    this.formatter = intlNumber(localeTag(locale), { notation: "compact", compactDisplay: display, maximumSignificantDigits: 2 });
  }
  fmt(value: number | bigint): string { return this.formatter.format(value); }
}
const compactStyles = mkEnumSet("android/icu/text/CompactDecimalFormat$CompactStyle", ["SHORT", "LONG"]);
function compactInstance(locale: JLocale, style: JSimpleEnum): JCompactDecimalFormat {
  if (!locale || !style) rt.npe();
  if (style !== compactStyles[0] && style !== compactStyles[1]) throw rt.mkThrowable("java/lang/IllegalArgumentException", "compact style");
  return new JCompactDecimalFormat(locale, style === compactStyles[0] ? "short" : "long");
}
rt.register({ name: "android/icu/text/UFormat", ctor: class extends JObj {}, sup: "java/text/Format" });
rt.register({
  name: "android/icu/text/NumberFormat", ctor: JIcuNumberFormat, sup: "android/icu/text/UFormat",
  methods: {
    ...nfMethods,
    "static getPercentInstance()Landroid/icu/text/NumberFormat;": icuPercent,
    "static getPercentInstance(Ljava/util/Locale;)Landroid/icu/text/NumberFormat;": icuPercent,
  },
});
rt.register({ name: "android/icu/text/DecimalFormat", ctor: class extends JIcuNumberFormat {}, sup: "android/icu/text/NumberFormat", methods: nfMethods });
rt.register({
  name: "android/icu/text/CompactDecimalFormat", ctor: JCompactDecimalFormat, sup: "android/icu/text/DecimalFormat",
  methods: {
    ...nfMethods,
    "static getInstance(Ljava/util/Locale;Landroid/icu/text/CompactDecimalFormat$CompactStyle;)Landroid/icu/text/CompactDecimalFormat;": compactInstance,
    "static getInstance(Landroid/icu/util/ULocale;Landroid/icu/text/CompactDecimalFormat$CompactStyle;)Landroid/icu/text/CompactDecimalFormat;":
      (locale: { locale: JLocale }, style: JSimpleEnum) => compactInstance(locale?.locale, style),
  },
});

// android.icu.number (API 30): immutable settings chains that end in an Intl.NumberFormat.
// Unset precision is ICU's default: a currency's own digits, otherwise up to six places.
type NumberSettings = { unit: string | null; width: string; minFrac: number | null; maxFrac: number | null; tag: string | null };
const WIDTH_DISPLAY: Record<string, CurrencyDisplay> = { NARROW: "narrowSymbol", FULL_NAME: "name", ISO_CODE: "code" };
function settingsFormatter({ unit, width, minFrac, maxFrac, tag }: NumberSettings): Intl.NumberFormat {
  const locale = tag ?? localeTag(defaultLocale);
  if (unit === null) return intlNumber(locale, numberOptions("decimal", "", minFrac ?? 0, maxFrac ?? 6));
  const own = minFrac === null && maxFrac === null;
  const min = own ? currencyDigits(unit) : minFrac ?? 0, max = own ? min : Math.min(maxFrac ?? 20, 20);
  // HIDDEN keeps the currency's digits but shows no currency
  return intlNumber(locale, numberOptions(width === "HIDDEN" ? "decimal" : "currency", unit, min, max, undefined, WIDTH_DISPLAY[width] ?? "symbol"));
}
class JNumberSettings extends JObj {
  s: NumberSettings = { unit: null, width: "SHORT", minFrac: null, maxFrac: null, tag: null };
  private formatter: Intl.NumberFormat | null = null;
  intl() { return this.formatter ??= settingsFormatter(this.s); }
}
class JPrecision extends JObj { minFrac: number | null = null; maxFrac: number | null = null; }
class JFormattedNumber extends JObj { text = ""; }
const N = "android/icu/number/";
const unitWidths = mkEnumSet(`${N}NumberFormatter$UnitWidth`, ["NARROW", "SHORT", "FULL_NAME", "ISO_CODE", "FORMAL", "VARIANT", "HIDDEN"]);
mkEnumSet("android/icu/util/Currency$CurrencyUsage", ["STANDARD", "CASH"]);
type SettingsClass = new () => JNumberSettings;
function derive(from: JNumberSettings, change: Partial<NumberSettings>, cls = from.constructor as SettingsClass): JNumberSettings {
  const next = new cls();
  next.s = { ...from.s, ...change };
  return next;
}
function precision(minFrac: number | null, maxFrac: number | null, cls = "FractionPrecision"): JPrecision {
  if (minFrac !== null && (minFrac < 0 || minFrac > 999) || maxFrac !== null && (maxFrac < 0 || maxFrac > 999))
    throw rt.mkThrowable("java/lang/IllegalArgumentException", "Fraction length must be between 0 and 999 (inclusive).");
  const p = new (rt.link(N + cls).ctor as new () => JPrecision)();
  p.minFrac = minFrac; p.maxFrac = maxFrac;
  return p;
}
function formatNumber(f: JNumberSettings, value: number | bigint | string): JFormattedNumber {
  const out = new (rt.link(N + "FormattedNumber").ctor as new () => JFormattedNumber)();
  out.text = f.intl().format(value as number);
  return out;
}
const settingsMethods: NativeSpec["methods"] = {
  [`unit(Landroid/icu/util/MeasureUnit;)L${N}NumberFormatterSettings;`]: function (this: JNumberSettings, unit: JCurrency | null) {
    if (unit && !rt.iof(unit, "android/icu/util/Currency")) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "measure units other than currencies");
    return derive(this, { unit: unit?.code ?? null });
  },
  [`unitWidth(L${N}NumberFormatter$UnitWidth;)L${N}NumberFormatterSettings;`]: function (this: JNumberSettings, w: JSimpleEnum) {
    return derive(this, { width: (w ?? unitWidths[1]).ename });
  },
  [`precision(L${N}Precision;)L${N}NumberFormatterSettings;`]: function (this: JNumberSettings, p: JPrecision | null) {
    return derive(this, { minFrac: p?.minFrac ?? null, maxFrac: p?.maxFrac ?? null });
  },
};
rt.register({ name: N + "NumberFormatterSettings", ctor: JNumberSettings, methods: settingsMethods });
const localized = (from: JNumberSettings, locale: JLocale | null) =>
  derive(from, { tag: localeTag(locale ?? rt.npe()) }, rt.link(N + "LocalizedNumberFormatter").ctor as SettingsClass);
rt.register({
  name: N + "UnlocalizedNumberFormatter", ctor: class extends JNumberSettings {}, sup: N + "NumberFormatterSettings",
  methods: { [`locale(Ljava/util/Locale;)L${N}LocalizedNumberFormatter;`]: function (this: JNumberSettings, l: JLocale) { return localized(this, l); } },
});
rt.register({
  name: N + "LocalizedNumberFormatter", ctor: class extends JNumberSettings {}, sup: N + "NumberFormatterSettings",
  methods: {
    [`format(D)L${N}FormattedNumber;`]: function (this: JNumberSettings, v: number) { return formatNumber(this, v); },
    [`format(J)L${N}FormattedNumber;`]: function (this: JNumberSettings, v: bigint) { return formatNumber(this, v); },
    [`format(Ljava/lang/Number;)L${N}FormattedNumber;`]: driven(function* (this: JNumberSettings, n: JObj): Gen {
      if (n == null) rt.npe();
      // a BigDecimal formats from its exact decimal string, as ICU formats its digits
      const exact = rt.iof(n, "java/math/BigDecimal") || rt.iof(n, "java/math/BigInteger");
      return formatNumber(this, exact ? yield vcall(n, "toString", "()Ljava/lang/String;") : yield vcall(n, "doubleValue", "()D"));
    }),
  },
});
rt.register({
  name: N + "NumberFormatter", ctor: class extends JObj {},
  methods: {
    [`static with()L${N}UnlocalizedNumberFormatter;`]: () => rt.make(N + "UnlocalizedNumberFormatter"),
    [`static withLocale(Ljava/util/Locale;)L${N}LocalizedNumberFormatter;`]: (l: JLocale) => localized(new JNumberSettings(), l),
  },
});
rt.register({
  name: N + "FormattedNumber", ctor: JFormattedNumber, ifaces: ["java/lang/CharSequence"],
  methods: { "toString()Ljava/lang/String;": function (this: JFormattedNumber) { return this.text; } },
});
rt.register({
  name: N + "Precision", ctor: JPrecision,
  methods: {
    [`static integer()L${N}FractionPrecision;`]: () => precision(0, 0),
    [`static unlimited()L${N}Precision;`]: () => precision(0, 20, "Precision"),
    [`static fixedFraction(I)L${N}FractionPrecision;`]: (n: number) => precision(n, n),
    [`static minFraction(I)L${N}FractionPrecision;`]: (n: number) => precision(n, 20),
    [`static maxFraction(I)L${N}FractionPrecision;`]: (n: number) => precision(0, n),
    [`static minMaxFraction(II)L${N}FractionPrecision;`]: (a: number, b: number) => {
      if (a > b) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Fraction length must be between 0 and 999 (inclusive).");
      return precision(a, b);
    },
    // the currency's own digits: what an unset precision already does for a currency unit
    [`static currency(Landroid/icu/util/Currency$CurrencyUsage;)L${N}CurrencyPrecision;`]: (usage: unknown) => usage == null ? rt.npe() : precision(null, null, "CurrencyPrecision"),
  },
});
rt.register({ name: N + "FractionPrecision", ctor: class extends JPrecision {}, sup: N + "Precision" });
rt.register({ name: N + "CurrencyPrecision", ctor: class extends JPrecision {}, sup: N + "Precision" });
