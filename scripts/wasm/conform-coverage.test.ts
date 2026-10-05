import { expect, test } from "bun:test";
import { classFailureReason, classSetupFailures, noRunnableClass } from "./conform-coverage";
import type { Outcome } from "../conform/results";

const cls = "example.PrivateSuite";
const validation = `initializationError(${cls})`;
const noRunnable = `org.junit.runners.model.InvalidTestClassError: Invalid test class '${cls}':   1. No runnable methods`;
const failed = (message: string): Outcome => ({ ok: false, message });

test("only the exact pinned private-suite validation permits missing baseline rows", () => {
  const results = new Map([[validation, failed(noRunnable)]]);
  expect(noRunnableClass(cls, results)).toBe(true);
  expect(classFailureReason(cls, results)).toBe(noRunnable);
  expect(classSetupFailures(cls, results, 59, true)).toEqual([]);
  expect(classSetupFailures(cls, results, 59, false)).toHaveLength(1);
  results.set(validation, failed(noRunnable + "  2. Class should have exactly one public constructor"));
  expect(noRunnableClass(cls, results)).toBe(false);
  expect(classSetupFailures(cls, results, 59, true)).toHaveLength(1);
  results.set(cls, failed("java.lang.ExceptionInInitializerError"));
  expect(noRunnableClass(cls, results)).toBe(false);
  expect(classFailureReason(cls, results)).toBe("java.lang.ExceptionInInitializerError");
  expect(classSetupFailures(cls, results, 59, true)).toHaveLength(1);
});

test("shared new setup failures cannot become baseline drift or inherit an unrelated reason", () => {
  const results = new Map([[validation, failed("java.lang.ExceptionInInitializerError")]]);
  expect(classSetupFailures(cls, results, 65, true)).toHaveLength(1);
  expect(classSetupFailures(cls, results, 0, false)).toEqual([]);
  results.set("testOther(example.PrivateSuite)", failed(noRunnable));
  expect(classFailureReason(cls, results)).toBeUndefined();
  expect(classSetupFailures(cls, results, 65, true)).toHaveLength(1);
  const ordinary = new Map([["testValue(example.PrivateSuite)", failed("java.lang.AssertionError")]]);
  expect(classFailureReason(cls, ordinary)).toBeUndefined();
  expect(classSetupFailures(cls, ordinary, 65, false)).toEqual([]);
});
