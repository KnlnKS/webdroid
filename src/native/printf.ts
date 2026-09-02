// C99 printf/scanf formatting over an ArgReader (registers+stack, a va_list, or a JS array in tests).

import type { ArgReader } from "./host";

export function format(_fmt: string, _args: ArgReader): string { throw new Error("TODO format"); }

export type ScanSink = (kind: "i" | "l" | "f" | "s" | "n", value: number | bigint | string) => number;
export function scan(_input: string, _fmt: string, _out: ScanSink): number { throw new Error("TODO scan"); }
