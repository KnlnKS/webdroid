import type { JObj } from "../runtime.ts";
import { after, scall, vcall, newObj } from "./jentry.ts";

/** a java.util.UUID parsed from its canonical text */
export function uuidFromString(s: string): PromiseOrVal<JObj> {
  const h = s.split("-").map((p) => BigInt("0x" + p));
  return newObj("java/util/UUID", "(JJ)V", BigInt.asIntN(64, (h[0] << 32n) | (h[1] << 16n) | h[2]), BigInt.asIntN(64, (h[3] << 48n) | h[4]));
}

/** a java.util.Locale, which libcore implements; native code reads one through its Java API */
export type JLocale = JObj;
const tags = new WeakMap<JLocale, string>();
/** a Locale's BCP 47 tag; Locales are immutable, so each one's is kept */
export function localeTag(locale: JLocale): PromiseOrVal<string> {
  return tags.get(locale) ?? after(vcall(locale, "toLanguageTag", "()Ljava/lang/String;"), (tag: string) => { tags.set(locale, tag); return tag; });
}
// ICU script metadata; Intl's text direction can ignore explicit script subtags.
const rtlScripts = new Set("Arab Hebr Syrc Thaa Cprt Khar Hung Mand Mero Nkoo Orkh Phnx Lydi Armi Avst Mani Phli Phlp Prti Samr Sarb Mend Merc Narb Nbat Palm Hatr Adlm Rohg Sogd Sogo Elym Chrs Yezi Ougr".split(" "));
export function tagDirection(tag: string): number {
  if (tag === "und") return 0;
  try { const locale = new Intl.Locale(tag); return rtlScripts.has(locale.script ?? locale.maximize().script ?? "") ? 1 : 0; }
  catch { return 0; }
}
export const localeForTag = (tag: string): PromiseOrVal<JLocale> => scall("java/util/Locale", "forLanguageTag", "(Ljava/lang/String;)Ljava/util/Locale;", tag);
