export function argv(args: string[], valueFlags: string[] = []) {
  return {
    flag: (n: string) => args.includes(n),
    opt: (n: string, d?: string) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; },
    positional: args.filter((a, i) => !a.startsWith("--") && !valueFlags.includes(args[i - 1] ?? "")),
  };
}
