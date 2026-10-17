import type { Outcome } from "../conform/results.ts";

/** Array-provider setup failures lose rows even when the run emits none of the baseline names. */
export function arrayProviderFailures(cls: string, skipped: Map<string, string>): string[] {
  const failures: string[] = [];
  for (const [name, reason] of skipped) if (/^array provider adapter:|GenericArrayTypeImpl.*cannot be cast to java.lang.Class/.test(reason)) {
    failures.push(`${cls}: ${name}  array-provider coverage lost (${reason.slice(0, 200)})`);
  }
  return failures;
}

/** A shared setup failure must not turn lost baseline executions into benign name drift. */
export function classSetupFailures(cls: string, tests: Map<string, Outcome>, baselineCount: number): string[] {
  if (!baselineCount) return [];
  const failure = [tests.get(cls), tests.get(`initializationError(${cls})`)].find((result) => result && !result.ok);
  return failure ? [`${cls}: class setup failed with ${baselineCount} baseline passing tests (${failure.message.slice(0, 200)})`] : [];
}
