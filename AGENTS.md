# webdroid — in-browser Android emulator

Goal: run FitNotes.apk → mihon → flappybird → Among Us.xapk fully client-side
(only server = static files + CORS proxy + a TCP relay). Verify visually vs real screenshots.

## Verify
- `bun run typecheck` — must be clean (noUnusedLocals).
- `bun run test` — the ARM32 decoder unit tests (`src/native/arm.test.ts`) and the gzip trailer
  arithmetic (`src/jvm/natives/jzip.test.ts`).
- `bun run smoke apks/<apk>` — every class compiles.
- `bun run dev` (or `PORT=<n> bun run server.ts`) then `bun run e2e [--test <flow,...>] [--shots]` —
  drives `tests/e2e/flows/*` over Playwright; per-step `newMissing`/`newErrors`/`nativeRequired`/perf
  land in `tests/e2e/actual/<flow>/run.json`. Flows without goldens run in smoke mode.
- Janitor: `grep -rhoE 'name: "[a-z][a-z0-9]*(/[A-Za-z0-9_$]+)+"' src | sort | uniq -d` empty,
  and `rg -n 'endsWith\("/' src` free of library names. Write the first one with `grep`, not
  `rg -oNh`: ripgrep's `-h` is `--help`, so that form prints ripgrep's help text, finds no
  duplicate lines in it, and passes unconditionally — it is how two duplicate `java/io/FileFilter`
  registrations survived. See "the other janitor invariants" for the rest.

## Architecture (decided)
- **Execution**: DEX bytecode → JS source compiled per-class at load time (GWT/TeaVM
  style, lazy). Registers → local vars; control flow via `for(;;)switch(pc)`;
  DEX tries → JS try/catch + handler dispatch. All compiled methods `async`
  (threads = cooperative on one JS thread; sleep/wait/IO suspend via await).
  Perf tier (sync compile of provably-non-suspending methods) deferred until measured.
- **Type mapping**: Java String = JS string primitive (String.prototype patched with
  mangled methods). int/float/double = number, long = BigInt, prim arrays = TypedArrays
  (byte=Int8, bool=Uint8, char=Uint16, long=BigInt64...), obj arrays = Array with $t tag.
  Java class → real JS class (framework native classes too — unified hierarchy under JObj).
  null = null. Mangling: methods `m$name$sigHash`, fields `f$name$declHash`, statics on ctor
  `s$name`, constructors `i$sig`. clinit lazy w/ `Cls.$c && await Cls.$c()` guard.
- **java.*** implemented as JS natives (collections over Map/Array etc). App's own dex
  (androidx, kotlin, okhttp...) runs on the VM as-is; we only supply java.*/android.*/JNI.
- **android.***: TS reimplementation. Views render to one <canvas> framebuffer
  (360x640dp @2x = 720x1280, `src/shell/config.ts`). Binary XML (AXML) + resources.arsc
  parsers feed LayoutInflater/Resources. Handler/Looper on JS event loop; Choreographer = rAF.
- **The android: resource package is real**: `vendor/framework-res.apk`, aapt2-linked at package
  id 0x01 from the SDK's own platform res tree (`bun run gen-framework-res`), fetched once per
  page beside the apk and read lazily -- only resources.arsc is inflated up front. A resource id
  picks its table by its package byte; nothing about the framework is synthesised, named or
  guessed. This is also the prerequisite for ever running real framework *bytecode*: View.java
  reads com.android.internal.R.styleable.View.
- **SQLite**: sql.js wasm, in-memory, persisted to localStorage per database (debounced,
  snapshotted without reopening — see "Persisting a database must not close it").
- **Server** (`server.ts`, `Bun.serve` routes): `/` the shell, `/vendor/:file` the framework
  package, `/proxy?url=` for CORS fetches,
  `/tcp?host=&port=&tls=` a WebSocket that relays one TCP connection (TLS terminated there),
  `/apks` + `/apks/:name` the launcher list, `/Roboto/:file`, `/sqljs/:file`.
- Missing-API telemetry: unresolved class/method throws + logs signature; dev loop =
  run → collect missing list → implement → reload.

## APK recon
- **FitNotes.apk**: pure Java/Kotlin, NO .so. androidx + Room-ish (androidx.sqlite),
  coroutines, WorkManager, threetenbp (assets/org/threeten/bp/TZDB.dat), google-api-client
  (Drive backup — stub ok). Single classes.dex 2.9MB, resources.arsc 810KB, 612 res files
  (obfuscated names res/-5.xml etc — arsc maps them).
- **flappybird.apk**: 2014, AndEngine (GLES2). lib/…/libandengine.so = 11KB (BufferUtils JNI
  → reimplement in JS). Needs android.opengl.GLES20→WebGL, GLSurfaceView. assets atlas.png+ogg sounds.
- **mihon-v0.20.4.apk**: 3 dex (21MB). Native: conscrypt (TLS — try UnsatisfiedLinkError fallback),
  libsqliteJni (bundled sqlite — implement its JNI over sql.js), libquickjs (impl over JS eval),
  libarchive-jni (impl over fflate), libimagedecoder (browser ImageDecoder), zstd-kmp.
  Compose UI. Network via OkHttp → real sockets through the /tcp relay.
- **Among Us.xapk**: base apk + config.arm64_v8a + 1GB UnityDataAssetPack. IL2CPP arm64
  → needs ARM64 usermode emu + Bionic + EGL/GLES3→WebGL2. Final boss, best-effort last.

## Status
Scores are `bun run e2e`'s content-diff means; the current ones live in
`tests/e2e/report/report.json` (last full run: fitnotes 43.1%, mihon-onboarding 17.6%,
mihon-app 76.9%, harmonic 46.7%, every step rendered, nothing wedged). A lower number is
better; a rising one is not automatically a regression (see "Harness notes"). The smoke flows
(no goldens) — flappybird, calculatorm, lichess, doodlejump — all render every step; only
flappybird's optional `DexClassLoader` stays missing. harmonic's one accepted miss is
`WindowExtensionsProvider`; fitnotes still wants `TranslateAnimation(FFFF)` through a subclass
and a `removeMessages` on something that is not our Handler.
- [x] recon, scaffolding; DEX parser + AXML + ARSC (+compact entries, signed values!);
      compiler + runtime core + java.* natives (all 3 APKs compile clean, `bun run smoke <apk>`).
- [x] FitNotes: boots and is interactive through its full core loop, matching real screenshots:
      main workout log → welcome dialogs (radio groups + OK) → Start New Workout → exercise
      categories from SQLite (ActionBar list-navigation + annotation ORM) → exercises → the
      TrainingLog TRACK/HISTORY/GRAPH tabs (SlidingTabLayout + ViewPager) render AND switch →
      enter weight/reps → SAVE → set row + PR trophy; data persists across boots; the create-
      exercise arc and the overflow menu (a ⋮ carrying a nested <menu>) work; `newMissing` is
      empty for every step.
- [ ] FitNotes remaining: EditText box styling.
- [x] Mihon: renders and responds, and onboarding COMPLETES — welcome/theme, then a real
      folder picked with the browser's File System Access API, then permissions, then the
      Library. The picked directory is a live SAF tree: Mihon creates local/, downloads/ and
      autobackup/ in it, the Local source lists a manga out of it, and it survives a reload.
      Browse (Sources/Extensions/Migrate) and More -> Data and storage work. `wd.rt.missing` is
      empty across both flows; boot ~3.0s; a tap settles in 130-580ms.
- [x] flappybird: plays. Splash → title (bobbing bird, scrolling ground) → PLAY → Get Ready →
      taps flap, pipes, score → Game Over panel with score/medal → PLAY again; SoundPool plays
      the five ogg effects; the high score round-trips through SharedPreferences; Back tears the
      engine down and reaches `System.exit(0)`. Headless smoke (`bun run e2e --test flappybird`,
      no goldens): 7/7 rendered, 60fps. The one entry left in `wd.rt.missing` is
      `dalvik/system/DexClassLoader` — the ad SDK's optional dynamic-code path, inside its own
      catch-all, deliberately not implemented yet. See "flappybird plays" below.
- [x] harmonic: the first-run welcome dialog, the front page, the overflow menu, Settings and a
      story's comments all render and respond; the Material search bar scrolls away under the
      list as on a device, and the app's own bundled fonts are the ones on screen. 89.9% -> 36.6%
      content diff over 14 steps. See "harmonic: five framework defects" below.
- [x] harmonic, the four interactions: a story's COMMENTS load and render (HTML bodies with
      their paragraphs, links and quotes); SEARCH opens, takes a query and lists Algolia hits;
      the story-type SPINNER opens and switching Top -> New Stories reloads the feed; and a
      story LINK opens the article in the WebView with the comment sheet's button strip under
      it. See "harmonic: the four dead interactions" below.
- [ ] harmonic remaining: the welcome dialog's preset buttons paint black, `@mipmap/ic_launcher`
      is an unhandled `<adaptive-icon>`, the settings row pitch is ~3% tall, and story rows have
      no preview thumbnails or favicons.
- [ ] Among Us (IL2CPP ARM64 — extremely hard, best effort)

## Infrastructure delivered
- DEX→JS AOT VM: compiles 4200+ classes/APK in ~400ms, 0 method failures; bodies generated lazily
- Android framework: View system, widgets, layouts, resources/themes/AXML/ARSC,
  measure/layout/draw, touch, dialogs, ListView/adapters, ActionBar (+list-nav), SearchView
- SQLite via sql.js (localStorage-persisted), seeded + queried correctly; the bundled
  androidx.sqlite driver is shimmed over it through the JNI registry
- DEX annotation parsing + reflection (Class.getMethods, Method.getAnnotation/invoke) →
  drives annotation-based ORMs (Otto EventBus, cursor→model mapping)
- java.nio buffers (ByteBuffer/FloatBuffer/... with byte order)
- GLES20→WebGL bridge + GLSurfaceView + android.opengl.Matrix + EGL
- Activity lifecycle: attach-before-onStart, resilient per-node dispatchAttached,
  ActivityLifecycleCallbacks (Pre/plain/Post) so androidx ReportFragment drives Lifecycle,
  recreate() as a real relaunch
- java.net.Socket over the /tcp relay; SSLSocketFactory re-dials with TLS at the relay
- Host input (`src/shell/input.ts`): a pointer drag and a trackpad two-finger swipe, both
  arriving as one ordinary MotionEvent stream
- ARM32 native tier (`src/native/`): memory, ELF loader, ARM+Thumb block compiler, libc/stdio/
  pthread/zlib, JNI, GLES1/EGL over WebGL, AudioTrack over Web Audio — doodlejump plays at
  ~690M emulated instr/s, and lichess/flappybird load their .so honestly

## VM and framework lessons (do not regress)
- **Main-looper serialization** (android/mainloop.ts onMain): ALL main-thread
  entries (Handler post/dispatch, tick frame, input, runOnUiThread) run through
  one promise queue. Async chains interleaving inside androidx internals caused
  the ViewPager fragment double-add. Background threads (executors) stay off it.
- **Async clinit**: initClass exposes in-flight promise; other chains WAIT (fixes
  half-initialized statics reads); same-class references skip the guard entirely
  (compiler knows the enclosing class — JVM same-thread reentrancy); <clinit>
  guards pass their class for cycle detection (waitingOn edges); a short timeout
  escape for cycles threading through non-clinit methods.
- **A missing native class mid-fragment-commit poisons androidx state**: the
  FragmentPagerAdapter caches its transaction (s.e); if commitNowAllowingStateLoss
  throws (e.g. TableLayout ctor missing), the poisoned transaction re-commits on
  every measure → endless 'Fragment already added'. Fix the missing API, not the
  symptom. Missing-API telemetry is the tool.
- **toJsArray(JSet) must include the slow bucket** (custom-equals elements) — the
  omission made Otto's EventHandler sets silently empty (addAll no-opped).
- **computeScroll() must be called before drawing each view** — it drives
  Scroller-based animation (ViewPager page snap).
- const/4 0 = null in ref contexts → 0→null normalization at ref use sites (invoke args,
  return-object, iput/sput/aput-object) + cc(0) passes + if-eq null/0 unification.
- const/high16 etc encode FLOAT BITS → the compiler types consts by their consumer (float ops,
  field types, param types, return type) with a reaching-definitions pass — see below.
- AXML/ARSC values must be read SIGNED (MATCH_PARENT=-1!).
- childMeasureSpec: MATCH_PARENT under AT_MOST parent stays AT_MOST (AOSP rule).
- LinearLayout weight leftover only grows children when the parent spec is EXACTLY; negative
  excess shrinks weighted children under any mode (AOSP `remainingExcess`).
- ems/minEms/minWidth on TextView (style-driven EditText widths).
- Native classes need rt.link() before direct TS instantiation (boot links all). If you
  mutate a native spec.methods AFTER the class was linked, also write the mangled keys onto
  ctor.prototype (see installClassReflection). Reflection Method instances need their native
  class rt.link()-ed so the prototype carries getAnnotation/invoke before `new JMethod()`.
- Annotation-based ORMs: getMethods → getAnnotation(@Column) → getColumnIndex → Method.invoke.
  DEX annotations live in annotations_directory_item (class_def+20). reflect Method.invoke
  must UNBOX boxed primitive args and BOX primitive returns.
- Interface method refs (SharedPreferences etc.) dispatch dynamically. That does NOT make them
  optional: an app class declaring `implements View$OnClickListener` cannot link until the
  interface is registered, and Runtime.link auto-stubs it and poisons everything downstream.
  `bun run audit` answers this properly now — rapid type analysis resolves an interface site
  against the types some reachable new-instance creates, so the work queue is computable
  before the apk runs and is not "whatever crashed today". `wd.rt.missing` and run.json's
  per-step `newMissing` remain the check that the queue was right.
- ViewPager caches child measure specs in fields → layout settle passes (uiState.settle).
- Duplicate registration bites: rt.register keeps the LAST spec for a name (the earlier one
  with more methods is silently gone), and nothing errors. The Verify grep is what catches it.
- JNI registry (rt.registerJni / R.jniFn): native methods of DEX classes (bundled sqlite,
  conscrypt) get implementations without shadowing the class (which would kill its compiled
  access$ bridges).
- App dex may contain THROWING desugar stubs for framework classes (WindowInsetsAnimation
  $Callback clinit throws NCDFE); register natives to shadow them.
- UUID/collections/boxed primitives must implement java/io/Serializable or Compose
  SaveableStateRegistry rejects voyager screen keys.
- **Covariant returns mangle to different names**: `ObjectAnimator.setDuration(long)` narrows
  `ValueAnimator`'s return type and javac/R8 emit the narrowed descriptor at the call site, so a
  subclass needs its own `setDuration(J)L…/ObjectAnimator;` key (animator.ts `setDur`). A missing
  one shows up as `NoSuchMethodError … m$setDuration$…` and blanks whatever was inflating.
- **`JObj` has no JS toString**, so `String(javaObject)` is always a bug — it printed
  `[object Object]` for every `Html.fromHtml` Spanned handed to a dialog or Toast. CharSequence
  parameters resolve through `csText` (Java `toString()`, so app classes work too); Spannables
  carry a JS `toString` for the sites that still coerce.
- **Text width goes through measureText, never ctx.measureText**: the memo is keyed on (font,
  string) and applies letterSpacing, and it is what counts the calls. JTextView walked past it
  for years -- harmonic makes 229,334 text measurements per run and 745 of them miss.
- **The framework's own layouts are inflatable**: SearchView reads ?attr/searchViewStyle and
  inflates the layout it names, icons and backgrounds included. `<view class="a.b.C"/>` is how
  AOSP writes a tag whose class is not a legal element name; the framework uses it. Prefer this
  to describing a widget's internals here -- the assets and the ids are all real now.
- **Two negative results, kept so they are not redone**: indexing a tag's attributes by id is a
  wash at 6 attributes per tag (0.40ms vs 0.39ms over every framework layout tag), and applying
  a background drawable's padding to its view -- which AOSP does -- moves no flow. Neither is in
  the tree. Do not re-add either without a measurement that asks for it.
- **A widget resolves its own default style**: initViewFromCtx takes the widget's style attribute
  (buttonStyle, editTextStyle, ...) and passes it to obtainStyled as defStyleAttr, for the base
  View attributes as well as the text ones. Without it tiers 3 and 4 of the cascade are dead for
  background/padding/minWidth/minHeight, which is why that chrome used to be hand-built. It runs
  with no AttributeSet too: `new Button(ctx)` gets its background from the style on a device.
- **android:theme on a tag wraps the subtree**: the inflater builds a ContextThemeWrapper and
  inflates the tag and its children against it, and the AttributeSet carries that theme, not the
  application's. 90 of mihon's layouts depend on it; so do the framework's own.
- **AbsListView selection and scroll callbacks are layout-time state**: apps call
  `setSelection`/`setSelectionFromTop` right after `setAdapter`/`notifyDataSetChanged`, before any
  row has a height, so the request lands in the next layout (`pendingSel`, AOSP's
  `mNextSelectedPosition`). `OnScrollListener.onScroll` fires from layout and every scroll delta,
  posted through the main looper, because its reply (prepend rows + re-anchor) rebuilds the rows
  the current pass is walking. An empty adapter swaps the list for its empty view
  (`updateEmptyStatus`) — never toggled before, so ListFragment screens rendered blank.
- **LinearLayout weights shrink too**: AOSP measures every sibling after the first weighted child
  against the whole extent and the weight pass distributes the (possibly negative) excess, so an
  overflowing weighted body yields to its button row. Our AlertDialog content mirrors
  abc_alert_dialog_material — message and custom panels carry weight 1 — which is what keeps OK on
  the card for FitNotes' full-height tips.
- **A return from a finished activity is a full resume**: AOSP runs onPause on the finishing
  activity, then onRestart → onStart → onResume → onPostResume on the one underneath (with the
  ActivityLifecycleCallbacks), and only then onStop/onDestroy on the finished one; a launch stops
  the covered activity once the new one is up. finishActivity used to call bare onStart/onResume,
  and androidx's FragmentActivity moves its fragments to RESUMED in onPostResume — so every
  ViewPager page instantiated after a calendar round-trip stayed STARTED, never started its
  loader, and FitNotes' day pages went blank (no "Start New Workout") for older days.
- **ListView dividers are the drawable, not the gap**: `setDivider(null)` zeroes the height and
  paints nothing even if the app then sets a positive `dividerHeight` (AOSP draws only when both
  hold); the default is the theme's `listDivider`, not a hard-coded fill, and an XML `@null` is
  "no divider" (obtainStyled reads it as absent, so check the raw attribute). The old fallback
  painted 40px grey bands between FitNotes' workout cards once the app re-applied its 20dp gaps.
- **Back goes to the topmost window first**: a dialog gets `onBackPressed` (cancel only when
  cancelable), a popup dismisses; only then does the Activity see the key. Delivering it to the
  Activity while a dialog was up finished the Activity and left the overlay orphaned over its
  successor.

## TrainingLog TRACK tab — the chain of root causes
The signature FitNotes logging screen (weight/reps/distance/time entry) went from a hard
crash to fully laid out. In order discovered:
1. Otto EventBus (@Subscribe) needed real reflection — DEX annotation parsing.
2. Compiler bug: const-defs in sibling branches weren't typed across the merge point, so a
   double const (weight-increment default) stayed BigInt → "Cannot mix BigInt" crash.
3. InputFilter$LengthFilter missing → EditText inflation threw → fragment onCreateView failed.
4. android.R.layout.* framework layouts (simple_spinner_item etc.) unimplemented → adapter
   inflate() returned null → findViewById NPE. Added programmatic synthesis of the simple_* set.
5. Activity Lifecycle never advanced past CREATED (ReportFragment.LifecycleCallbacks never
   fired) → FragmentManager stuck → ViewPager pages never instantiated. Fire
   ActivityLifecycleCallbacks (Pre/plain/Post) around each lifecycle step.
6. ViewPager.onLayout cast child LayoutParams to ViewPager.LayoutParams and crashed, because
   fragment page views kept FrameLayout.LayoutParams. addView/addViewInLayout/attachViewToParent
   now convert incompatible LPs via the ViewGroup's own checkLayoutParams/generateLayoutParams.
7. Plain android.view.View with wrap_content fills AT_MOST (Android getDefaultSize quirk),
   making divider/spacer Views eat all vertical space. Scoped fix: exact android.view.View
   collapses to content under wrap_content; custom View subclasses keep Android semantics.
8. The page then laid out but painted blank: every addView overload bypassed the overridable
   3-arg addView — see "Overload paths that skip the real entry".

## "Holds the main-looper queue" is not "is the main thread" (the double-composition bug)
device.ts's launchActivity decided whether to re-enter onMain by testing
`curThread === mainThread`. But curThread is pinned to the main thread by boot as well as by
every job, so the whole activity-start chain ran OUTSIDE the queue and interleaved with tick
jobs at every await. onMain counts job depth (mainDbg.depth) and exposes `inMainJob()`; ask that.

What it cost: ComposeView.ensureCompositionCreated is a check-then-act on a field our async
onMeasure has not stored yet when the chain yields. Tracing enter/exit shows it nesting inside
itself —

    0 ENTER ComposeView children=0
    1 ENTER ComposeView children=0      <- second chain, first has not returned
    1 EXIT  children=2
    0 EXIT  children=2

so Compose built its composition twice: two AndroidComposeViews under one ComposeView, every
`Dialog {}` composable shown twice, two stacked full-screen scrims (which read as "mihon
renders in dark theme" — it was the correct light UI under 2x 55% black), and Compose's own
"node attached multiple times" assertion escaping into the frame loop.

Generalise: any androidx check-then-act (`if (x == null) x = build()`) is atomic on a real JVM
and is NOT atomic here, because every compiled method is async. The only thing making it safe
is that all callers run as main-looper JOBS. Anything that bypasses the queue reintroduces it.

## Perf: what actually costs, measured
Frame loop and framework caching (all landed):
- JPaint.font() rebuilt its CSS font string per text op; measureText/fontAscent/fontDescent hit
  the browser every call. Both are pure functions — memoised (font string keyed on typeface
  identity/size/fakeBold; widths on (font,string); vertical metrics on font). Only assign
  ctx.font when it changes.
- JLayout line breaking stepped back one word, then one char, re-measuring each probe: O(n)
  measures per line, O(n^2) per paragraph. Widths are monotonic in prefix length → binary-search
  the character limit, then snap to the last space that fits. Same break points.
- mangleMethod recomputed a char-loop hash + regex on every vcall (per text line per frame, per
  view per draw). Two-level memo (name → desc → mangled), no allocation on hit.
- RenderNode's mirror OffscreenCanvas was allocated at full layer size and every recorded op was
  executed into it — but drawNodeInto replays the op list against the real target and NEVER
  reads that raster. It only has to answer reads during recording (measureText, getTransform,
  state), so it is now 1x1. Recording a layer no longer rasterises it twice.
- measureView wrote oldWSpec/oldHSpec and nothing read them, while every pass began by resetting
  layoutRequested + oldWSpec on the whole tree. requestLayout(view) now marks the path to the
  root as AOSP does; callers that cannot name a view set uiState.forceAll (and settleWatch does
  too, keeping the ViewPager escape hatch). FitNotes layout 450ms -> 188ms over the 39 steps.
- settleWatch ran on every drawn frame and built a string per mismatching view. Gated on a
  layout actually having happened, and hashed.
- ListView.allViews() spread three arrays per measure, layout, draw and fling tick; TextView
  re-measured "Ag" per draw for metrics graphics.ts already memoises; regexes were compiled per
  String.matches/replaceAll/Matcher call (javaRegex memo now). None of it was the mihon boot.

The negative result that matters: none of this moved mihon's ~1.4s boot layout. That cost is one
Compose composition inside the app's own bytecode, not repeated framework tree walks — so the
next real lever there is the compiler's sync tier (Architecture), not more framework caching.

Also: Paint.setBlendMode/setXfermode were no-ops. Compose's vector cache draws each ImageVector
into a layer and CLEARS it first with drawRect(black, BlendMode.CLEAR); with the mode ignored
that painted an opaque black square and Icon()'s tint flattened the whole layer. Every Material
icon and check mark rendered as a filled box. PorterDuff.Mode and BlendMode name the shared
modes identically, so one name-keyed table maps both to Canvas2D globalCompositeOperation.

## Dialog decor: resolve, don't invent
Dialog(Context, int) threw its theme id away and DialogRoot filled a hardcoded #ffffff card. It
now layers its own style over the host theme (explicit id, else the host theme's dialogTheme)
and paints the windowBackground that resolves from it, exactly as ensureDecor does for an
activity; the white fill survives only as the shape the drop shadow casts from.

Do NOT re-add the window title band without first bounding the card to the window. Rendering the
title above the content grew the card by its height, and FitNotes' first-run tips are already
nearly full-height: OK moved off the card, the flow could never dismiss them, and the content
diff went 42% -> 76%. (Also, the shared 2D context is left with textAlign="center" by the idle
screen — any direct fillText in the framework must set its own.)

## Debug tools
- `bun run <tool> <apk>` (package.json): `inspect` (manifest + dex stats), `smoke` (compile
  every class eagerly; the compile-failure check), `audit [--framework] [--all] [--json f]`
  (whole-program reachability: what this apk can actually reach and we do not answer for,
  ranked by call sites, methods AND fields; with --framework the real AOSP dex joins the
  program and the answer becomes the native methods it stands on), `opscan`, `dis <apk> <class> [method]` (disassemble one method — the
  fastest way to learn what an app actually calls), `jsrc` (dump generated JS), `layout <apk>
  <0xid|name>` (dump a binary layout XML), `findstr <apk> <needle>` (grep the dex string pools),
  `trace` (TRACE=<class-regex> METH=<regex>: log entry/exit of matching methods during boot),
  `natcheck [apk ...]` (boot each apk with every native wrapped and report the ones that
  return a promise without being declared async — see "The sync tier is worth 24x"),
  `bun scripts/perfsum.ts [dir] [baseline.json]` (roll the per-step perf counters up per flow,
  with deltas against a saved baseline: how two runs compare on cost, not just on pixels),
  `corpus [apk ...]` (boot every apk in apks/ headlessly and rank the gaps by how many apks
  reach them -- needs `bun run dev`, needs no goldens; see "The corpus, and what it is for"),
  `nrun <apk> <lib.so>` (load one ARM32 library headless and run its JNI_OnLoad — the fastest
  way to shake out the CPU/libc/JNI layers), `ndbg` (the same over a booted page),
  `dbg [flow] [stopAt] [outDir]` (walk an e2e flow until it wedges and dump the queue site,
  logs and missing list; frames land in webdroid-shots/dbg),
  `bun scripts/wheel.ts [flow] [stopAt] [px] [x|y]` (drive a screen with a REAL trackpad burst
  and compare where it lands against the same distance dragged with the mouse — the only thing
  that exercises the DOM listeners, since the e2e driver goes through page.evaluate into wd.*),
  `gen-framework-res` (rebuild the
  committed vendor/framework-res.apk with aapt2 from the SDK's own platform res tree; needs the
  Android SDK, but nothing else does -- the apk is committed),
  `gen-framework` (pull framework.jar + framework-res.apk off the booted reference AVD into
  vendor/aosp and verify the two halves name the same resources -- see "One build, or none"),
  `fwscan [jar] [prefix]` (what a dex would ask of us: classes, methods, natives).
- browser: `http://localhost:4080/?apk=<file>` boots that apk on load (reload = rebundle +
  reboot); `wd.{boot,app,tree,find,locateText,logs,rt,uiState,overlays,perf,perfReset,tap,
  tapText,swipe,type,back,alive,reset,rnodes,measure,querydb,mainDbg,native,web,ticks,setGL}`
  (src/main.ts) + the missing-API panel; `locateText` is what `tapText` and the e2e driver
  resolve a label to device coords with, and `ticks` is how you tell a live frame loop from a
  throttled one; the
  missing list is `wd.rt.missing` (a Set) — there is no `wd.missing`. loop-bomb guard names
  runaway methods; [junk measure] warns on 0x3fffffff dims.
- wd.perf (src/perf.ts): always-on counters — frames/frameMs, layoutPasses/layoutMs,
  draws/drawMs, measureText/measureTextMiss, rnRecord/rnReplay, invalidates,
  layoutErrors/drawErrors (must be 0 on a healthy app), inputMs, compileMs/classesCompiled,
  bootMs. The e2e driver snapshots them per step into tests/e2e/actual/<flow>/run.json
  alongside a wall-clock `ms`, which is how you tell "slow" from "frozen": mihon's freeze showed
  up as layoutPasses=0 and draws=0 for fourteen consecutive steps, not as a large layoutMs.
- Compose invisibility: wd.rnodes() lists all RenderNodes (w/h/ops/hasDL); replay one via
  Canvas.prototype.m$drawRenderNode.call({ctx}, node) onto an OffscreenCanvas and sample
  pixels; a Proxy spy over the ctx dumps the recorded command stream.
- Patching a compiled class's prototype method fires ONCE and is then overwritten when `R.lz`
  installs the real (lazily generated) function. To make a hook stick, wrap `rt.lz` too and
  re-apply after it returns. Native (TS) classes are not lazy.
- When a coroutine tree silently dies: wrap Recomposer's tryMakeCompleting and read the
  CompletedExceptionally cause — it surfaces the FIRST real exception that cancels a coroutine,
  which the ForgottenCoroutineScopeException spam otherwise buries. When a Compose screen is
  blank rather than crashing, wrap `rt.noteMissing` with a stack dump: a missing static on a
  hashCode path (`Boolean.hashCode(Z)`, `Double.hashCode(D)`) is enough to lose a whole screen.

## Overload paths that skip the real entry (a recurring bug class — check this first)
Three separate mysteries were all the same defect: a call arrived through an overload that
bypassed the method the real behaviour lives in.
- **addView**: every overload called attachView directly, so a ViewGroup subclass overriding
  addView(View,int,LayoutParams) never ran — ViewPager.addView never set lp.needsMeasure /
  lp.isDecor, the only path by which a page committed during the pager's own measure pass gets
  sized, and the TRACK tab painted blank. Funnelling through the 3-arg addView fixed it and
  deleted both `endsWith("/ViewPager")` name-matches AND the per-frame full-tree sweep.
- **HorizontalScrollView**: `horizontal` was set only in the 2-arg ctor; the app used the
  3-arg one, so it scrolled and measured VERTICALLY. Flags belong on the TS class, not in
  one constructor.
- **Class.newInstance**: constructors mangle to `i$hash(desc)` with no class component, so
  `vcall(o,"<init>","()V")` resolved UP THE PROTOTYPE CHAIN to a superclass constructor —
  building a half-initialised object with null fields and no error. Every androidx ViewModel
  with a non-default ctor hit this. getConstructors/getParameterTypes were also fabricated.

## No app/library class-name matching, and the other janitor invariants
`grep -rn 'endsWith("/' src` must stay empty of library names. The framework is free of
it; `view.ts`'s `=== "android/view/View"` is a genuine AOSP getDefaultSize distinction and
stays. Framework resources are read out of vendor/framework-res.apk, never synthesised or
matched by name. The launcher lists apks/ rather than naming the four apks; app names
appear in `src/` only inside comments that explain a real library quirk.
Also: no `rt.natives.get(...)` patching of a spec registered elsewhere (spread the methods into
the spec instead); one copy of each helper (`guardCall`, `newArrayList`, `defineException`,
`stringHash`, `charsToString`, `mkEnumSet`, `jarray`, `box`, `newObj`/`linkInit`,
`resString`/`Resources.ref`) — `mkEnumSet` and `resString` had each grown a second copy, one of
them a whole unreferenced file, before anyone checked.

## Harness notes
See tests/e2e/README.md for the commands and the metrics. What bites:
- Per-step missing-API capture: each step prints the APIs it was the first to ask for and
  not find. That list is the dev loop's work queue.
- **STRUCTURE** is the structural half of the diff: the two view hierarchies paired by resource
  id / text / content-description, reported as the share of nameable device views webdroid puts
  somewhere else. It names the view and prints both sets of bounds, which is what turns "the
  settings screen is off" into "the dialog button bar is not stretching". Whole-hierarchy
  goldens need a re-record (`e2e:record` writes NN-id.ui.json now); until then it falls back to
  the tap anchor the manifest already carries, read one step behind.
- `unreadAttrs` beside it (`wd.unreadAttrs()`, and per step in run.json) is the same queue for
  attributes: a framework attribute a layout carried that nothing asked `obtainStyled` for.
  Those render wrong in total silence -- no missing class, no missing method, no log line -- so
  a screen that is subtly off with a clean missing list is usually one of these.
- `settle()` accepts a steady two-frame oscillation, not just identical frames — the EditText
  caret blinks every 530ms, and 12 of 39 fitnotes steps used to burn the full 20s timeout.
- The harness writes to ONE shared output tree (tests/e2e/actual, report/report.json).
  Concurrent runs corrupt each other — never run two at once. The dev server rebundles on
  every page load, so do not edit src/ while a run is in flight either.
- **Check WHOSE dev server is on port 4080 before believing a number.** A server left running in
  another worktree (`.claude/worktrees/*`) answers on the same port and serves that worktree's
  bundle, so a run measures code you did not write and the score wanders by tens of percent
  between identical runs. `lsof -p $(lsof -ti:4080) | grep cwd` names it; the cheap defence is
  `PORT=4090 bun run server.ts` + `WEBDROID_URL=http://localhost:4090 bun run e2e`. A fix that
  does not appear in `curl -s localhost:PORT/chunk-*.js` is not being tested.
- A rising content-diff % is not automatically a regression: when the app starts doing work
  it previously skipped it can reach a *correct* state the goldens have already moved past.
  Look at the frames before believing the number.
- Screenshot coords ≠ CSS coords when the window is large (screenshots scale).
  Drive the app with wd.tapText/tap/type helpers in device coords instead.
- `Flow.liveClock` puts both drivers on the wall clock. PINNED_CLOCK_MS is in the past, so a
  device held there rejects every current TLS certificate and an app that fetches over HTTPS
  records a golden of its own error state — harmonic's first recording was a screen full of
  "Loading failed". Anything such a flow renders from the clock has to be masked.
- `maskRects` are scoring-time only, so masks can be tuned with `bun run e2e:diff` without
  re-recording. Mask enough of a frame and the mask colour becomes its modal background, which
  makes every remaining pixel "ink" — the number stays honest, but read it as "the unmasked
  strip differs by N%", not as an ink comparison.
- The emulator recorder never installs an apk; it only `pm clear`s, which throws if the package
  is absent. Install it yourself before `bun run e2e:record`.

## Measure in a page the browser is actually drawing
rAF doesn't fire in background tabs, and **the setInterval fallback does not save you** —
Chrome's intensive throttling takes a hidden tab to ~1 tick/s, and an MCP Chrome tab is
throttled that way while `document.hidden` stays false. Every animation/scroll measurement
taken there is garbage (a Scroller keeps ageing against performance.now() while no frame runs,
so on return it reports finished and ViewPager's computeScroll short-circuits, abandoning the
scroll instead of settling it); a whole first pass of "the frame loop is crawling" was an
artifact of it. ALWAYS check `document.visibilityState` and that `wd.ticks` advances before
believing an in-browser observation; prefer the headless Playwright driver, whose page is
genuinely visible. (An AudioContext keeps a hidden tab "audible" and restores ~15fps if you
must drive one interactively.) Also: a fixed `sleep` is not a settle measurement. "One tap
costs 8 seconds" was just an 8-second sleep; polling `perf.draws` until it stops changing gave
130-580ms.

## flappybird plays: the cascade was six APIs, not an SDK
The 2013 AdMob SDK never needed stubbing. `AdView` construction and `loadAd` are on the
critical path (the app's `onSetContentView` builds them BEFORE `setContentView`, with no
try/catch), but everything they touch is ordinary framework: what was missing was
`BigInteger(int, byte[])` + `%032X` (the SDK hashes device ids with MD5, and our `MessageDigest`
silently computed SHA-256 for "MD5"), `Vector.copyInto` (Play Games' `GameHelper.setup`),
callback interfaces the dex implements (`DownloadListener`, `SensorEventListener`,
`LocationListener`, `SoundPool$OnLoadCompleteListener`, `Handler$Callback` — an unregistered
interface auto-stubs and poisons the class that implements it), `TelephonyManager` ("phone"),
`AudioManager.getMode/isMusicActive/isSpeakerphoneOn`, and one fabricated answer:
`PackageManager.resolveActivity` returned null for the app's OWN manifest-declared `AdActivity`,
which the SDK reads as "misconfigured" (the NOTES "phantom dialog" lesson again — a PackageManager
answer is app state). With honest answers the SDK builds its ad URL inside a hidden `WebView`
via JavaScript we never run, times itself out after 60s ("AdLoader timed out"), and posts
NETWORK_ERROR to a null listener. Play Games: `getPackageInfo("com.android.vending")` throws
`NameNotFoundException` → SERVICE_INVALID → `GameHelper` logs "failing silently". No network
policy, no `HttpURLConnection`, no library-name matching — `grep -rn "com/google" src` is empty.

The GL blockers were all descriptor-level, and the audit found them before the browser did:
- `glGetActiveAttrib/glGetActiveUniform` were registered under a 10-arg descriptor; AOSP's has
  `bufsize` (11 args). AndEngine enumerates every uniform after linking and throws when a name's
  location comes back -1, so a no-op meant no shader ever linked.
- `EGL10.eglChooseConfig` took a scalar `EGLConfig` where the real parameter is `EGLConfig[]`,
  and our GLSurfaceView never called the app's `EGLConfigChooser` at all (AOSP's `EglHelper.start`
  does, and the engine's `GLState.reset` reads what the chooser recorded).
- Pre-API-24 dex calls `ByteBuffer.position(I)Ljava/nio/Buffer;` — the covariant-return trap from
  "VM and framework lessons", now answered for every buffer type from one body. AndEngine's
  `libandengine.so` JNI is gated on `SDK_INT <= 13` and never runs at our 33; the pure-Java
  fallback needed exactly those keys.
- **GL handles belong to the context, not the frame.** `setGL(ctx)` reset the int-handle tables
  every frame, so a VBO generated in one `onDrawFrame` bound nothing the next: `glBufferData`,
  `glVertexAttribPointer(offset>0)` and `glDrawArrays` all raised `GL_INVALID_OPERATION` (1282)
  while `perf.glFrames` ran at 60/s and the scene stayed black. A `getError()` probe after every
  GLES20 call named it in one pass (wrap the statics on `wd.rt.link("android/opengl/GLES20").ctor`).
  Tables now live in a `WeakMap` keyed by context; a recreated OffscreenCanvas is the "EGL context
  lost" case, which engines already handle from `onSurfaceCreated`.

Threading: AndEngine's `EngineLock` is a `ReentrantLock` + `Condition` + `AtomicBoolean` ping-pong
between its `for(;;)` update thread and the GL renderer. It works on our cooperative model with
the lock still a counter, because both sides re-test the flag in a `while` around `await()`. What
had to change: the GLSurfaceView hook started a new `onDrawFrame` every rAF tick even while the
previous one was parked in `waitUntilCanDraw` (now one frame in flight, `perf.glSkipped` counts the
ticks that had to wait; the hook also no longer deletes itself when the view is briefly unattached),
`Thread.join(long)` ignored its timeout, and `interrupt()` never reached `Object.wait`/
`Condition.await` (one shared `park` helper now; engines interrupt their update thread on destroy).

Lifecycle verbs that were stubs and mattered: `Activity.onWindowFocusChanged` was never dispatched
(AndEngine starts/resumes the engine from it), and `Window.FLAG_FULLSCREEN` was a constant — the
status bar is now hidden and the activity gets the whole 1280 when the flag is set, which is also
what makes an emulator golden of a fullscreen app geometrically comparable. The app's modified
`RatioResolutionPolicy` FILLS the screen and crops the overflow (720x1280 centred in 1232 before
fullscreen, exact after), so a surface larger than its parent is correct there, not a layout bug.

Audio: `SoundPool` is Web Audio now (`decodeAudioData` per load, real stream ids, per-stream
gain/loop/rate, priority eviction, `onLoadComplete` delivered through `onMain`). `AudioContext`
starts suspended; `play()` resumes it and the first call arrives inside the tap's main-looper job,
which is inside the browser's user-activation window. Bitmaps are uploaded premultiplied
(`UNPACK_PREMULTIPLY_ALPHA_WEBGL`), because AOSP bitmaps are and engines blend ONE/ONE_MINUS_SRC_ALPHA;
the GL canvas is opaque like a SurfaceView surface.

Harness: a game never settles, so a step can be `animated` (one capture after its dwell), `tapAt`
takes `repeat`/`everyMs` for a flap burst with no capture inside the perf window, and a flow with no
goldens runs in smoke mode (rendered/wedged/newMissing/newErrors/fps per step in run.json, nothing
scored). Playwright's `setFixedTime` freezes `Date` only — `performance.now`, timers and rAF keep
running, so `System.nanoTime`/`SystemClock` advance and the engine's frame timing is real.
`?apk=<file>` on the shell URL boots that apk on load, so a reload is rebundle + reboot.

Perf, measured headless (swiftshader): a CDP CPU profile over 3.6s of gameplay is 95% idle —
0.8ms of JavaScript per shell tick, ~7ms wall per GL frame during play and ~13ms on the busier
title screen (that is the software rasteriser, not our code; `perf.glSkipped` ≈ 3% of ticks in
play, 28% on the title). `inputMs` is ~40ms per tap and all of it is the engine's own
`Thread.sleep(20)` per DOWN/UP. The full suite after all of this: everything rendered,
the scored flows unchanged — see `## Status` for the current numbers rather than a second
copy of them here.

Seen, not fixed: `Thread.currentThread()` inside `onPause`/`onDestroy` reported the update thread
after Back — the "curThread is a global" hazard, cosmetic here. `MessageDigest` now throws
`NoSuchAlgorithmException` for SHA-384/512 (mihon's okio names them) instead of silently hashing
SHA-256; nothing on the mihon flows reached it, but a 64-bit SHA-2 core is the fix if one does.
The ad SDK's spam-signal jar wants `DexClassLoader` (unzip the jar from the vfs, `rt.loadDex`,
`loadClass` → `rt.classFor`) — generic and bounded, left for later.

## harmonic: five framework defects, none of them app-specific

Harmonic for Hacker News is appcompat + Material 3 *Expressive* + RecyclerView + androidx
preference, with 19 bundled TTFs and no native code. It booted and stayed alive but looked
nothing like the app. What was actually wrong, in the order it mattered:

- **A container drawable called its child's TS `paint()`, never the child's virtual
  `draw(Canvas)`.** An app-dex `Drawable` subclass has no `paint()`, so it inherited
  `JDrawable`'s empty one and drew *nothing*: `MaterialShapeDrawable` — every card, dialog
  frame, button and chip background in a Material app — was invisible. `drawChild()` now
  dispatches virtually from LayerDrawable/InsetDrawable/StateListDrawable/RippleDrawable/
  DrawableWrapper/ImageView/TextView, staying synchronous while every child is native.
- **`Inflater.getRemaining()` reported fflate's mid-stream parked tail.** okio computes
  "consumed = given - getRemaining()", so it handed the same bytes back on every refill: a
  gzipped HTTP response collapsed into a one-byte-per-refill loop that also fed the codec
  duplicate input. One tap cost 1688ms and one swipe 87 seconds, and the errors surfaced as
  `invalid distance` far from the cause. Mid-stream, everything handed in is consumed.
- **A view resolved against the application theme.** Material wraps every widget's context in a
  ThemeOverlay; `initViewFromCtx` threw it away. `themeOf()` is now the one answer to "which
  theme does this Context resolve against", walking the base chain as ContextWrapper does.
- **`android:fontFamily` could not name a `@font/` resource** — it went through `rvString` into
  `typefaceFor`, which knows three literal names — and **`applyTextAppearance` read styles raw**,
  so an app-side `TextAppearance.*` (whose `textSize` is always a `@dimen` reference) silently
  kept whatever size the view already had. Both now go through the resolution the attribute
  path already used.
- **Nested scrolling did not exist**, so a CoordinatorLayout Behavior never saw the scroll and
  the app bar sat still while the list moved under it.

The dev loop that found each one: `bun run e2e --test harmonic`, then the per-step `newMissing`
and `newErrors` in `tests/e2e/actual/harmonic/run.json`. Every remaining entry was a real
missing API, never a guess.

## harmonic: the four dead interactions, and the one gap under three of them
Comments never loaded, the search button did nothing, Top Stories -> New Stories did nothing,
and the link screen's bottom bar was empty. Four symptoms, one dominant cause.

**Window insets were never dispatched.** `requestApplyInsets()` was a no-op,
`getRootWindowInsets()` returned null on purpose, and nothing ever handed the decor a
`WindowInsets` — so an `OnApplyWindowInsetsListener` never fired. That is not a cosmetic gap:
harmonic's `CommentsFragment` sets its "the view is ready" flags *inside* one, and its
OnPreDrawListener will not build the request queue until both are set. The app logged
`Skipping comments load ... queuePresent=false` on every frame and never issued a request —
nothing was wrong with the transport, and no amount of looking at the network would have found
it. The same gap left the link screen's button strip empty (it is the comments adapter's header
item) and put the bottom sheet in the wrong place.

The values matter as much as the dispatch. The shell lays the decor out BELOW the status bar,
so `statusBars()` is genuinely zero, while the window's bottom edge is the physical bottom and
the gesture bar is the one inset an app must pad for. The mihon golden is the proof: its bottom
nav was 48px too low, and reporting `navigationBars()` = bottom 48 moved it onto the golden
(mihon-onboarding 48.7% -> 24.3%, mihon-app 90.6% -> 88.7%).

The rest, each a one-liner once found — the runtime missing-list named every one:
- **`View.getOverlay()`** — Material's SearchView expands through a ViewOverlay; without it the
  search button threw `NoSuchMethodError` and nothing opened.
- **`AbsListView.getChoiceMode()` / `AdapterView.getOnItemClickListener()`** — appcompat's
  Spinner dropdown is its own ListPopupWindow over our ListView and reads both back.
- **`requestFocus()` set a flag nobody read.** widget.ts alone decides which editable view the
  keyboard types into, so an app that opens its own search field got a caret and swallowed every
  key. Programmatic focus now reaches it through a hook.
- **`android:imeOptions` was never parsed** and the editor-action listener never fired, so the
  IME action key — the thing a search field is waiting for — did nothing. `wd.enter()` is the
  harness-side action key.
- **`Charset.newEncoder()`** threw on every layout pass of the front page (okio asks an encoder
  whether a character is representable). A throw per layout is also a perf bug.
- **`Spanned.subSequence()` returned a String** and **`getSpans()` tagged its array
  `Ljava/lang/Object;`** whatever class was asked for — both ClassCastExceptions in app code
  that trims a Spanned or assigns the result to a `T[]`. And `Html.fromHtml` stripped tags with
  a regex; the browser has a parser, so use it and emit the spans AOSP does.
- **A word wider than the line only hard-broke on one of the two paths through `TextView.wrap`**,
  so a URL in a comment ran off the right edge; and a wrap-content measure wrapped at the width
  it *wanted* while reporting the width it was *clamped to*, leaving both the lines and the line
  count (i.e. the height) belonging to a wider view.

Generalise: **an app's own control flow can hang off a framework callback that looks decorative.**
Insets look like padding; here they gate a network request. When a feature does nothing and the
logs are quiet, find the callback the app is waiting for rather than the API it never reached.

Also worth remembering: `rt.register` stamps the ClassInfo onto the ctor, so registering two
class names with one TS class silently swaps their identities.

### Measure in a page that is actually drawing — the MCP tab is not one
An in-browser probe reported `wd.ticks` unchanged over three seconds while
`document.visibilityState` stayed "hidden": zero frames. Everything frame-driven has to be
measured through the headless Playwright driver instead (a small script that drives a flow to
step N and then evaluates a probe in the page is the tool; `scripts/dbg.ts` is the committed
version of the same idea). The MCP browser is for *looking*, not for measuring.

## The dialog card that was a blob: Context.obtainStyledAttributes ignored the context
harmonic's welcome dialog painted a 264px-radius blob instead of a 28dp card. The chain, all
measured rather than guessed: the app itself called `drawRoundRect` with `rx = 264` on a
528-wide rect — exactly `RelativeCornerSize(0.5)`, and the 0.5 really was in the drawable's own
shape model. It was not a shared object; the dialog's model and the logo's were distinct
instances. Every theme lookup returning that fraction (21 of them, all of them) came from one
theme whose style stack was `[framework, AppThemeMaterialDayNight, 0x7f1401f3]`, and that id
resolves in the arsc to **`ShapeAppearanceHarmonicCircle`** — the 50% overlay the app puts on
its *logo*, applied as a whole theme by `new ContextThemeWrapper(context, shapeAppearanceResId)`
inside Material's `ShapeAppearanceModel.builder`.

Root cause: **all four `Context.obtainStyledAttributes` overloads read `$host.theme`** — the
application theme — instead of delegating to `getTheme()` as AOSP does. Material passes the
BASE shape appearance to that wrapper and reads the OVERLAY out of it; resolving against the
wrong theme swapped the two, so the circle became the base and every shape read through that
context inherited a 50% corner. The same defect in `initViewFromCtx` had already been fixed one
layer up; this was the Context-side twin, and it is why `themeOf()` exists in one place.

Second half of the same screen: a dialog whose window background the app sets is an
`InsetDrawable`, so the card it paints is inset from the window. The content has to sit inside
that inset or it spills outside the card — AOSP takes a decor's padding from its background for
exactly this reason. `LayerDrawable.getPadding` now sums insets and child padding, and
DialogRoot lays its content out inside it.

Generalise: **anything that resolves a resource against "the theme" has to ask the object it
was handed, not the application.** A ThemeOverlay is how Material tells a widget its shape,
colours and type; reading past it produces UI with no bug anywhere near it.

Still off on that dialog, if it comes up again: the preset buttons paint opaque black
(`0xFF000000`, our `rvColor` fallback, so a colour did not resolve — but `TypedArray.getColor`
and `getColorStateList` both honour the caller's default, so the miss is further in), and
`@mipmap/ic_launcher` is an `<adaptive-icon>`, which the drawable inflater does not handle.

## Conventions
- bun runtime. Minimal deps (fflate, sql.js; typescript/playwright/pngjs/pixelmatch for tooling).
  Terse TS, perf > purity in hot paths.
- Comments explain a non-obvious WHY, never what the code already says.
- Small focused commits, subject `<area>: <what>`.
- java.* lives in `src/jvm/natives/<pkg>.ts`, android.* in `src/android/<pkg>.ts`, the ARM32
  native tier in `src/native/`; one package family per file, module list = `src/natives.ts`.
- Test in Chrome via claude-in-chrome MCP (screenshot loop) as well as `bun run e2e`.

## Mihon renders
Mihon boots to its Compose onboarding screen (Welcome + theme picker) and responds to taps
with live recomposition. The load-bearing fixes, in order of pain:
- typeConsts register-reuse: a const-def set must be REPLACED once its register was read
  (hashCode-switch constants were getting float-typed by later unrelated float consts).
- RenderNode display lists must be DEFERRED command lists, not eagerly-baked pixels:
  Compose records parent layers before children; nested drawRenderNode is recorded as a
  closure that replays the child's CURRENT ops at draw time (real RenderNode semantics).
  Recording uses a Proxy that mirrors ops into a live octx so reads (measureText,
  getTransform) still work.
- isHardwareAccelerated must report true (Canvas + View) or Compose takes a software-layer
  path we don't implement; our RenderNode path IS the hw path.
- Dalvik registers are untyped: R8 passes float BITS as ints (alpha=1065353216). Defensive
  asF() reinterpretation on RenderNode float setters; clamp bogus font weights in font().
- android.text layout stack (BoringLayout/StaticLayout/Layout) implemented over measureText;
  Layout.draw must dispatch drawText VIRTUALLY (Compose wraps canvas in TextAndroidCanvas).
- Dialog windows need a real decor (lazily created FrameLayout) and Dialogs need
  getOnBackInvokedDispatcher; Compose Dialogs appear as overlays.

After the rendering milestone, a long tail of okhttp/datastore/coroutine deps had to be
satisfied so the app's startup coroutine tree stops cancelling: AccessController.doPrivileged
(protobuf UnsafeUtil) — was killing the whole datastore + recomposer coroutine subtree with an
uncaught NPE; Unsafe primitive get/put by offset; FileDescriptor.getFD; java.nio.file (Path/
Files/Paths/StandardCopyOption/BasicFileAttributes); java.net.URI; Proxy/Proxy$Type/
InetAddress/InetSocketAddress/SocketFactory.createSocket; BreakIterator; Normalizer; Character
code-point statics; Matcher region-aware matches/lookingAt/find (okhttp MediaType); the
blocking-queue family.

## Mihon recomposes: the logging path is load-bearing
The recomposer's effect job was completing at boot, but NOT because of structured concurrency,
coroutine scope lifetimes, or a Function2 cast in startUndispatched. Read the Recomposer's own
`closeCause` field (`wd.rt.classes.get("androidx/compose/runtime/Recomposer")` → wrap
`runRecomposeAndApplyChanges` on the prototype to grab `this`, then dump `f$closeCause$*` and
`f$effectJob$*.f$_state$volatile$*`) — it names the killer directly instead of guessing from a
symptom two layers downstream.

Root cause: **a missing API on the app's own error-logging path turned a HANDLED exception
into an unhandled one.** MainActivity's `CheckForUpdates` LaunchedEffect catches its network
failure and logs it with logcat's `Throwable.asLog()`, which does
`PrintWriter(StringWriter(), false)` + `printStackTrace(pw)`. We had `PrintWriter(Writer)` but
not `PrintWriter(Writer, boolean)`, and no `printStackTrace(PrintWriter/PrintStream)` at all.
The UnsupportedOperationException escaped the app's catch, and since a LaunchedEffect body is a
child of the Recomposer's effect job, it cancelled the whole recomposer → ShutDown → nothing
ever recomposed again.

Lesson (new instance of an old one): a gap in printStackTrace/PrintWriter/String.format
converts every exception an app deliberately handles into a fatal one, and the resulting damage
surfaces arbitrarily far from the real cause. Implement Throwable's whole print surface, not
just `printStackTrace()`.

## The phantom dialog: a fabricated PackageManager answer is app state
Every mihon frame was covered by a full-screen scrim from a Compose `Dialog` that showed once
at ~3s and was never dismissed, with its content measuring 0x0. Nothing was wrong with the
dialog machinery. `PackageInfo.firstInstallTime` was hardcoded to 0, i.e. "installed in 1970",
and mihon's `MainActivity.ShowDonationCampaign` is gated on
`Clock.System.now() >= firstInstallTime + 30.days && !donationCampaignShown` — so a fresh boot
always looked like a 55-year-old install and opened the campaign sheet (an `AdaptiveSheet`,
i.e. a `Dialog`, whose animated content had not become visible yet, hence 0x0). Install time is
now taken at the first boot that has no persisted state and kept with that state
(`wd:install:<pkg>`, wiped by `wd.reset`).

How it was found, since R8 leaves no useful stack: hook the NATIVE `android/app/Dialog`
prototype's `m$show$…` to capture `this` (a `DialogWrapper`), then read its fields — the
`onDismissRequest` lambda is named after the class that declared the composable
(`MainActivity$$ExternalSyntheticLambda2`), which points straight at the method to disassemble.
Field values identify a composable when class names cannot.

Generalise: every invented answer in PackageManager/Settings/Build is app state, and apps
branch on it. A wrong constant there produces UI that has no bug anywhere near it. Still
fabricated in `getPackageInfo`: `versionName`/`versionCode` (hardcoded 25.1/64 rather than read
from the manifest) — the next candidate if an app's upgrade path misbehaves.

## Reaching definitions, not pc order (the bug behind the blank Compose screen)
Dalvik registers are untyped, so `const/high16 v4, 0x4100` is the BITS of 8.0f and only its
consumer says which. `typeConsts()` decided that by walking instructions in raw pc order. That
is wrong on R8 output: R8 merges dozens of lambda bodies into one method behind a
packed-switch sharing a const preamble, so a write to v4 inside a *mutually exclusive* arm
looks like it kills a const that still reaches its use on every real path from the switch.

Effect in mihon: `Modifier.padding(8.dp)` got `Dp(1090519040)` — the float bits as an int.
Times density, rounded (and `Math.round(F)I` was `Math.round(v)|0`, which WRAPS instead of
saturating) that is -2113929216 per side; PaddingNode adds two of them and gets 2^26, so
Compose's own 24-bit IntSize check threw and took the frame with it. (The first suspect was
Constraints long-packing; it was fine. Instrument the actual numbers before naming a suspect.)

It is now a per-block reaching-definitions fixpoint over the CFG the compiler already builds
(leaders + branchTargets, plus edges from every block in a try range to its handlers). A const
kills the register's previous defs, a move copies them (branch arms `const-wide → move-wide →
merge → mul-double` need every reaching def typed), siblings union at the merge. Single-block
methods skip the fixpoint entirely. It also fixed a latent case the old pass had backwards: a
dead const on an unreachable path could be retyped by a later use, making `Density.roundToPx`
return NaN for Int.MAX_VALUE.

## A frame that throws must not end rendering
Three latches turned one exception inside `tick0` into a permanently blank screen, and all
three are the same mistake — state cleared before the work that consumes it, with no `finally`:
- `needsLayout`/`needsDraw` were cleared BEFORE the pass under one outer catch, so a throw lost
  both dirty flags for good. Each phase has its own catch now; a failed layout still falls
  through to the draw. Neither re-arms its flag on failure — that turns a deterministic throw
  into a 60fps exception storm; the next real requestLayout()/invalidate() recovers.
- `drawView` never balanced the `save()`s a view made before it threw, so a dead frame's clip
  survived into every later frame. It brackets with `restoreToCount` now, as AOSP's View.draw
  does — `JCanvas` already tracked saveCount and we simply were not using it.
- the `drawing` re-entrancy guard had no `finally`.
`perf.layoutErrors`/`drawErrors` count these. They must be 0 on fitnotes; non-zero names a gap.

## One build, or none (running AOSP's own framework bytecode)
`bun run gen-framework` pulls /system/framework/framework.jar and framework-res.apk off the
booted reference AVD — the same android-35 image tests/e2e/golden is recorded from — into
vendor/aosp (gitignored, 43MB + 35MB). The jar holds five plain classes*.dex: **32,713
classes, 245,617 methods, 4,408 of them native**. src/jvm/dex.ts opens it unmodified and
indexing all five costs 35ms.

The two halves are one artifact. `com.android.internal.R.styleable.*` are int[] built in
`<clinit>`, and the index constants beside them (`View_background = 13`) are already inlined
into the framework's own bytecode, so a table whose ids drifted does not fail loudly — it
answers with the wrong resource. Comparing the NAME at each of the 7,825 ids the framework's
R classes declare:

    vendor/aosp/framework-res.apk   7807 right (99.8%), 0 wrong
    vendor/framework-res.apk        4188 right (53.5%), 3582 wrong

The relinked table is not merely thinner, it is misaligned: 0x1070038 is
`config_defaultCloudSearchServices` there and `config_defaultAmbientContextServices` in the
bytecode, and every internal id past that point is shifted by one. public-final.xml pins the
public ids; nothing pins the internal ones, which is most of what framework code reads. So
gen-framework-res stays for the hand-written framework (which asks by name and does not care)
and the pair is the precondition for bytecode.

**Provenance is policy** (`src/jvm/provenance.ts`), not import order: a prefix in BYTECODE
withholds our native spec and lets AOSP's class answer. Two orderings had to be right, both
found by loading the real dex: natives must materialize AFTER every dex is indexed (a native
naming a withheld class as its super used to link it, find no dex, and auto-stub it for the
run), and the apk's dex goes in before the framework's. With view+widget withheld, View
compiles as bytecode with super java/lang/Object, ViewGroup's super is View, and nothing is
missing.

**What a cut actually costs** — `bun run audit <apk> --framework --cut <prefix>` answers both
halves, and the second one is the surprise:

    cut android/view/ android/widget/
      703 native methods on the reachable path, 76 classes to shim
      209 native specs to withhold, 1760 references from src/ to rehome

A cut is not bounded by super chains. It is bounded by what the hand-written framework ABOVE
it still names: 425 sites hold `JView`, 155 `JTextView`. Even the smallest leaf is not small —
`android/graphics/Rect` alone is 112. So a cut has to be downward-closed in the TS reference
graph, which means the view stack moves with everything above it or not at all. Do not start
from the leaves; the numbers say it moves the problem rather than shrinking it.

Of the 703, RenderNode (58), HardwareRenderer (20), SurfaceControl (15), Surface (10) and the
RenderNode animators (22) are behind `mAttachInfo.mHardwareAccelerated`, which RTA cannot see
is false. Forcing the software draw path — what layoutlib does — takes ~125 off the top.

## The corpus, and what it is for
`bun run corpus` boots every apk in apks/ headlessly and ranks each gap by how many apks
reach it, so the queue is ordered by expected value rather than by whichever app was opened
last. It needs `bun run dev` and no goldens, so it works on an apk nobody has written a flow
for — which is most of them.

It is breadth gated on depth: a gap here is a candidate, not a task. It earns work when it
also shows up in a scored flow. The first pass read 8/10, and four entries off the top of its
ranking (ScheduledThreadPoolExecutor's ThreadFactory constructor, AbstractExecutorService,
MessageQueue$IdleHandler, Process.getStartUptimeMillis, Context.getDataDir, java.util.Currency
over Intl) took **TikTok** from failing to rendering a frame with 1,365 classes compiled.
None of them came from staring at a stack trace.

Among Us is the remaining failure and it is structural: an .xapk is split apks, and bootApk
unzips the outer file expecting AndroidManifest.xml at the root.

## The sync tier is worth 24x, and we cannot have it yet
Every compiled method is `async` because any call might return a promise. In the shape the
compiler emits, an async caller of an async leaf runs at 20M calls/s where the same body
compiled sync runs at 490M: **24x**. That is the largest single performance number in the
tree, and it is why the sync tier keeps coming up.

Widening the syntactic rule buys nothing. It is sync today iff there is no invoke, sget,
sput, new-instance or filled-new-array — 12.4% of harmonic's bodies. Dropping the init
clause entirely (every method with no invoke at all) reaches 13.4%. The invokes are the
whole story, so the answer has to come from the call graph.

So it does: `src/jvm/suspend.ts` is a backward closure over the RTA graph (a method suspends
if it can reach one that does), `src/jvm/analyse.ts` runs it at boot in the one moment when
every dex is loaded and nothing is compiled yet, and the compiler consults `rt.syncMethods`.
It costs 81ms on harmonic and 483ms on mihon, and it says **40%** of reachable bodies cannot
suspend. A virtual site is one node, not one per receiver — fanning out per site made mihon
12.5M edges and 37 seconds instead of 0.7M and 0.5s.

It is off by default (`?sync=1`), because the 40% is not true.

The analysis takes `fn.constructor.name === "AsyncFunction"` as a native's whole statement
about itself, which is the only statement a function makes. **67 of ours return a promise
without being async** — `bun run natcheck` wraps every native, boots the apks and lists them.
They are not mistakes: `HashMap.get` runs a user `hashCode()`, `ViewGroup.measure` runs a
subclass `onMeasure()`, `TextView.setText` runs a CharSequence's `toString()`. They return
synchronously almost every time, so declaring them `async` would make the hottest paths in
the system always allocate a promise — more than the tier saves.

Three ways to tell the analysis anyway, all measured, none good enough:
- **A generated list of them.** Coverage-dependent. With harmonic's 57 recorded, three of its
  own methods still threw: `getPackageInfo(String,PackageInfoFlags)` returns `vcall(...)` and
  that overload had not run during the scan.
- **Scan each native's source for a re-entry helper.** Finds 10 of the 67. The rest re-enter
  through shared TS helpers (`measureView`, `drawView`, `inflate`) or are alias strings, and
  none of that is visible in the function's own text.
- **Assume every native suspends.** Sound, and yields **13.7%** — which is what the syntactic
  rule already gets. The whole value of the tier is in trusting the natives.

So the tier lands when the native layer can state re-entry, not before. `R.nosusp` is what
makes a wrong answer loud rather than silent: a frame compiled sync that receives a promise
throws and lands in `wd.rt.missing` as "… suspended in a sync frame". Do not re-derive any of
this; measure the native layer instead.

**One piece of it shipped on its own merits**: `initClass` was a single `(async () => …)()`,
so it returned a promise whatever the body did, and every FIRST touch of any class forced its
toucher to await. It now runs synchronously until a step actually yields. That is correct
regardless of the tier — and it is also the precondition for it, since otherwise no method
containing an sget or a new-instance could ever be sync.

## Generating JS source costs 4x what parsing it does
Loading a class generated source for every method it declares: 4397 classes / 24870 methods /
30MB on a mihon boot, of which only 7615 methods (31%) are ever called. Measured split for
4000 classes: 903ms generating, 224ms in `new Function`. So bodies are emitted as a thunk
holding a closure cell (`let $z7; C.prototype.m$x = function(p0){ return ($z7 ||= R.lz(C,7)).call(this,p0) }`)
and generated on first call. Fresh virtual dispatch then finds the real function on the
prototype; the cell keeps already-captured references (D.dp slots, interface defaults copied
down) one call away. Boot compile 1091ms -> 676ms. (Debugging consequence: see Debug tools.)

## The two layout gates AOSP has and we had lost
- `View.requestLayout()` called the TS helper with NO view, taking the "caller could not name
  a view" branch and forcing a full-tree re-measure — on every androidx/Compose relayout,
  which is the only path that reaches it. It must pass `this`, and must NOT pre-set its own
  layoutRequested flag: the helper's upward walk breaks at the first marked ancestor.
- `layout()` called `onLayout` unconditionally, so every pass laid out the whole tree even when
  the measure memo had just skipped it. AOSP gates on PFLAG_LAYOUT_REQUIRED, set when
  onMeasure actually runs. `forceLayoutFlags` sets it too, so settleWatch still forces all.
Neither moves mihon's ~1.4s boot layout: that is one Compose composition inside app bytecode,
not framework tree walks. They are correctness first, fitnotes layout 203ms -> 190ms second.

## One device profile
720/1280/48, density 2, 320dpi, 360dp, SDK 33 were bare literals in nine files, several of them
derived (1232 = 1280-48, 616 = (1280-48)/2). They all read `src/shell/config.ts` now — the
janitor pass caught the last `320` and `* 2` in drawable/graphics/widget. The profile imports
nothing, so anything may import it.

## curThread is a global, so "wake it sooner" is not a free change
LockSupport.unpark() is a no-op and parked threads only wake on their own deadline. Giving it
a real permit is correct Java and it did work — but it changes WHEN a parked chain resumes,
and `curThread` is one global restored only by `R.st($th)` after each await. Waking a worker
promptly enough to interleave with the activity launch made androidx's
enforceMainThreadIfNeeded see a worker inside handleLifecycleEvent, and mihon's Library came
up blank. Reverted. It also bought nothing: boot and tap latency were identical with the park
deadline at 50ms and at 1000ms, so nothing on the critical path was waiting on a permit.
Before trying again, a resumed continuation has to carry its own thread rather than rely on
the global being restored in the right order.

## Persisting a database must not close it (mihon's "no such table: room_table_modification_log")
Every mihon bottom-nav tap died in Room's `InvalidationTracker`: it creates its bookkeeping
table as a **TEMP** table plus TEMP triggers, and the very next write to it said the table did
not exist. The CREATE ran, on the right connection, and succeeded — instrumenting
`Database.prototype.exec/run/prepare/export` in the page gave the whole timeline:

```
0.45 run: CREATE TEMP TABLE IF NOT EXISTS room_table_modification_log (...)   ok
0.58 run: INSERT OR IGNORE INTO room_table_modification_log VALUES(1, 0)      ok
0.98 EXPORT (close+reopen)                                                    <-- scheduleSave
1.95 prepare: SELECT * FROM room_table_modification_log  -> no such table
```

`sql.js`'s `Database.export()` **closes and re-opens the connection** — its own doc comment
says so ("will cause any pragmas to be set back to their default values"). That throws away
everything that lives on a *connection* rather than in the file: the whole TEMP schema, the
PRAGMAs (Room sets `temp_store`/`recursive_triggers`), and every live prepared statement
(`stmt.step()` afterwards throws "Statement closed", which is a live hazard for the bundled
driver's cached statements). It also silently ROLLED BACK any transaction open at the time.
Our `scheduleSave()` called it 400ms after the first write of every session.

The fix is to snapshot the VFS file without touching the app's connection. `FS` is not exported
from the sql.js module, so the read goes through a throwaway `Database` whose `filename` is
pointed at ours for the duration of one `export()` (it closes only its own handle), then
restored so its `close()` unlinks its own file. Persistence also now waits for `txDepth` to
reach 0, since mid-transaction the file can hold spilled pages whose undo is in a journal we
do not copy.

Generalise: **an emulation primitive that "just reads the bytes" may be re-creating the world.**
Anything connection-scoped — TEMP objects, pragmas, prepared statements, open transactions —
is invisible in the exported file, so a save path that reopens looks correct in every test that
only checks rows.

Seen behind this at the time, and worth recognising if it returns: `CoroutineScheduler.tryUnpark`
spinning on its lock-free parked-worker stack (`loopbomb ... tryUnpark pc=59`, the
`if (updIndex < 0) continue` retry) because the stack head names a worker whose
`nextParkedWorker` is already `NOT_IN_STACK`. In a real JVM another thread repairs that; here
every other worker is parked. mihon-app's More/Settings steps render now, so it is not on the
critical path, but the loop-bomb guard is what would name it.

## A collection VIEW is not a copy (mihon's "Missed recording an endGroup")
Tapping mihon's More tab — and, on a fresh install, the second tap in the theme picker —
crashed into mihon's "Whoops!" screen with `androidx.compose.runtime.ComposeRuntimeError`
thrown from `GapComposer.end` → `endRoot` → `doCompose`. Compose's own message, recovered by
hooking `ComposerKt.composeImmediateRuntimeError`, is **"Missed recording an endGroup"**:
`changeListWriter.startedGroups.peek()` outlived `reader.parent`.

Neither of the two obvious suspects was it. Enter/exit tracing over `performRecompose` /
`CompositionImpl.recompose` / `doCompose` showed compositions perfectly nested and serialized
(`open=[]` before every one) — **no re-entrancy**. Hooking every `java/lang/Throwable`
constructor and printing the ones raised while a composition was open showed **no earlier
exception**; the ComposeRuntimeError was the first throwable of the frame.

What it was: the failing frame had four invalidations instead of the usual one, and the last
one's scope carried `anchor.location = 239` while group 239's key was a different composable's.
The composer therefore deleted group 239 and inserted a replacement — `recordSlotEditing()`
pushed 236 onto `startedGroups`, and the unwinding out of a *replaced* group never pops it.
Dumping `SlotTable.anchors` showed the list was wrecked: not sorted, the same `GapAnchor`
object present twice, six anchors still holding the `Int.MIN_VALUE` "removed" marker, and
anchors pointing past `groupsSize`.

Root cause: **`List.subList` returned a copy.** `SlotWriter.removeGroups` drops the anchors of
deleted groups with `anchors.subList(start, end).clear()` — in Java that is a live VIEW and the
clear writes through. Ours cleared a throwaway, so dead anchors accumulated, the binary search
`SlotTableKt.locationOf` runs over that sorted list started returning nonsense, and new anchors
were spliced in at wrong positions. It is `subList` now built on a Proxy over the parent array
(indices map into the window, a length change splices the parent), and `List.sort` writes back
in place instead of replacing `this.a`, which a view cannot survive.

Generalise (same shape as the sql.js `export()` lesson): **a Java collection accessor that
returns a view is load-bearing, and returning a copy fails silently** — every read is right and
only the writes vanish, arbitrarily far from the caller. `subList`, `Map.keySet/values/
entrySet`, `Arrays.asList`, `List.listIterator` are all views; ours are not all views yet.

## Real sockets, and why the certificate is honest about being fake
java.net.Socket carries bytes. server.ts has a /tcp WebSocket route that relays one TCP
connection per socket (Bun.connect), and jnet's Socket/InputStream/OutputStream sit on it. A
blocking read() suspends until the next frame — legal only because every compiled method can
suspend, which is the same property that makes OkHttp's blocking I/O work at all.

TLS is terminated at the relay (the page has no certificate store). OkHttp connects a plain
socket then hands it to SSLSocketFactory.createSocket(socket, host, port, autoClose) to wrap,
so the wrapper takes the target over and RE-DIALS with tls=1; nothing has been written yet, so
dropping the plain connection is invisible. Two details are load-bearing:
- getApplicationProtocol() must say "http/1.1". The relay opens TLS without ALPN, so the server
  answers as HTTP/1.1; a client told "h2" would send an HTTP/2 preface down that connection.
- The peer certificate is OURS. It asserts exactly one thing — the requested host as a dNSName
  SAN — because that is all a hostname verifier reads. Anything checking a signature or a pin
  gets nothing and fails, which is the honest outcome; do not "fix" that by fabricating a chain.

Proof it works, both ends: driving java.net.Socket from inside the VM against the dev server on
loopback returns a real "HTTP/1.1 200 OK"; and mihon's own OkHttp dials
`host=api.github.com&port=443` then `...&tls=1` at boot, which is the plain-then-TLS pair,
entirely from app bytecode. Known gaps in the relay: no backpressure (ws.send's -1 is ignored)
and text frames from the page are dropped.

## Dark mode: the app never asked us to repaint, it asked us to relaunch
Tapping Dark in mihon's Appearance screen changed nothing. Nothing was wrong with the
preference (it wrote and read back), with recomposition, or with the colour scheme.

`AppCompatDelegate.setDefaultNightMode(MODE_NIGHT_YES)` ends in
`AppCompatDelegateImpl.applyApplicationSpecificConfig`, which compares the night bits of
`Resources.getConfiguration()` against its own override config and then does exactly one of two
things: if the activity declared the change in its manifest (`ActivityInfo.configChanges &
CONFIG_UI_MODE`) it calls `Resources.updateConfiguration()` + `Activity.onConfigurationChanged()`;
otherwise it calls `ActivityCompat.recreate()`. mihon's MainActivity declares `configChanges=0`
(only its WebViewActivity declares anything), so it takes the second branch — and *nothing else*.
We had `updateConfiguration` as `() => {}`, `recreate()` as a `console.log`, and no
`Activity.isChild()` at all, so both branches were dead ends. Disassembling that one method
(`bun run dis <apk> androidx/appcompat/app/AppCompatDelegateImpl applyApplicationSpecificConfig`)
named all three in ten minutes; guessing at the Compose side would not have.

So dark mode needed the night bit to be real device state and *deliverable both ways*:
- `Resources.updateConfiguration()` now adopts the Configuration into the one device
  `Configuration`, and a changed night bit re-points `Arsc.device.night` (so `-night` qualifiers
  resolve) and invalidates every resource memo — `bagCache`, the colour-selector cache, and each
  `JTheme`'s attribute cache via a config generation counter.
- `Activity.recreate()` is a real relaunch: `onSaveInstanceState` → detach → `onStop` →
  `onRetainNonConfigurationInstance` → `onDestroy` (with `isChangingConfigurations()` true so
  androidx keeps the ViewModelStore), then a fresh instance started with that Bundle and that
  retained object. It is scheduled, not run inline, because AOSP's recreate() only *requests* a
  relaunch and the caller is mid-click-handler.
- `Activity.onConfigurationChanged` forwards into the decor via a new
  `View.dispatchConfigurationChanged`, which is the only signal an app that *did* declare
  `uiMode` would ever get (and what `AndroidComposeView` listens on to republish
  `LocalConfiguration`, hence `isSystemInDarkTheme()`).

The relaunch is what makes the golden reachable: mihon's Appearance screen survives it, because
voyager's screen stack round-trips through the SavedStateRegistry into our Bundle. Two gaps
surfaced only once something finally destroyed a view hierarchy and started a second one:
`View.clearViewTranslationCallback()` (Compose pairs it with the setter on detach) and
`Unsafe.putLongVolatile`.

Generalise: **a stubbed lifecycle verb is a silent behaviour hole.** `recreate()` looks
discardable in a one-activity emulator right up to the moment an app uses it as its only
mechanism for something visible.

And the other half of that switch, "System", was a lie for as long: the night bit was the
literal `0x11` in `Configuration` and a literal `0` in the resource table, so an app following
the system saw a device permanently in daylight. It comes off the one device profile now, and
the profile reads the browser's `prefers-color-scheme` — there is no device setting to read, but
there is a real answer and it is the user's own. A change under a running app goes through the
same two doors: the top activity is told if it declared `uiMode` in its manifest, and relaunched
if it did not. `UiModeManager.getNightMode()` reports it instead of claiming it is always off.

## The folder picker: a device's SAF, over the browser's own
Mihon's onboarding hard-gates on a folder, and every piece of the path between the tap and the
directory was missing. What it took, none of it app-specific:
- **`startActivityForResult` only launched.** The request code was dropped, an intent without a
  component was logged and ignored, and nothing ever called `onActivityResult` — so every
  androidx `ActivityResultRegistry` launcher was a dead end. An activity now remembers who asked
  for its result and `finish()` delivers it, and an implicit intent resolves against a registry
  of the activities the *system* provides, keyed by action (OPEN_DOCUMENT_TREE, OPEN_DOCUMENT,
  GET_CONTENT, CREATE_DOCUMENT), which is what DocumentsUI is on a device.
  **androidx launches through the three-arg options overload**, which was not registered — the
  two-arg one it funnels into had been there all along, doing nothing.
- The answer is **posted, never awaited**: the picker's UI is modal and the main-looper queue is
  serialized, so awaiting it inline freezes frames and reads as a wedge. AOSP's
  startActivityForResult only *starts* something anyway.
- **A SAF client does not trust `DocumentsContract`; it asks the package manager.** UniFile and
  DocumentFile call `queryIntentContentProviders`/`resolveContentProvider` to find out whether a
  provider owns the authority, and those only ever walked the app's own manifest — the storage
  provider is a *system* package no app can see in its own. There is a system-provider table now
  and one `isDocumentsProvider`.
- `src/android/documents.ts` is the provider itself, over the `FileSystemDirectoryHandle`s
  `src/shell/hostfs.ts` gets from the browser, with AOSP's own `<volume>:<path>` document ids so
  the URI algebra needs no special case. It is async, and that is faithful: on a device a
  `content://` tree is not reachable through `java.io.File` either, so nothing is mounted into
  the sync VFS.
- **A dialog that rejects before anyone could have seen it was never shown.** Chrome answers
  `AbortError` both for "the user cancelled" and for "this window may not open a chooser" — an
  unfocused window, an automated one, every headless one — and the only thing that separates them
  is the timing. Under 250ms is a refusal and falls through to OPFS, which serves the same
  interface; slower is a real cancellation and reports RESULT_CANCELED. A `SecurityError` instead
  means the gesture went stale on the way through the main-looper queue, so the request is parked
  and replayed on the next press rather than lost.
- **A restored handle has to be there before the app asks.** The IndexedDB restore was
  fire-and-forget and lost the race with app startup; an app reads its storage URI while it is
  starting and caches the answer, so a tree that does not resolve *yet* is one that does not
  exist for the rest of the session — the Local source listed nothing and made no query doing it.

## Four gaps that turned a handled failure into a fatal one
The same shape as the `printStackTrace` lesson above, four more times. Each was found by walking
a screen, not by reading a list:
- **`java.io.Closeable` did not extend `java.lang.AutoCloseable`.** R8 merges every
  close-this-thing call site into one helper that tests `instanceof AutoCloseable` first and
  throws off the end of the chain if nothing matched, so closing any cursor, stream, socket or
  database from a Kotlin `use {}` threw a bare `IllegalArgumentException` from a synthetic class
  with no bug in it.
- **`Throwable.getStackTrace()` returned an empty array**, which no JVM produces.
  kotlinx.coroutines' stack-trace recovery does `copyOfRange(trace, 1, trace.size)` on the way
  out of a *caught* exception; on an empty array that throws, and the failure surfaces as
  `IllegalArgumentException: 1 > 0` arbitrarily far from anything. Frames come off the JS stack
  the throw actually has.
- **The whole `java.security.cert` family was absent.** Its exceptions are catch types before
  they are anything else: `catch (CertificateException)` cannot match a class that does not
  exist. The factory answers the way a provider handed bytes it cannot parse does — a catchable
  `CertificateException` — rather than not existing.
- **`java/util/DataInput`/`DataOutput`** and the rest of that habit: an interface nothing
  implements in the framework is still one an app class declares, and an auto-stub poisons
  everything downstream.

## A static that names another class must resolve when it is read
`String.CASE_INSENSITIVE_ORDER` could not simply be added: `setupNativeMembers` resolved a
native class's statics at LINK time, link order is registration order, and a static whose value
is an instance of another class therefore linked that class before its own module had registered
it — and got a stub. A static written as a getter is resolved on first READ now and pinned, which
is the lazy-clinit semantics the JVM has anyway. `java/lang/String` needs it twice over: its
statics are copied from the holder onto the JS `String` constructor, and that copy has to move
the accessor, not read it.

## The gzip trailer starts one byte later than fflate says
Reading any gzipped stream ended in `CRC: actual 0x… != expected 0x…` where the two differ by
exactly an eight-bit shift — the signature of reading the trailer one byte early. fflate trims
its input buffer to the byte its bit cursor sits in and keeps the leftover bit offset in `s.p`,
so a deflate stream that ended mid-byte (most of them) left that partly-consumed byte in the
buffer and `getRemaining()` counted it as untouched; Java counts it as consumed.
`src/jvm/natives/jzip.test.ts` pins it, because the arithmetic is invisible until a CRC four
bytes later disagrees.

## lichess is an honest boot (native tier)
lichess (org.lichess.mobileV2) is Flutter: every pixel and every line of app logic is Dart AOT
in `lib/arm64-v8a/libapp.so`, run by `libflutter.so` (11.7MB of arm64 machine code with 480+
libc/EGL/GLES imports). It sits in the same bucket as Among Us (IL2CPP arm64): nothing short
of an ARM64 emulator runs it, so the target is a boot that is *honest*, not usable. What the
Java embedding does now, all of it the app's own code:
- `MainActivity.onCreate` → `SplashScreen.installSplashScreen` → `FlutterActivity.onCreate`
  → `FlutterLoader.startInitialization` (needs `DisplayManager.registerDisplayListener` for
  its `VsyncWaiter`) → the init `Callable` on an executor → `FlutterJNI.loadLibrary`:
  `System.loadLibrary("flutter")` throws ULE (`dlopen failed: library "libflutter.so" is
  arm64-v8a machine code`, `nativeRequired` + the `#native` line); the embedded ReLinker then
  re-extracts the real .so from `ZipFile(ApplicationInfo.sourceDir)` into
  `getDir("lib")` (`listFiles(FilenameFilter)`, `FileOutputStream`, `getFD().sync()`) and
  `System.load(path)` sniffs the ELF `e_machine` and throws the same ULE. Flutter's catch only
  recognises the two bionic "not found" messages, so it rethrows; `Future.get` wraps it in
  `ExecutionException`; `ensureInitializationComplete` logs `Flutter initialization failed.`
  and throws `RuntimeException` out of `onCreate` (`reportUncaught`, the one entry in
  `newErrors`). `onStart/onResume/onPostResume/onBackPressed` then take FlutterActivity's own
  "called after detach" early-outs — Back is a no-op, the activity stays.
- The frame is the launch theme's own window background. The planning note expected a
  `launch_background` layer-list; the real theme is androidx `Theme.SplashScreen` (v31
  variant on our SDK 33), whose `windowSplashScreenBackground`/`AnimatedIcon` describe the
  *system* starting window that webdroid does not model; what the app window paints is
  `Theme.DeviceDefault.DayNight`'s `windowBackground` = `#fafafa`, which is what the frame
  shows. `setTheme(NormalTheme)` in `onCreate` does not repaint an already-installed decor,
  same as AOSP.

Generic gaps this uncovered, none Flutter-specific:
- **`initClass` ran inherited `<clinit>`s.** JS constructors inherit statics through the
  prototype chain, so a subclass with no `<clinit>` resolved `ctor.$clinit` to its super's and
  re-ran it. R8 horizontally merges static facades into unrelated classes — here kotlinx's
  `ThreadContextKt` into `CoordinatorLayout.Behavior` — so initializing any `Behavior`
  subclass rebuilt `NO_THREAD_ELEMENTS`, and every coroutine that had captured the old
  sentinel died in `restoreThreadContext` with "Fatal exception in coroutines machinery".
  Found by a sticky method hook (wrap `rt.lz` too, per Debug tools) that showed `$clinit`
  running twice on two different `$i`s; fixed with an own-property check.
- `Inflater.finished()` was never true for a chunked feeder (fflate only flags `final` when
  told), so ProfileInstaller's `readCompressed` rejected every fully decoded baseline profile;
  once it decoded one it needed `DeflaterOutputStream` to write the transcoded profile.
- `DisplayManager` listeners/`getDisplays`/`$DisplayListener`, `File.listFiles(filter)`,
  `ApplicationInfo.split*`/`sharedLibraryFiles` (null, as for a plain base.apk), and the
  default uncaught handler now prints the `Caused by` chain (AOSP's does; it is what named the
  real fault above).

## Text metrics: ascent/descent are the font's, line boxes are includeFontPadding's
The device font's vertical metrics are now AOSP's Roboto hhea values (1900/-500 per em),
applied as `ascentOverride`/`descentOverride` on the loaded faces (`graphics.SYSTEM_FONT`), so
`Paint.ascent/descent` match a real device instead of reporting the OS/2 win metrics the
browser hands back. That alone made every text block one padding short, because AOSP's
TextView and Layout default to `includeFontPadding=true`: the FIRST line's box starts at the
font's `top` and the LAST one's ends at its `bottom`, while the space between lines stays
ascent..descent. `JTextView.topPad/bottomPad/textHeight` and `JLayout.padTop/padBottom` are
that rule; `setIncludeFontPadding` and the XML attr turn it off.

Compose asks for its typography line height with a **`LineHeightSpan` on the text**, which the
StaticLayout builder was throwing away when it flattened the CharSequence to a string. The
layout now keeps the source (`JLayout.src`) and hands each line's `FontMetricsInt` to the spans
covering it (`applyLineHeightSpans`), laying the line out with what they wrote back — AOSP's
own mechanism, so it serves any app that sets a line height, not just Compose. Mihon's body
text went from a 37px pitch to the 40px (20sp) its typography asks for.

## Native tier: a self-branching block runs its loop inside the block
A block whose branch targets its own start used to return itself to the run loop, which meant
spilling every live register to the register file and re-entering through a megamorphic call
per iteration. `flags.selfLoop` wraps such a block in `for(;;)` and turns the back edge into a
`continue`, so the registers stay in JS locals. An iteration cap returns to the run loop often
enough for the slice budget, and the loop drops out if its own code page was invalidated (a
store into it took mem's slow path). Byte-copy microbenchmark 2.3G → 5.1G instr/s;
doodlejump's 10.9B emulated instructions 626M → 694M instr/s.

`wd.native.profileReset(n)` also sets the slice budget, so the slice-boundary profiler samples
finely enough to name the hot pcs (`wd.native.profile()`, `wd.native.src(pc)` — set the low bit
for a Thumb block, or you disassemble Thumb code as ARM and see phantom faults).

## Generality: what a device without the thing reports
Fixes found by booting an app with no flow of its own (Resy: Facebook/Firebase/Koin/joda), all
of them things any APK can hit:
- **An Activity implements ComponentCallbacks2, KeyEvent.Callback and OnCreateContextMenuListener**
  in AOSP; a library casting an activity to one of them died on a ClassCastException.
- **An unmodelled system service is null**, not a stand-in Binder — a stand-in only moves the
  failure to the caller's cast, while null is what a device without that service returns.
- **`<meta-data android:value="@string/x">` is a string**, not the id: PackageParser resolves it
  through the app's resources, and SDKs that read an app id out of the manifest depend on it.
- PackageInfo carries the manifest's own version/activities, `getLaunchIntentForPackage` finds
  the LAUNCHER activity, `createPackageContext` answers for this package and for "android"
  (Material reads the platform palette through it) and throws NameNotFoundException otherwise,
  which is how callers discover an optional dependency is absent.
- `android.R.<type>` carries the framework's real ids, off the real table, with names spelled
  as java identifiers the way R.java writes them.
- A boxed Long put into a JSONObject was stored as a bigint, which `JSON.stringify` refuses.

## A trackpad swipe is a finger drag, and the inertia is the trackpad's
Nothing listened for a `wheel`, so on a laptop every scrollable surface — our ListView and
ScrollView, an androidx RecyclerView, a Compose LazyColumn, a ViewPager's tabs — was reachable
only by pressing the mouse button and dragging. `src/shell/input.ts` now moves a synthetic finger
with the wheel deltas and hands the framework the one-finger stream it already understands, so
nothing above the shell knows which device the gesture came from.

**Two roads not taken, both recorded so they are not retried:**
- **`ACTION_SCROLL` / `onGenericMotionEvent`** is what a real Android device does with a mouse
  wheel, and it is a dead end here: `View.dispatchGenericMotionEvent` returns 0 everywhere, and
  even with a dispatch path a ViewPager, a DrawerLayout or a swipe-to-dismiss would never see
  one — those are touch gestures. A synthetic drag is the only "swipe" every app understands.
  `ViewConfiguration.getScaledVerticalScrollFactor` exists for apps that ask; nothing feeds it.
- **Detecting the momentum phase.** macOS keeps sending wheel events after the fingers lift and
  Chrome exposes no phase, so ending the gesture at the lift means guessing from the shape of the
  deltas — a tuned threshold, which is the thing to avoid. Instead the momentum arrives as more
  MOVEs: the finger stays down through the coast and the UP lands when the stream goes quiet,
  with nothing left to fling. The trackpad's inertia is the only inertia, and the decision is
  structural rather than heuristic.

The three properties that make it feel like a finger rather than a scrollbar:
- **DOWN waits for the touch slop.** Below it nothing is dispatched at all, so a stray two-finger
  nudge cannot press, tap or long-press whatever the cursor is over; and because the first MOVE
  is already past slop, the scroll container intercepts and cancels the child it pressed within
  the same dispatch instead of leaving it lit for a frame.
- **One dispatch in flight, drained once per frame.** A trackpad fires up to 120 times a second
  while every input resolves through the one serialized main-looper queue: a MOVE per event
  builds a backlog the app can never catch up with and the gesture visibly lags the fingers.
  The drain sits at the top of `doTick`, *before* its re-entry guard — AOSP drains input in the
  Choreographer's input phase for the same reason, and the drain is the only thing that can emit
  the UP, so a slow frame must not starve it.
- **The finger is not clamped to the screen.** Pinning it at an edge would stop a long coast
  dead. Targets are latched on DOWN and every consumer works on deltas — ViewPager's
  `determineTargetPage` reads `x - initialMotionX` — so an out-of-bounds MOVE is correct, and a
  real finger sliding off the digitizer produces the same stream.

**Three framework defects fell out of it, none trackpad-specific.**
- **`MotionEvent.downTime`/`eventTime` were declared and never set** — every shell-dispatched
  event reported 0. `GestureDetectorCompat` (real app bytecode) then computes
  `thisUp.getEventTime() - lastUp.getEventTime() == 0 < DOUBLE_TAP_TIMEOUT` and calls every
  second tap a double tap; Compose builds its velocity tracker out of the same dt. They are
  stamped when the event *arrives*, not when the queue reaches it: a gap between two events has
  to mean the finger paused, never that the app was busy.
- **Velocity had no horizon.** The scrollers keep an EWMA fed one sample per MOVE and decayed by
  nothing else, so a gesture that stopped moving and stayed down carried the speed of its last
  move all the way to the UP — drag, hold still, lift, and the list flings anyway. VelocityTracker
  had the same shape, a secant over the last six samples whatever the gap between them, and that
  is what every androidx scroller actually reads. Both now say what AOSP says. The subtlety:
  one frame of silence is the normal interval between a move and the up that follows it, not a
  rest — measured, `wd.swipe` delivers an event every 20-23ms — so exempting the first frame is
  what keeps every existing fling intact while still zeroing the 120ms a wheel gesture ends with.
- **A press that dismissed an overlay left the rest of its gesture orphaned.** The DOWN returns
  after `dismissOverlay` with no latched target, and every later MOVE fell through to the decor
  as though a finger had been down on it, so a scroller jumped by the distance since its stale
  last position. Rare with a mouse (it needs a drag that starts by dismissing a popup), constant
  with a trackpad, where any scroll while a dropdown is open is exactly that gesture.

**Deliberately left faithful rather than convenient:** a two-finger swipe that ends over a large
clickable view with nothing scrollable under it still clicks it — `View.onTouchEvent` un-presses
only once the pointer leaves the bounds, which is what AOSP does and what a real finger does. Same
for a horizontal swipe over a list: `AbsListView`'s drag slop is y-only on AOSP too, so the row
takes the click. The gesture ends with UP rather than CANCEL for a concrete reason — CANCEL makes
a ViewPager snap back to the page it started on instead of turning it.

Measured with `bun scripts/wheel.ts`: on a Compose LazyColumn (mihon), on our own ListView
(fitnotes) and on a ViewPager page turn (fitnotes TRACK -> HISTORY) the trackpad lands on the same
pixels as the mouse; on harmonic's RecyclerView it lands short of the drag by exactly the drag's
fling. Scores across the change: fitnotes 43.07 -> 43.07, mihon-onboarding 17.56 -> 17.56,
mihon-app 88.75 -> 88.83 (two identical runs differ by 0.5), harmonic 46.51 -> 46.37.
