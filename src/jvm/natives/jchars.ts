import { after, vcall } from "./jlang";

export function csText(value: unknown): string | Promise<string> {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return after(vcall(value, "toString", "()Ljava/lang/String;"), String);
}
/** CharSequence.length(), without building the text */
export function csLength(value: unknown): number | Promise<number> {
  return typeof value === "string" ? value.length : vcall(value, "length", "()I");
}
