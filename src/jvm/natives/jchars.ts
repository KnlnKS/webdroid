import { vcall } from "./jlang";

export async function csText(value: unknown): Promise<string> {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return String(await vcall(value, "toString", "()Ljava/lang/String;"));
}
