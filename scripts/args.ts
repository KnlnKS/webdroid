// The two-line CLI parse every script was re-declaring. Positionals are found by index, not
// by value: `args.indexOf(a)` resolves a repeated token to its first occurrence, so
// `--limit 40 40` used to read the 40 after --limit as the apk name.
export function argv(args: string[], valueFlags: string[] = []) {
  return {
    flag: (n: string) => args.includes(n),
    opt: (n: string, d?: string) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; },
    positional: args.filter((a, i) => !a.startsWith("--") && !valueFlags.includes(args[i - 1] ?? "")),
  };
}
