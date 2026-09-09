# Hand-off: Reddit on webdroid

State of the work as of commit `90f7af8` on `main`. The task: log into Reddit
(`therealalanableson` / `hero310usa`), make everything past the login work, implement missing
APIs, fix bugs, keep code minimal and generalizable, then run the full e2e suite at the end.
Only unit tests and typecheck have been run so far. The full `bun run e2e` regression run has
NOT been done, and no e2e test for Reddit exists.

## What works now (verified by screenshot on the no-JIT driver)

- Boot, intro, login sheet, login form, login request; the home feed with images and text.
- The navigation drawer: opens on the hamburger, lists Popular/News/Latest, Reddit Pro,
  Resources, Your Communities with icons; closes on scrim tap and on the back key.
- Image post: the lightbox activity with the image, vote/comment/share controls, "See the
  conversation" bottom sheet.
- Text post: the Compose post-detail screen (header, body, actions, ad, comment composer)
  renders, but see the timing blocker below.
- Profile tab, inbox (from earlier in the session, before this batch of fixes).
- A login plus drawer, post and scrolling produces no native fault and no failed image request.

## Commits from this stretch, in order

- `a318cda` res: float resources fill `TypedValue.data` with IEEE bits (drawer width was 0);
  analysis treats an unscanned body as suspending.
- `6ca6340` view: `LayoutParams.resolveLayoutDirection` called on add/setLayoutParams/detached
  inflate (ConstraintLayout start/end constraints); listener lists dispatched over a snapshot
  (a self-removing one-shot listener skipped Conductor's attach handler, so screens' presenters
  never attached: drawer empty, post detail blank).
- `db9d4ed` view: layout requests made during a layout pass are replayed after it (comment
  sheet content 0x0); `invalidate` and `requestLayout` hand off to compiled ancestor overrides
  (`AndroidViewHolder.onDescendantInvalidated`/`requestLayout`; a screen pushed into a
  Compose-hosted ScreenPager was never painted); native stacks past the 60-thread fixed span
  come from arena pages (every GraphQL call failed with "out of stack address space").
- `1141afa` native: a fault records a frame-pointer backtrace and the calls in progress
  (`wd.native.lastFault.regs.bt` / `.frames`).
- `90f7af8` jvm: the back-edge (`refuel`) yield uses the MessageChannel boundary instead of
  `setTimeout(0)`; `ViewGroup.cleanupLayoutState`; `Html.escapeHtml`; docs entry "Reddit: past
  the feed" in `docs/implementation-history.md`.

## Biggest blockers

1. **Opening a text post is very slow, and the last measurement is invalid.** Before the yield
   change, a tap on a text post took 9.5 s to show content on the no-JIT driver (port 4778),
   with 9.3 s spent inside the tap's input dispatch and only 8 frames drawn; a CPU profile of
   that window was 42% idle and 24% "(program)"; the main thread's latest suspension was inside
   ConstraintLayout's solver at a fuel refill (`rur.q` → `fdc.C` → `ConstraintLayout.onMeasure`).
   After switching the yield to MessageChannel, the timing run's pixel probe fired at 1.2 s but
   on the feed's own white pixel, and the post that opened threw on the then-missing
   `Html.escapeHtml`, so the screen stayed blank. Whether the yield change helps is unknown.
   `pdptime.sh` is the measurement script; its probe point `(0.3, 0.2)` against the page
   background `(246,248,249)` is unreliable because the feed is also white there.

2. **The GC storm in stock Chrome on arm64 is unresolved** (from earlier in the session, see the
   implementation-history entries). V8 Sparkplug baseline code for the compiled app (~211–230
   MB) exceeds the arm64 256 MB code range; "allocation failure" full GCs run ~16/s and starve
   the main thread. Only `--no-sparkplug --no-maglev` removes it, which is why all functional
   testing here uses the tier-off driver on port 4778. The `?sync=1` analysis is sound for
   Reddit's flow (0 liars, 0 sync-frame errors) but only cuts code size ~9%.

3. **Video does not play.** A video ad card in the feed shows "Connection issue — Your
   connection is offline or interrupted. Retry". Nothing about it appears in `wd.logs`, the
   OkHttp outcome hook (`hooks.js`) sees no failing request, and Crashlytics non-fatals are
   empty, so the media pipeline's failure is not visible through the current hooks. Which HTTP
   stack Reddit's ExoPlayer uses (Cronet, OkHttp or HttpURLConnection data source) was not
   determined; `xref.ts types` on the media3 data-source class names printed nothing (names are
   obfuscated). ExoPlayer/MediaCodec support has not been exercised at all.

4. **Coverage past the post screen is untested**: comments list content, voting, replying,
   search, subreddit pages, the Create tab, notifications, settings, the profile drawer pages,
   deep links. Each earlier screen took one or more webdroid fixes; expect more missing APIs
   (`/missing` endpoint, `wd.logs` "[webdroid missing]").

5. **Diagnostic hooks can corrupt thread identity.** Any page-side wrapper that `await`s before
   or after calling the wrapped compiled method must restore the Java thread with
   `wd.rt.st(t)` where `t = wd.rt.th()` was captured at entry. The earlier version of
   `hooks.js` did not, and that produced the "Cronet bad address 0x8 / Invalid http method /
   Invalid header" failures that were being chased as an emulator bug. `hooks.js` is fixed; the
   other hook scripts in the scratchpad (`cthook.js`, `phook*.js`, `postboot-vah*.js`, etc.)
   are sync wrappers or were written after this was understood, but treat any older ad-hoc hook
   with suspicion.

## Environment and tooling

- Dev server: `PORT=4093 bun run server.ts` (the drivers load `http://localhost:4093`).
- Persistent headless Playwright drivers (scratchpad `rd.ts`, started with `RD_PORT=<port>
  RD_FLAGS=... WEBDROID_URL=... bun rd.ts`): 4777 stock Chrome; 4778 tier-off
  (`--js-flags=--no-sparkplug --no-maglev`), used for all functional testing; 4779 tier-off with
  `?sync=1`/natcheck; 4780 stock with `?sync=1`. Four `rd.ts` processes were running at
  hand-off. Endpoints: `/boot {frames,suspend,natcheck}`, `/eval {js}`, `/tap {x,y}` (normalized),
  `/type`, `/swipe`, `/back`, `/settle {file,timeoutMs}`, `/shot {file}`, `/waitpx`, `/logs`,
  `/missing`, `/perf`, `/profile {ms,n}`, `/suspends`, `/hot`. `rd.sh <path> [json]` wraps curl
  with `RD_PORT`.
- Scratchpad dir: `/private/tmp/claude-501/-Users-kunalan-Projects-webdroid/0fcfa47e-26f2-4869-8598-44729b26bc4d/scratchpad`.
  Scripts: `login.sh <prefix>` (pixel-probe-driven login; env `WAIT`, `POSTBOOT=<js file>`,
  `FRAMES`, `SUSPEND`, `NATCHECK`), `drawer.sh`, `post.sh`, `exercise.sh` (login → drawer →
  post → back → scroll → fault/failed-request report), `pdptime.sh`, `errs.sh` (error lines
  from `wd.logs`), `hooks.js` (OkHttp outcome log in `globalThis.__http`, Crashlytics
  non-fatals in `__nf`), `xref.ts <apk> hash|calls|types|const|field ...` (dex cross-reference),
  `liars.py`, `wrap.py`. Screenshots in `shots/`.
- Page-side debugging: `wd.tree()` (view tree with boxes), `wd.find(id)`, `wd.vcall/scall`,
  `wd.rt.link(cls).ctor.prototype` (hook compiled methods via a configurable getter; method
  names are `m$<name>$<hash>`), `wd.rt.th()` (current Java thread), `wd.suspends.on` +
  `wd.suspends.last` (latest suspension site per thread), `wd.native.lastFault.regs`
  (`bt`, `frames`), `wd.native.cpus()`, `wd.native.jni.on` (JNI call trace into `wd.logs`),
  `wd.perf`, `wd.uiState`, `wd.mainDbg.phase`.
- Repo scripts used: `bun scripts/layout.ts apks/Reddit.xapk 0x<id>` (dump a layout XML),
  `bun scripts/dis.ts apks/Reddit.xapk <class> [method]` (dex disassembly).

## Known loose ends

- `docs/implementation-history.md` has the new section; `PLAN.md` was not updated.
- The back key now closes the drawer, but the first attempt in an earlier session did not; the
  difference was not isolated (the later attempt ran after the attach-listener fix).
- Occasional `gql-fed.reddit.com !! Canceled` and `alb.reddit.com ... Ad blocking detected:
  Spoofed` entries in the OkHttp log are app-side outcomes, not emulator failures.
- Cronet still reports nothing through the OkHttp hook when a request goes through the Cronet
  interceptor; the JNI trace (`wd.native.jni.on`) is the only view of those.
- `tests/e2e/drivers/webdroid.ts` was changed earlier in the session so `WEBDROID_URL` may carry
  a query string, and the driver uses `setSystemTime` instead of a frozen clock.
