import { rt } from "../jvm/runtime";
import { calledMissing } from "../native/host";

export function nativeRequirements(): string[] {
  return [...rt.nativeRequired].map(([library, api]) => `${library} (${api})`)
    .concat([...calledMissing].map((symbol) => `ELF ${symbol}`));
}
