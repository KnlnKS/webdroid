import { JObj, rt } from "../jvm/runtime";
import { JLocale, localeTag } from "../jvm/natives/jvalues";

class JPluralRules extends JObj {
  rules = new Intl.PluralRules("en-US");
}
const pluralRules = new Map<string, JPluralRules>();

rt.register({
  name: "android/icu/text/PluralRules", ctor: JPluralRules,
  methods: {
    "static forLocale(Ljava/util/Locale;)Landroid/icu/text/PluralRules;": (locale: JLocale | null) => {
      if (!locale) throw rt.mkThrowable("java/lang/NullPointerException", "locale");
      const tag = localeTag(locale);
      let result = pluralRules.get(tag);
      if (!result) {
        result = new JPluralRules();
        result.rules = new Intl.PluralRules(tag);
        pluralRules.set(tag, result);
      }
      return result;
    },
    "select(D)Ljava/lang/String;": function (this: JPluralRules, value: number) { return this.rules.select(value); },
  },
});

/**
 * ICU's DateTimePatternGenerator.getBestPattern over the browser's CLDR: the skeleton's fields
 * become Intl options, and the locale's arrangement of them is read back as a pattern.
 */
export function bestDateTimePattern(tag: string, skeleton: string): string {
  const count: Record<string, number> = {};
  for (const ch of skeleton) if (/[A-Za-z]/.test(ch)) count[ch] = (count[ch] ?? 0) + 1;
  const text = (n: number) => n >= 5 ? "narrow" : n === 4 ? "long" : "short";
  const hour = count.h ?? count.K ?? count.H ?? count.k ?? count.j ?? count.J ?? 0;
  const month = count.M ?? count.L ?? 0, weekday = count.E ?? count.c ?? count.e ?? 0;
  const options: Intl.DateTimeFormatOptions = {
    ...(count.G ? { era: text(count.G) } : {}),
    ...(count.y ? { year: count.y === 2 ? "2-digit" : "numeric" } : {}),
    ...(month ? { month: month >= 3 ? text(month) : month === 2 ? "2-digit" : "numeric" } : {}),
    ...(count.d ? { day: count.d === 2 ? "2-digit" : "numeric" } : {}),
    ...(weekday ? { weekday: text(weekday) } : {}),
    ...(hour ? { hour: hour === 2 ? "2-digit" : "numeric" } : {}),
    ...(count.h || count.K ? { hour12: true } : count.H || count.k ? { hour12: false } : {}),
    ...(count.m ? { minute: count.m === 2 ? "2-digit" : "numeric" } : {}),
    ...(count.s ? { second: count.s === 2 ? "2-digit" : "numeric" } : {}),
    ...(count.z || count.v ? { timeZoneName: (count.z ?? count.v) >= 4 ? "long" : "short" } : {}),
  };
  const format = new Intl.DateTimeFormat(tag, options), hour12 = format.resolvedOptions().hour12;
  const named = (letter: string, style: string | undefined) => letter.repeat(style === "narrow" ? 5 : style === "long" ? 4 : 3);
  // every numeric field of this date is one digit unless the locale pads it
  const digits = (letter: string, value: string) => letter.repeat(Math.min(2, value.length));
  return format.formatToParts(new Date(2001, 0, 2, 3, 4, 5)).map(({ type, value }) => {
    switch (type) {
      case "era": return count.G > 3 ? "G".repeat(count.G) : "G";
      case "year": return options.year === "2-digit" ? "yy" : "y";
      case "month": return /^\d+$/.test(value) ? digits("M", value) : named("M", options.month);
      case "day": return digits("d", value);
      case "weekday": return named("E", options.weekday);
      case "hour": return digits(hour12 ? "h" : "H", value);
      case "minute": return digits("m", value);
      case "second": return digits("s", value);
      case "dayPeriod": return "a";
      case "timeZoneName": return options.timeZoneName === "long" ? "zzzz" : "z";
      default: return /[A-Za-z']/.test(value) ? "'" + value.replaceAll("'", "''") + "'" : value;
    }
  }).join("");
}
