import { rt, type Gen } from "../runtime";
import { vcall } from "./jlang";

export function csText(value: unknown): string | Promise<string> { return rt.drive(csText$(value)); }
function* csText$(value: unknown): Gen<string> {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return String(yield vcall(value, "toString", "()Ljava/lang/String;"));
}
