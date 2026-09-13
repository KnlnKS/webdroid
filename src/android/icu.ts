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
