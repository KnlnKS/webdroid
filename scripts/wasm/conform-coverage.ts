import type { Outcome } from "../conform/results";

/** Array-provider setup failures lose rows even when neither tier emits the baseline names. */
export function arrayProviderFailures(cls: string, skipped: Map<string, string>): string[] {
  const failures: string[] = [];
  for (const [name, reason] of skipped) if (/^array provider adapter:|GenericArrayTypeImpl.*cannot be cast to java.lang.Class/.test(reason)) {
    failures.push(`${cls}: ${name}  array-provider coverage lost (${reason.slice(0, 200)})`);
  }
  return failures;
}

/** Only an explicit class result or a solitary JUnit validation result describes the whole class. */
export function classFailureReason(cls: string, tests: Map<string, Outcome>): string | undefined {
  const direct = tests.get(cls);
  if (direct && !direct.ok) return direct.message;
  const validation = tests.get(`initializationError(${cls})`);
  if (tests.size === 1 && validation && !validation.ok) return validation.message;
}

export function noRunnableClass(cls: string, tests: Map<string, Outcome>): boolean {
  const validation = tests.get(`initializationError(${cls})`);
  return tests.size === 1 && validation?.ok === false && validation.message.replace(/\s+/g, " ").trim() ===
    `org.junit.runners.model.InvalidTestClassError: Invalid test class '${cls}': 1. No runnable methods`;
}

export function noRunnableCoverage(cls: string, tests: Map<string, Outcome>, peer?: Map<string, Outcome>): boolean {
  return noRunnableClass(cls, tests) && (!peer || noRunnableClass(cls, peer));
}

/** A shared setup failure must not turn lost baseline executions into benign name drift. */
export function classSetupFailures(cls: string, tests: Map<string, Outcome>, baselineCount: number, pinnedNoRunnable: boolean): string[] {
  if (!baselineCount || pinnedNoRunnable && noRunnableClass(cls, tests)) return [];
  const failure = [tests.get(cls), tests.get(`initializationError(${cls})`)].find((result) => result && !result.ok);
  return failure ? [`${cls}: class setup failed with ${baselineCount} baseline passing tests (${failure.message.slice(0, 200)})`] : [];
}
