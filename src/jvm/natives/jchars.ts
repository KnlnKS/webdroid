import { after, vcall } from "./jentry.ts";

export function csText(value: unknown): string | Promise<string> {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return after(vcall(value, "toString", "()Ljava/lang/String;"), String);
}
