// What a conformance class run answers: ConformRunner's lines, and the hash baselines keep of a passing test's name.
import { crc32 } from "node:zlib";

export type Outcome = { ok: boolean; message: string };

/** Intl's names for the calendars whose dates ChronoLocalDate.toString prefixes with their chronology ("Japanese Reiwa 8-10-16") */
const CALENDARS: Record<string, string> = { Japanese: "japanese", Minguo: "roc", ThaiBuddhist: "buddhist", "Hijrah-umalqura": "islamic-umalqura" };
/** yesterday, today and tomorrow in `calendar`, as ChronoLocalDate.toString writes the year of era, month and day */
const nearNow = (calendar: string) => [-864e5, 0, 864e5].map((offset) => {
  const parts = new Intl.DateTimeFormat("en-US", { calendar, timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(Date.now() + offset);
  const [y, m, d] = ["year", "month", "day"].map((type) => parts.find((p) => p.type === type)!.value);
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
});
/** a parameter taken from the clock (Instant.now(), a chronology's dateNow()) would rename its test on every run */
export const clockFree = (name: string) => name
  .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, (t) => Math.abs(Date.parse(t) - Date.now()) < 864e5 ? "<now>" : t)
  .replace(/\b(Japanese|Minguo|ThaiBuddhist|Hijrah-umalqura) \S+ (\d+-\d\d-\d\d)\b/g, (date, chronology: string, ymd: string) =>
    nearNow(CALENDARS[chronology]).includes(ymd) ? `${chronology} <now>` : date);
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
