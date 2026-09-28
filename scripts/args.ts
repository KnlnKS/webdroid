export function argv(args: string[], valueFlags: string[] = []) {
  return {
    flag: (n: string) => args.includes(n),
    opt: (n: string, d?: string) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; },
    positional: args.filter((a, i) => !a.startsWith("--") && !valueFlags.includes(args[i - 1] ?? "")),
  };
}

/** flag/option readers that remove what they read, leaving the positional arguments in `args` */
export function consume(args: string[]) {
  return {
    flag: (n: string) => { const i = args.indexOf(n); return i < 0 ? false : (args.splice(i, 1), true); },
    option: (n: string) => { const i = args.indexOf(n); return i < 0 ? undefined : args.splice(i, 2)[1]; },
  };
}

export function need(usage: string, n = 1): string[] {
  const a = process.argv.slice(2).filter((s) => !s.startsWith("--"));
  if (a.length < n) { console.error(`usage: ${usage}`); process.exit(2); }
  return a;
}
