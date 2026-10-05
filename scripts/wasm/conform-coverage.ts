/** Array-provider setup failures lose rows even when neither tier emits the baseline names. */
export function arrayProviderFailures(cls: string, skipped: Map<string, string>): string[] {
  const failures: string[] = [];
  for (const [name, reason] of skipped) if (/^array provider adapter:|GenericArrayTypeImpl.*cannot be cast to java.lang.Class/.test(reason)) {
    failures.push(`${cls}: ${name}  array-provider coverage lost (${reason.slice(0, 200)})`);
  }
  return failures;
}
