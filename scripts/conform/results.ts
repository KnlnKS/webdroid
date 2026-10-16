// What a conformance class run answers: ConformRunner's lines, and the hash baselines keep of a passing test's name.
import { crc32 } from "node:zlib";

export type Outcome = { ok: boolean; message: string };

/** a parameter taken from the clock (Instant.now()) would rename its test on every run */
export const clockFree = (name: string) => name.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, (t) => Math.abs(Date.parse(t) - Date.now()) < 864e5 ? "<now>" : t);
export const hash = (name: string) => crc32(clockFree(name)).toString(16).padStart(8, "0");

/** the tests of one class run, and the skipped ones (by name, with the reason when TestNG gives one) */
export function parseLines(text: string): { tests: Map<string, Outcome>; skipped: Map<string, string> } {
  const tests = new Map<string, Outcome>(), skipped = new Map<string, string>();
  for (const line of text.split("\n").filter(Boolean)) {
    const [status, name, message = ""] = line.split("\t");
    if (status === "S") skipped.set(name, message); else tests.set(clockFree(name), { ok: status === "P", message });
  }
  return { tests, skipped };
}
