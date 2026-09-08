import { expect, test } from "bun:test";
import "./jtime";
import { rt, JObj } from "../runtime";
import { linkInit, vcall, newObj } from "./jlang";

const scall = async (name: string, method: string, descriptor: string, ...args: unknown[]) => vcall((await linkInit(name)).ctor, method, descriptor, ...args);
const date = (y: number, m: number, d: number) => scall("java/time/LocalDate", "of", "(III)Ljava/time/LocalDate;", y, m, d);
const unit = (name: string) => (rt.link("java/time/temporal/ChronoUnit").ctor as unknown as Record<string, unknown>)[`s$${name}`];
const until = (start: unknown, end: unknown, name: string) => vcall(start, "until", "(Ljava/time/temporal/Temporal;Ljava/time/temporal/TemporalUnit;)J", end, unit(name));

test("LocalDate counts elapsed calendar units with whole-month truncation", async () => {
  const jan = await date(2024, 1, 31), feb = await date(2024, 2, 29), mar = await date(2024, 3, 30);
  expect(await until(jan, feb, "DAYS")).toBe(29n);
  expect(await until(feb, jan, "WEEKS")).toBe(-4n);
  expect(await until(jan, feb, "MONTHS")).toBe(0n);
  expect(await until(jan, mar, "MONTHS")).toBe(1n);
  expect(await until(mar, jan, "MONTHS")).toBe(-1n);
  expect(await until(feb, await date(2025, 2, 28), "YEARS")).toBe(0n);
  expect(await until(await date(0, 1, 1), await date(1, 1, 1), "ERAS")).toBe(1n);
  expect(await until(await date(1900, 1, 1), await date(2025, 1, 1), "CENTURIES")).toBe(1n);
  await expect(until(jan, feb, "HOURS")).rejects.toBeDefined();
});

test("epoch days round trip across Gregorian cycles without timezone or short-year remapping", async () => {
  for (const [y, m, d] of [[0, 2, 29], [99, 12, 31], [-400, 3, 1], [1970, 1, 1], [2024, 3, 10], [999999999, 12, 31]]) {
    const original = await date(y, m, d), epoch = await vcall(original, "toEpochDay", "()J");
    const restored = await scall("java/time/LocalDate", "ofEpochDay", "(J)Ljava/time/LocalDate;", epoch);
    expect(await until(original, restored, "DAYS")).toBe(0n);
    expect(await vcall(restored, "getYear", "()I")).toBe(y);
    expect(await vcall(restored, "getMonthValue", "()I")).toBe(m);
    expect(await vcall(restored, "getDayOfMonth", "()I")).toBe(d);
  }
  expect(await vcall(await date(1970, 1, 1), "toEpochDay", "()J")).toBe(0n);
  expect(await until(await date(2024, 3, 10), await date(2024, 3, 11), "DAYS")).toBe(1n);
});

test("ChronoUnit delegates to temporal until and LocalDate delegates custom units", async () => {
  const start = await date(2020, 1, 1), end = await date(2020, 1, 10);
  expect(await vcall(unit("DAYS"), "between", "(Ljava/time/temporal/Temporal;Ljava/time/temporal/Temporal;)J", start, end)).toBe(9n);
  expect(rt.iof(unit("DAYS"), "java/time/temporal/TemporalUnit")).toBe(1);
  rt.register({ name: "test/DateUnit", ctor: class extends JObj {}, ifaces: ["java/time/temporal/TemporalUnit"], methods: {
    "between(Ljava/time/temporal/Temporal;Ljava/time/temporal/Temporal;)J": async (a: unknown, b: unknown) => {
      expect(a).toBe(start); expect(b).toBe(end); return 42n;
    },
  } });
  expect(await vcall(start, "until", "(Ljava/time/temporal/Temporal;Ljava/time/temporal/TemporalUnit;)J", end, await newObj("test/DateUnit"))).toBe(42n);
});
