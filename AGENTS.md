# webdroid — working notes for agents

Read `NOTES.md` first: architecture, the "do not regress" lessons, janitor invariants, debug tools.

## Verify
- `bun run typecheck` — must be clean (noUnusedLocals).
- `bun run test` — the ARM32 decoder unit tests (`src/native/arm.test.ts`).
- `bun run smoke apks/<apk>` — every class compiles.
- `bun run dev` (or `PORT=<n> bun run server.ts`) then `bun run e2e [--test <flow,...>] [--shots]` —
  drives `tests/e2e/flows/*` over Playwright; per-step `newMissing`/`newErrors`/`nativeRequired`/perf
  land in `tests/e2e/actual/<flow>/run.json`. Flows without goldens run in smoke mode.
- Janitor: `grep -rhoE 'name: "[a-z][a-z0-9]*(/[A-Za-z0-9_$]+)+"' src | sort | uniq -d` empty
  (ripgrep's `-h` is `--help`, so an `rg -oNh` form of this silently passes and tests nothing);
  `rg -n 'endsWith\("/' src` free of library names; no app/library names in `src/` outside
  comments explaining a real quirk.

## Parallel work: one worktree per task
The dev server rebundles on every page load and the e2e harness writes one shared output tree, so
concurrent work must be isolated:
```
git worktree add .worktrees/<task> -b wt/<task> main
ln -s ../../apks .worktrees/<task>/apks && ln -s ../../node_modules .worktrees/<task>/node_modules
cd .worktrees/<task> && PORT=<port> bun run server.ts &
WEBDROID_URL=http://localhost:<port> bun run e2e --test <flow>
```
`.worktrees/` is gitignored. Merge `wt/*` back to main sequentially, running the full `bun run e2e`
between merges (fitnotes / mihon / flappybird must not regress).

## Conventions
- Small focused commits, subject `<area>: <what>`; comments only for a non-obvious WHY.
- java.* lives in `src/jvm/natives/<pkg>.ts`, android.* in `src/android/<pkg>.ts`, the ARM32
  native tier in `src/native/`; module list = `src/natives.ts`.
