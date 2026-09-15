import { expect, test } from "bun:test";
import { configureJvmCoverage, coverageProbeSource, jvmCoverage } from "../src/jvm/coverage";

test("fuzz coverage emits probes only while explicitly enabled", () => {
  configureJvmCoverage(false);
  expect(coverageProbeSource("android/view/View.draw()V")).toBe("");
  expect(jvmCoverage.snapshot()).toEqual({ enabled: false, methods: [] });

  configureJvmCoverage(true);
  expect(coverageProbeSource("android/view/View.draw()V")).toContain("R.cv(");
  jvmCoverage.hit("android/view/View.draw()V");
  expect(jvmCoverage.snapshot().methods).toEqual(["android/view/View.draw()V"]);
  jvmCoverage.reset();
  expect(jvmCoverage.snapshot().methods).toEqual([]);
  configureJvmCoverage(false);
});
