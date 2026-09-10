# Emulator implementation history

Historical investigations and measurements retained from the project notes through
2026-09-07. Statements such as “now”, “unimplemented”, and “remaining” describe the stage
of the investigation, not current coverage. Current instructions are in [AGENTS.md](../AGENTS.md),
and current work is tracked in [PLAN.md](../PLAN.md). File references below name the code
at the time of each investigation; modules have since been decomposed.

The ARM64 SIMD and host-library bring-up described below is complete enough to reach
Among Us Practice. The later “Practice and code-cache pressure” section supersedes the
earlier native-tier blockers. Preserve the reasoning and negative results when changing
those implementations.

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

## Harness notes

Historical captures on identical code put Harmonic at 31.80%, 35.87%, and 37.84% content
error. Live Hacker News content moved even the unmasked strip, and scroll steps changed the
amount of drawing. Mihon-app ranged from 76.96% to 78.37% across seven runs, including runs
with identical behavior. FitNotes and Mihon onboarding were repeatable to the digit. These
measurements explain why an ambiguous score needs a comparison against the starting commit;
they are not current scores or permanent noise thresholds.

A rising score can also mean an app started doing work that it previously skipped and reached
a state the golden had already passed. Inspect frames and render completion alongside scores.
The harness learned to accept a steady two-frame oscillation because EditText's blinking caret
otherwise exhausted the settle timeout. Missing APIs, unread attributes, and structural bounds
identify different kinds of failure; empty missing-API telemetry alone cannot establish fidelity.

Framebuffer screenshot coordinates differ from CSS coordinates when the displayed canvas is
scaled. Use the device-coordinate input helpers. Live-network flows need a live clock: pinning
the reference device in the past made it reject current TLS certificates and record a network
error as the golden. Scoring masks can change the modal background, so heavily masked content
scores describe the remaining strip rather than the whole screen.

Current capture commands, private-port rules, and scoring details live in
[the harness guide](../tests/e2e/README.md).

## Measure in a page the browser is actually drawing
rAF doesn't fire in background tabs, and **the setInterval fallback does not save you** —
Chrome's intensive throttling takes a hidden tab to ~1 tick/s, and an MCP Chrome tab is
throttled that way while `document.hidden` stays false. Every animation/scroll measurement
taken there is garbage (a Scroller keeps ageing against performance.now() while no frame runs,
so on return it reports finished and ViewPager's computeScroll short-circuits, abandoning the
scroll instead of settling it); a whole first pass of "the frame loop is crawling" was an
artifact of it. ALWAYS check `document.visibilityState` and that `wd.ticks` advances before
believing an in-browser observation; prefer the headless Playwright driver, whose page is
genuinely visible — a small script that drives a flow to step N and then evaluates a probe in
the page is the tool, and `scripts/dbg.ts` is the committed version of that idea. The MCP
browser is for *looking*, not for measuring. (An AudioContext keeps a hidden tab "audible" and restores ~15fps if you
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
which the SDK reads as "misconfigured" (the "phantom dialog" lesson again — a PackageManager
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

## The delegates: AOSP's native halves (B1 and B3)
A class served by AOSP bytecode (see provenance above) keeps its Java half and loses its
native half. `src/android/delegates.ts` is the native half: `Paint.nInit()J`,
`Matrix.nPreScale(JFF)V`, `AssetManager.nativeApplyStyle(JJIIJ[IJJ)V` — the exact descriptors
the framework's own bytecode calls, registered through `rt.registerJni`. The `long` a
framework class holds in `mNativePtr` is an index into a table there, which is layoutlib's
DelegateManager: framework Java owns a handle, we own the object.

**Nothing in it is written from a list.** `bun run fwtest [prefix ...]` withholds our native
specs for the named prefixes, loads the real classes out of vendor/aosp/framework.jar and
reports two numbers: how many of the natives the dex declares we implement (coverage), and
what the bytecode actually reached and could not find (evidence). Every delegate is there
because that said so.

    Paint 86/86   Canvas 33/33   BaseCanvas 32/32   Matrix 40/40   Path 43/43
    Typeface 17/17   AssetManager 55/55   XmlBlock 22/22   StringBlock 5/5
    ok  new Paint()  new Matrix()  new Path()  — real bytecode, headless
    ok  nativeGetResourceIdentifier / nativeGetResourceValue / nativeApplyStyle
    ok  android:layout/alert_dialog opened and walked to END_DOCUMENT

Things worth keeping:
- **The draw bodies are not duplicated.** Every `nDraw*` routes into `canvasMethods`, the
  table our own Canvas native already uses; it is exported for that and nothing else. Same
  for Path's three coordinate walks, which moved out of the method table into `pathBounds`/
  `pathOffset`/`pathTransform`.
- **Matrix is NOT JMatrix.** AOSP's is a full 3x3 and a 6-element affine cannot hold a
  perspective, so setPolyToPoly and every perspective map would quietly flatten.
- **AOSP's TypedArray is a flat int[]** with STYLE_NUM_ENTRIES=7 ints per attribute in the
  order (type, data, assetCookie, resourceId, changingConfigurations, density,
  sourceResourceId). Getting the stride or the order wrong is not a visible error — it is
  silently the wrong attribute.
- **Where Canvas2D has no form for something, do nothing rather than something wrong.**
  getTextPath leaves the path empty rather than filling it with wrong geometry; setPolyToPoly
  reports failure for the 4-point perspective solve; positioned glyph ids need a shaping
  engine there is none of.
- **BaseRecordingCanvas stays unimplemented on purpose.** It is the display-list path, and
  forcing the software draw path is the whole reason RenderNode (58), HardwareRenderer (20)
  and SurfaceControl (15) are off the boundary. Registering its draw ops re-opens it.

Two absent classes had to come first, and only real bytecode finds them: every framework
graphics class hands its finalizer to `libcore/util/NativeAllocationRegistry` from a
`<clinit>`, and `android/compat/Compatibility` gates behaviour on targetSdk. Without them the
class fails to initialize before any of the work is reached. `android/graphics/Color` also had
no colour-long API at all, which killed every `Paint.setColor` — it caches `Color.pack(int)`.

- **An index is not a string, and a file resource is not a reference.** XmlBlock's natives hand
  out string-pool INDICES; the block keeps the real pool out of its own bytes, so nothing is
  interned and an index means what the caller resolves it to. And `resolveRefs` deliberately
  keeps a file-typed reference AS a reference, because our own stack loads it by id — a device
  resolves it to the archive path, since that is literally what aapt wrote into the entry.
  `Resources.getLayout` takes the TYPE_STRING branch or throws NotFoundException, so the
  translation belongs in `fillTypedValue`, at the boundary. The `fwtest` walk found that on its
  first run; nothing else would have, because our own inflater never asks.
- **The XmlBlock parse state IS a `JAttrSet`.** AOSP passes `XmlBlock.Parser.mParseState`
  straight to `applyStyle`/`retrieveAttributes`, and `res.ts`'s `obtainStyled` reads the element
  off `node` — so the whole existing attribute cascade serves bytecode with no new code.
- **ApkAssets (12) is deliberately unwritten.** `nativeCreate` hands back a `Resources` and
  `nativeSetApkAssets` is a no-op, so no bytecode reaches it. Asset cookies are still real:
  1 is the framework package and 2 the app, because a path alone cannot say which apk it came
  from — `res/layout/alert_dialog.xml` exists in both.

- **A bitmap does not need a raster to be a bitmap.** `JBitmap`'s OffscreenCanvas is made on
  demand now: until something draws, the RGBA bytes ARE the bitmap, and after that they are a
  memo of it that handing out the context drops (whoever took it may draw). That is what makes
  a run of `getPixel` one readback instead of one per pixel — and it is the only reason AOSP's
  own `Bitmap.createBitmap` can be exercised headless at all, since bun has no `OffscreenCanvas`,
  no `ImageData` and no `createImageBitmap`.
- **Several Bitmap natives return the Java object, not a handle**, so they build AOSP's own
  `Bitmap` through its `(nativePtr, w, h, density, mutable, chunk, insets)` constructor with
  `newObj` — which makes them async. That is safe on a cut class *because* it is cut: the
  suspension analysis finds no spec for the name, and unknown means assumed-suspending. A class
  that is both registered and served by bytecode gets the opposite answer and the caller
  compiles sync; `fwtest` avoids it by pushing the cut into `BYTECODE` before importing
  `src/natives`, and anything else that runs delegates must do the same.

Left: the decoders. `BitmapFactory` (5), `BitmapRegionDecoder` (8) and `BitmapShader` (1) are
NOT written, because nothing reaches them yet and `createImageBitmap` cannot be exercised
outside a browser — a delegate exists because `fwtest` said so.

## AOSP's StaticLayout breaks where ours does, and the comparison found our bug
`bun run textcmp` loads the same bundle twice — once with `android/text/{Layout,StaticLayout}`
and `android/graphics/text/` on AOSP bytecode — and breaks six paragraphs through the same
`StaticLayout.Builder` call on both. It went 0/6 to 6/6 while naming, one at a time, every gap
between here and there. Text measurement needs a Canvas2D context, so this cannot be `fwtest`;
it has to be a real page, and the MCP tab is not one.

The delegates it stands on are `MeasuredText` + `LineBreaker` (20 natives), and the breaking
routes into `text.ts`'s `greedyBreaks` — the body `JLayout` already used — so the two agree by
construction rather than by two implementations happening to match. What the comparison is
actually testing is everything AOSP does *around* the break: paragraph splitting, bidi,
per-character advances, span handling. Layout and StaticLayout declare **zero** natives.

Two of the gaps were ours, not the framework's:
- **A line that ends a paragraph owns its newline.** AOSP's invariant is
  `getLineEnd(i) == getLineStart(i + 1)`; ours ended the line at the `\n` and started the next
  after it, so an app slicing text by line lost every separator. `getLineVisibleEnd` is the one
  that excludes it. mihon-app 77.65% -> 76.96% on that alone.
- **`nComputeLineBreaks` must not split paragraphs again.** AOSP has already split them and
  hands the delegate ONE, with its trailing newline included — so `greedyBreaks`, which splits
  on `\n` itself, was adding an empty line after every paragraph. The last break offset still
  has to cover the newline, because that is where the next paragraph starts.

And one that is worth knowing before writing any text delegate: **per-character advances are
prefix differences, not characters measured alone.** Their sum then equals `measureText` of the
whole run, which is what actually gets drawn; Canvas2D kerns, so context-free single-character
widths do not add up to it. That costs one measure per character, which is why
`getRunCharacterAdvance` only does it when the caller passed an array.

## What a cut costs, measured: fitnotes on AOSP's own graphics bytecode
`?bytecode=<prefix,...>` on the shell URL (and `WEBDROID_BYTECODE=` for the e2e driver) serves
those prefixes from vendor/aosp/framework.jar for one page load, so a cut is a measurement
against the same bundle instead of an edit and a rebuild. B2 stops being a plan at that point.

With `android/graphics/{Paint,Canvas,BaseCanvas,Matrix,Path,Typeface,Bitmap}` on AOSP bytecode,
fitnotes runs its whole 39-step flow: **43.33% content diff against 43.07% without the cut**,
39/39 rendered, and fitnotes is repeatable to the digit. 36,926 classes are indexed (4,213 the
app's, 32,713 the framework's) and boot goes 165ms -> 221ms.

**Exactly three things break, and the shape of them is the whole lesson:**
- **`Canvas.drawRect(FFFF Paint)` and `drawLine` are "not a function" — on views the APP draws.**
  Our framework draws in TS, calling `canvasMethods` bodies directly, so it never notices; app
  bytecode calls the *mangled Java* method on the `JCanvas` it was handed, and a cut withholds
  the spec that put those methods on the prototype. So the 129 `JCanvas` references PLAN.md
  counts are not evenly costly: the ones that matter are wherever the framework hands a canvas
  (or a paint) to app code. Two of fitnotes' own custom views hit it and the rest of the app
  does not, which is why the score barely moved.
- **`SystemProperties.native_get`** — reached from a `<clinit>` the moment any framework class
  runs. It is a delegate now, and every property is absent, so every read gets the caller's
  own default.
- **`android/icu/util/ULocale` is not in framework.jar.** It lives in the i18n apex
  (`core-icu4j.jar`), which `gen-framework` does not pull. Anything on AOSP's locale path needs
  that second jar.

Two things this run settles that reading could not:
- **A failed draw does not cost the frame.** Both draw errors landed in `perf.drawErrors`, every
  step still rendered, and the score moved 0.26 points — the "a frame that throws must not end
  rendering" work is what makes a cut survivable enough to be measured at all.
- **The framework jar is a safety net for everything else.** Once it is loaded, a class we have
  no spec for resolves out of AOSP's dex rather than going missing, which is why a partial cut
  boots at all.

## A layer-list item carries its own size, and a gravity to place it by
`JLayerDrawable.layout()` has implemented AOSP's `updateLayerBounds` — insets, then an
explicit layer size placed by its gravity — the whole time. The inflater never filled `w`,
`h` or `gravity` in, so every `<item>` was stretched to the drawable's full bounds.

What that looks like: harmonic's "Top Stories" spinner background is a layer-list whose
second layer is the dropdown arrow. Stretched from 24dp to the spinner's 404x105, the
arrow's triangle became a tapered wedge drawn straight through the title text, and the caret
itself was nowhere to be seen. Reading android:width/height/gravity puts it back where it
belongs — and mihon-app moved 79.7% -> 77.4% off the same change, because it is not one
drawable, it is every layer-list in every app.

## A ripple's mask is not one of its layers
`selectableItemBackground` is `<ripple><item android:id="@android:id/mask"
android:drawable="@android:color/white"/></ripple>`. AOSP's RippleDrawable treats the layer
identified as `@android:id/mask` as the shape the ripple is clipped to and **never draws it**.
We pushed it into `layers` like any other item, so every view with a selectable background
painted an opaque white rectangle over itself.

On a light theme that is invisible — the surface underneath is nearly white already. On a
dark one it is the entire surface: harmonic's story cards came out white with the theme's
near-white `colorOnSurface` text on top, i.e. unreadable, while the app bar and window
background were correctly dark. The card's own MaterialShapeDrawable held the right colour
(#2e3038) the whole time; it was being covered.

harmonic 46.3% -> 36.6% on the scored flow, which is exactly the number this file already
recorded before it broke. The mask id is read off the framework table, not written down.

Two things this cost, both worth remembering:
- **The e2e run could not see it.** Playwright defaults to a light colour scheme and
  `src/shell/config.ts` takes night from `prefers-color-scheme`, so every scored run was in
  light mode where the white rectangle is invisible. A dark-only defect is invisible to the
  harness as it stands.
- **The MCP Chrome tab could not see it either**, for the opposite reason: it is throttled, so
  `wd.ticks` stops advancing and the canvas holds a stale half-drawn frame. Sampling pixels
  there produced a white content area that no view in the tree accounted for, and turning the
  decor's background red changed nothing. Check `wd.perf.draws` is still incrementing before
  believing anything read out of that tab; the finding only became reproducible in headless
  Playwright with `colorScheme: "dark"`.

## The dex front-end: three ways a file was unreadable before it was wrong
None of these was found by an app failing. Each was a shape the reader did not have, and each
fails silently or unhelpfully rather than loudly:
- **A quickened opcode has to be walkable even though it cannot be compiled.** `0xe3-0xf2` were
  null in `OPS`, so `insnLen` threw on the first one and took the whole file — any de-odexed or
  `dexlayout`-quickened dex failed before compilation started. The trap in fixing it is that the
  compiler's `default` branch matches on the *name prefix*, so calling one `iget-quick` would
  have emitted `A = B.<field>` with a resolved vtable offset in place of a field index: silently
  wrong code. The `-quick` suffix is checked first.
- **A v41 container is several logical dex, and their offsets are the FILE's.** Android 15 packs
  them into one physical file; a reader that assumes one header at 0 sees only the first
  classes' worth, with no error. Each `DexFile` keeps the whole buffer and only its header moves,
  so container-relative is what every existing offset read already computes.
- **`annotated_parameters_size` was read past.** Retrofit, Dagger and Jackson read nothing but
  parameter annotations, so a library shaped like that saw a method the app had annotated as
  bare. R8 strips them, which is why the corpus mostly cannot see the gap: harmonic and mihon
  carry none, FitNotes 22.

And the header itself was never checked at all, so a truncated or byte-swapped file surfaced as
a RangeError from a DataView inside a string lookup. Version, endian tag, header size and every
section's bounds are checked now; the checksum and SHA-1 are not, because they cost an adler32
and a SHA-1 over every megabyte on every boot and the zip already CRC'd the same bytes.

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

A split install (.xapk, .apks, an App Bundle's output) is a zip of apks rather than an apk,
which is how Play distributes everything now. `openInstall` (`src/shell/install.ts`) merges them
into the one tree the rest of the boot expects: the base is the apk whose manifest has no
`split` attribute, it wins every conflict the way its dex is first on a device's class path, and
each split's dex is renamed so both survive. It is shared by the shell, the dev server's
`/asset` route and the bun scripts, so an xapk is an apk everywhere or nowhere — before that,
`bun run inspect|dis|smoke|audit` could not open one at all.

**An entry that was stored is a view, not a copy.** `zipTree` (`jzip.ts`) indexes the central
directory and materialises one entry at a time: a stored entry is a subarray of bytes already
held, a deflated one is inflated on first read and then replaces its own accessor. `Object.keys`
stays free; **`Object.entries` inflates the whole tree**, which is why nothing on the boot path
uses it. Among Us.xapk is 1.1 GB with a 1.05 GB asset pack, and the eager form cost 6,573 MB of
`usedJSHeapSize` against a 4,395 MB limit — one boot, over the limit. Lazily it is 1,518 MB, and
every other apk boots faster for it.

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
containing an sget or a new-instance could ever be sync. Measured neutral on boot and on
frame counts (checked by A/B, not assumed).

**A harness note that cost time**: harmonic's `draws` looked like it had doubled against an
earlier baseline. It had not. harmonic invalidates on essentially every frame at idle either
way — the earlier run simply drew less because its scroll steps timed out. A step that wedges
draws fewer frames, so `draws` and `drawMs` move with the scroll steps' own instability and
say nothing on their own. Read them beside the per-step content diff, never alone.

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

## The screen is a setting, and what that cost (default 1080x2424 @480dpi)
The profile's screen is now **resolved** at module init, not written down: `?screen=WxH@dpi` >
`WEBDROID_SCREEN` > `localStorage["wd:screen"]` > the built-in default — the `?bytecode=` idiom
from `jvm/provenance.ts`, for the same reason (A/B the same bundle, no rebuild). The shell has
a w/h/dpi panel that persists and **reloads**. A reload is not a shortcut: every consumer reads
the profile after config.ts is evaluated, and there is exactly ONE module-level snapshot in the
tree (`shell/device.ts:30`), so a reload is correct by construction and costs the frame path
nothing. `input.ts` maps through `rect.width` ratios and `webkit.ts` places iframes in percent,
so both were already resolution-agnostic — do not "fix" them.

`density` is now `densityDpi / 160` (AOSP's own definition) rather than a second literal that
could disagree, and the status/nav bars are 24dp rather than 48px.

**480dpi is chosen so 1080/3 and 2424/3 are exact and `widthDp` stays 360** — the same width
bucket every layout and `sw360dp` resource already selects. Only the shape changes: 616dp of
activity becomes 784dp.

**2.84x the pixels is very nearly free**, which "Perf: what actually costs" already predicts —
the cost is per draw op and per layout, and neither is a function of pixel count. fitnotes,
same flow, 720x1280 vs 1080x2424: **ms/frame 0.306 -> 0.308, ms/draw 0.275 -> 0.281**, boot
173 -> 169ms, drawErrors 0, 39/39. `layoutMs` and `measureText` FELL, because a taller screen
lays out different content, not more of it. Per-pixel rasterisation is the compositor's and is
in none of these counters.

**What actually broke was never a pixel count — it was ~40 bare density-2 px in the widgets we
draw ourselves.** dialog, popup/toast/menu, listview, preference, CompoundButton, the status
bar art, and half of ViewConfiguration (whose `getScaledMinimumFlingVelocity` returned 100 while
`static getMinimumFlingVelocity` right beside it returned 50 — the same number times a density
nobody had written down). All go through `device.dp()`, which is **unrounded** like `scrollUnit`:
a stroke width and a glyph offset are legitimately fractional, and int-returning natives round at
their own boundary.

The sharpest one, and the shape to remember: **CompoundButton's `buttonW` reserved the indicator's
width and was 64px.** The drawable itself scaled correctly and painted at its right intrinsic
size; the reservation did not, so at density 3 the text started 32px inside a 96px indicator.
*A drawable that scales, laid out by a number that does not, reads as a drawable bug.* Look for
the layout constant, not the asset.

**Every one of those conversions was value-preserving at density 2 on purpose**, so the pinned
gate proves the refactor before the default moves. It did: fitnotes 43.07% and mihon-onboarding
17.55% identical to the digit across all of it.

**The harness geometry comes from the goldens, not the profile** (see `tests/e2e/README.md`).
`types.ts` used to export `SCREEN_W = device.width`, which the driver used to denormalize taps —
so moving the default would have silently mis-tapped every flow, and `diff.ts` would NOT have
caught it: it checks the frame size, and the frames stay right. Each flow now navigates to its
own manifest's `device` block. `WEBDROID_SCREEN` runs at another size and **un-scores the run**
(it takes the smoke branch), so the gate cannot be passed at the wrong geometry by accident.

**`vendor/framework-res.apk` can no longer be pre-picked for one profile.** It was linked
`--preferred-density 320dpi`: 1457 xhdpi drawables against 100 xxhdpi, so a 480dpi profile
resolved xhdpi and upscaled it 1.5x — right geometry, wrong art, and nothing anywhere reports
it. Density filtering is gone (xxhdpi 100 -> 906) at +4.6MB, 7.3 -> 11.9MB. The `-c sw<N>dp`
filter is KEPT: it degrades to the unqualified variant rather than to a wrong pixel, and it is
what holds the package to 11.9MB instead of 18.9 — the sw600/sw720 wallpapers alone are 7.4MB
of art nothing here draws.

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
libc/EGL/GLES imports). It sits in the same bucket as Among Us (IL2CPP arm64), and the target
is a boot that is *honest*, not usable. What the
Java embedding does now, all of it the app's own code:
- `MainActivity.onCreate` → `SplashScreen.installSplashScreen` → `FlutterActivity.onCreate`
  → `FlutterLoader.startInitialization` (needs `DisplayManager.registerDisplayListener` for
  its `VsyncWaiter`) → the init `Callable` on an executor → `FlutterJNI.loadLibrary`:
  `System.loadLibrary("flutter")`. **Since the A64 tier landed this no longer fails at the ABI**
  — all 11.7 MB of `libflutter.so` loads and relocates, and 54 instructions of its init arrays
  run before `unimplemented 0x4e080c02` (a NEON encoding) stops it. `nativeRequired` and the
  `#native` line name `libflutter.so (arm64-v8a)` from the rejection rather than from the file
  being absent. Flutter's catch only recognises the two bionic "not found" messages, so it
  rethrows; `Future.get` wraps it in `ExecutionException`; `ensureInitializationComplete` logs
  `Flutter initialization failed.` and throws `RuntimeException` out of `onCreate`
  (`reportUncaught`, the one entry in `newErrors`). `onStart/onResume/onPostResume/onBackPressed`
  then take FlutterActivity's own "called after detach" early-outs — Back is a no-op, the
  activity stays. The embedded ReLinker's re-extraction path (`ZipFile(ApplicationInfo.sourceDir)`
  into `getDir("lib")`, then `System.load(path)`) is no longer reached, but it now would find
  `lib/arm64-v8a/` if it were: sourceDir is the base apk, not the container.
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

## Lichess: bounded native byte searches

A headless Chrome CPU profile of Lichess startup at `6813448` spent 8.605 seconds in
`libc.memchr`, between 0.608 and 9.222 seconds after navigation. The implementation searched
from the input pointer to the end of the entire 4 GiB guest buffer, then checked whether the
match fell within the requested length. Short unsuccessful searches consequently scanned
gigabytes without advancing guest instruction counters. Restricting `indexOf` to the requested
byte span removes that work while preserving the first-match address and unsigned-byte rules.
The focused native test covers empty spans, excluded boundary matches, and nonzero offsets.
This profile ended at Dart's `virtual_memory_posix.cc:723` commit failure; it does not establish
successful application startup.
With the bounded search and the concurrent fixed-mapping work, a second run executed 105.77M
native instructions in 1.57 seconds of native time and reached a later JNI exception at 2.04
seconds. `memchr` disappeared from sampled hotspots and the longest browser task was 130ms.
The different stopping points make these work-completion measurements, not an end-to-end
startup speedup claim.

## Lichess: declared native suspension

`WEBDROID_URL=http://localhost:4090 bun run natcheck lichess.apk` initially reached 17 native
entries returning undeclared promises. Lifecycle, view, database, class-loading, writer,
security and concurrency wrappers now declare their suspension. Map insertion retains its
synchronous primitive-key path: `maySuspend(fn)` records conditional suspension without wrapping
the function, and both the oracle and audit consult that declaration. Tests cover immediate
map returns, custom Java equality, oracle classification and continued detection of unmarked
promises. The same Lichess startup scan then reported zero undeclared promises. This is reached
startup coverage only; the experimental sync tier remains opt-in.

## Among Us: Practice and code-cache pressure

Validated on 2026-09-07: `PORT=4197 bun run dev`, then open
`http://localhost:4197/?apk=Among%20Us.xapk`. After the user-approved notice, the game's
Google account failure dialogs offer Continue and Close. Play → Practice → The Skeld hosts
and joins a real process-local UDP session. The cafeteria, player, tasks and joystick render;
joystick input moves the player and camera. Account success is not fabricated. External UDP
has no relay and remains unsupported.

ARM64 cold blocks share interpreted handlers; frequently executed entries compile after
1,024 visits. The compiled cache retains at most roughly 24,576 blocks, evicting old pages to
a lower watermark. Eviction must release both outgoing and incoming hot links, including
when compiling a target evicts its active caller. `cache.test.ts` covers this and repeated
self-modifying code. Evictions are separate from code-write invalidation telemetry.

Without the cache bound, retained generated functions exhausted V8's executable space:
366 full GCs in ~18 seconds and 87.6% of CPU samples in GC despite gigabytes of available
ordinary heap. With the bound, GC samples fell to 8.7%, map selection reached gameplay in
about 20 seconds instead of 110–150, and a controlled headless SwiftShader run sustained
roughly 4–9 fps. This is a measured improvement, not smooth gameplay. Range-backed asset
reads retain 32 × 1 MiB cache pages; they were not the source of the GC storm.

## Among Us: where the wall actually is
Historical bring-up notes below; the current result is documented above.

The whole Java layer runs. `bun run smoke "apks/Among Us.xapk"` compiles all 18,889 classes with
0 method failures in 2.6s; a boot merges the split install, initialises WorkManager, Sentry and
ProfileInstaller, and leaves **`wd.rt.missing` empty**. Nine APIs got it there, none of them
Among-Us-specific and all of them found by reading that list rather than a stack trace — see the
commits from `net: X500Principal` onward. Two were only legible after inverting `abi.ts`'s
`hash36` over candidate descriptors: a missing method that surfaces as
`v0.m$getQueue$ucjqmv is not a function` carries no class name, and the technique is how
`getQueue()BlockingQueue`, `purge()V` and `Runtime.exec([String)Process` got their signatures.

The launcher activity's `<clinit>` is one instruction: `System.loadLibrary("EOSSDK")`. That is a
25 MB arm64 image, so the boot's outcome is decided entirely by the native tier — which is why
this app, uniquely, is a native-tier problem wearing a framework problem's clothes.

**Where it stops now.** `libEOSSDK.so` loads: 70,789 RELA relocations applied, 744 exports,
57 init-array entries, GNU-hash-only symbol table. It executes 140 instructions of those init
arrays and stops at `unimplemented 0x4f07f601 @ libEOSSDK.so!EOS_EndScopeEvent+0x31ccc` — a NEON
`movi`. `libc++_shared.so`, `libunity.so` and `libil2cpp.so` stop the same way, each naming its
own encoding. `libmain.so` and `libsentry.so` run to completion; `libmain.so`'s `JNI_OnLoad`
registers `NativeLoader.load(String)Z` and `NativeLoader.unload()Z` in 27 instructions.

**What is between here and a frame of the game**, in order of size: NEON (`vfp.ts` is VFPv3
scalar and there is no SIMD at all, and guessing lane semantics is exactly the plausible-wrong-
value rule 5 forbids); the Bionic surface those images import — 322 undefined symbols for
libEOSSDK, 346 for libunity, and `nrun --link` prints them per image, which is the queue;
`libandroid.so`, `libOpenSLES.so` and `libmediandk.so`, which do not exist here at all; and a
programmable-pipeline `libGLESv3.so`, which `gles1.ts` (ES 1.1 plus a 17-function ES2 alias
table) is not. The last of those is independent of the CPU work and should not be entangled with
it. Do not read "Among Us boots" as "Among Us is close".

## The A64 tier: a split register file, because BigInt is 32x
`src/native/a64.ts` is a third emitter on `arm.ts`'s contract — `emitA64Block` returns
`{src,len,end,slots}`, `flags.ts`'s liveness pass, memory inlining, self-loop wrapping, register
hoisting and exit shape are all shared, and A64's condition codes are ARM's so `COND`/
`COND_READS` carry over verbatim.

**The register file was measured before it was written.** On a data-dependent chain of 50M
emulated adds: a split hi/lo `Int32Array` pair 53ms, `BigInt64Array` 1,686ms, the 32-bit tier
52ms. BigInt is not a slow option, it is not an option. A W-form write zero-extends into its X
register *architecturally*, so `H[d]=0` is the entire cost of the 32-bit half of the ISA, and
every shift whose amount is in the encoding is split across the halves at emit time.

`wd.native.bench()` quotes both tiers on the same six-instruction byte-copy loop: **arm 4,196M
instr/s, a64 2,852M** (bun). Hoisting is worth 2,258 → 2,852 on the A64 side; the rest of the gap
is that loop's `sub`/`add`/`cbnz` doing two halves each, which is the architecture.

**A process is one ABI.** Android never mixes widths in one image's dependency graph, so the
instruction set, the pc/lr/sp register indices and the guest pointer width are properties of the
*process*, set when its first image loads (`setA64`) — one `Int32Array(33)` either way, so the
run loop indexes rather than branches. `dl.ts` throws if a second image disagrees.

Two bugs worth remembering, both a whole class rather than one site:
- **`w & mask` is a signed int32 in JS.** Every encoding test whose mask keeps bit 31 compared a
  negative number against a positive literal and could never match. `RET` was the first casualty
  and the block ran off the end of the function. All 31 tests go through one unsigned helper now.
- **ARM's `DecodeBitMasks` rejects `imms == levels` only for a logical immediate.** Applying it
  to the bitfield forms as well would have refused `lsr x, x, #40` and every alias like it.

The decoder's tests take their encodings from `clang -target aarch64-linux-gnu` and their
mnemonics from objdump — never hand-derived, the same discipline PLAN.md's rule 3 states for dex
signatures. Both decoder test files reserve their code page through `mem.reserve` rather than
naming an address the stack allocator can march into.

**Deliberately absent, and why:** NEON (above); `DT_RELR` and Android packed relocations, which
appear in none of the corpus's 17 arm64 images and are *refused by name* rather than skipped,
because a relocation table silently never applied crashes somewhere unrelated; ifuncs, TLS
relocations and symbol versioning, all measured absent.

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
mihon-app and harmonic unchanged within their run-to-run spread (two identical runs differ by
0.5 on mihon-app, ~6 on harmonic).

## Lichess: RSA secure storage

Lichess DEX `p5` requests RSA from AndroidKeyStore, then wraps an AES key with
`RSA/ECB/OAEPPadding`, SHA-256 and MGF1-SHA1. WebCrypto cannot express independent OAEP
and MGF digests. RSA generation uses WebCrypto; node-forge 1.4.0 loads dynamically for
OAEP and real self-signed certificate DER. Its maintained [security release](https://github.com/digitalbazaar/forge/blob/main/CHANGELOG.md#140---2026-03-24)
fixes the published 2025/2026 advisories; its [RSA documentation](https://github.com/digitalbazaar/forge#rsa)
explicitly covers Java's mixed-digest OAEP. Private operations use its blinded CRT path.
Software key material persists with the existing keystore state; Java keystore private keys
remain non-exportable and requests for hardware backing/authentication fail explicitly.

Focused tests verify generated X.509 signatures independently, restore persisted keys, cross-check
SHA-1 OAEP with Node crypto and SHA-256/MGF1-SHA1 wrapping with OpenSSL, and reject tampered
ciphertexts. Headless Lichess startup passes this initialization and next reaches
KeyguardManager.isDeviceSecure. This is startup progress, not a final rendering result.


## Scoped locales: retain encoded variants, decode on first use

Lichess's localization channel constructs a Configuration and calls
Context.createConfigurationContext before looking up a string. Returning the original context
lost that locale. Scoped resource views now share parsed tables and archive data while owning
configuration, metrics, themes, and selector/bag caches. They are not added to the device resource
registry; repeated localization requests can be collected. The framework table is scoped too.

Removing language/direction parse-time pruning eagerly was rejected after isolated Bun parsing
of Lichess and the paired framework resources. Five warm parses plus a retained-heap measurement
after GC gave these representative results (heapUsed, not process RSS):

| Table | Original median / heap | Eager locales median / heap | Lazy locales median / heap |
| --- | --- | --- | --- |
| Lichess | 0.44–0.46 ms / 0.69 MB | 0.58 ms / 1.10 MB | 0.45 ms / 0.74 MB |
| Framework | 21.90–22.03 ms / 25.78 MB | 25.92 ms / 54.05 MB | 21.78 ms / 27.33 MB |

Eager decoding retained 230,674 framework entries instead of 37,099. Lazy chunks retain their
source buffer and name pools, decode only a requested locale/direction/type, and share decoded
entries and cached chunk selections across scoped views. Default decoded entry counts remain
37,099 for the framework and 2,529 for Lichess. First French selection across sampled types took
0.48 ms and 0.08 ms respectively. A single 100,000-lookup microbenchmark measured 28.5 ms versus
27.3 ms for framework defaults and 6.8 ms versus 6.5 ms for Lichess; these small differences need
longer controlled runs before interpretation. Other parse-time size/UI-type viability rules
remain in place; this change addresses runtime language and direction selection.

Focused tests build real binary resource chunks and exercise Java Context/Resources dispatch,
local configuration updates, shared lazy decoding, and selector-cache isolation. Full E2E was
reserved for the end of the Lichess investigation as requested.

## Lichess: shared vertex and index buffer storage

Flutter uploads geometry through COPY_WRITE_BUFFER, then uses the same GLES buffer for
vertex attributes and element indices. WebGL rejects that reuse. The bridge now allocates
a second backing buffer only on the first mixed bind, synchronizes subsequent uploads,
map/copy writes and GPU writes, and restores temporary bindings. Ordinary single-purpose
buffers retain one backing allocation. Focused tests cover both first-bind orders.

A targeted headless Lichess run reached 13 draws with zero GL errors and rendered the
Home/Puzzles/Learn/Watch/More navigation bar. Startup next failed in Java service metadata
and process queries, followed by JNI exception aborts; rendering itself was no longer black.

## Lichess: adjacent float values

The reached nextafterf import now steps the IEEE float32 representation by one ULP,
including signed zeros, subnormals, infinities and NaNs. A native ARM64 test exercises
16 boundary cases through the host ABI.

## Lichess: thread signal masks

Cronet reached rt_sigprocmask through syscall. The [Linux ARM64 table](https://raw.githubusercontent.com/torvalds/linux/v6.12/include/uapi/asm-generic/unistd.h)
and [ARM table](https://raw.githubusercontent.com/torvalds/linux/master/arch/arm/tools/syscall.tbl)
assign it 135 and 175 respectively. Both raw instruction dispatch and libc syscall now
apply per-thread masks, retain blocked pending signals, and dispatch after unblocking.
Pthread masks preserve errno on failure and new pthreads inherit their creator's mask.
Handlers apply sa_mask and their own signal mask (unless SA_NODEFER), restoring the previous
mask when they return; sigsuspend temporarily replaces that mask.

[AOSP signal types](https://raw.githubusercontent.com/aosp-mirror/platform_bionic/master/libc/include/bits/signal_types.h)
also exposed incorrect ARM32 sigaction offsets and oversized sigset writes. ARM32's
ordinary sigset is four bytes and sigaction is 16 bytes; kernel and *64 mask calls use
eight bytes. Targeted tests exercise both ABIs, pending coalescing, handler masks,
sigsuspend, inherited masks, and raw syscall errors. Lichess subsequently reports no
missing native calls at the rendered navigation screen; Java NetworkInfo gaps remain.

## Lichess: Dart environment enumeration

The repeated libflutter.so fault at +0x8becf4 was independent of Java exceptions.
Disassembly loads a GOT entry at +0xb41460, whose ELF relocation is environ, then
iterates the pointed-to string array. libc exported a zeroed pointer slot instead of
a terminated char** array. The shared environment now exposes NAME=VALUE entries;
getenv reads the same guest-visible representation, setenv honors overwrite, and
unsetenv removes entries. Environment updates release replaced owned allocations.

After the fix, a targeted headless run presented 120 Flutter frames and 5,912 draws
with zero GL errors, zero missing native calls and no native fault. The home header,
greeting, customization card and Play button rendered. Remaining Java network callback,
receiver query and SQLite overload gaps still prevented full initialization.

## Lichess: invisible card contents and narrow boolean arguments

More's Tools card had active hit targets but invisible rows. Glyph draws were submitted
without GL errors. Isolated probes disabling stencil or scissor had no effect; disabling
depth testing revealed every row. Native tracing then showed glDepthMask arguments
0x100 and 0x101, which the bridge converted to true in both cases.

[GLboolean is an unsigned byte](https://raw.githubusercontent.com/KhronosGroup/OpenGL-Registry/main/api/GLES3/gl3.h),
and [AAPCS64 leaves unused register bits unspecified](https://raw.githubusercontent.com/ARM-software/abi-aa/main/aapcs64/aapcs64.rst).
Both GLES bridges now mask that byte for boolean arguments. The same correction covers
JNI's direct boolean field setters; promoted variadic arguments remain full integers.
This restores the engine's depth-write control during clipping. No depth, stencil or
scissor behavior is disabled in the implementation.

Clean Lichess More screenshots at 480 and 700 dpi show all Tools rows and selection
indicators with normal graphics state and zero GL errors. Focused GLES/EGL/JNI tests
pass 87 assertions, including the actual 0x100/0x101 argument pattern.


## Lichess native socket availability (2026-09-08)

Lichess connects to its image and WebSocket hosts through the native TCP relay but
sends no TLS bytes. Connectivity DEX checks INTERNET capability 12, not VALIDATED
16; the latter is used by WorkManager. Native connect completion reaches Dart's
SO_ERROR query. A later EOF event exposed ioctl(FIONREAD) returning ENOSYS.
Socket FIONREAD now reports the relay's actual queued bytes or the first UDP packet's
size without consuming it. Unknown socket ioctls return ENOTTY. Targeted network
unit tests pass, including queued chunks, partial reads, datagrams and error cases.
The initial TLS failure is separate: Dart rejects the absent Android CA directory
before sending its ClientHello. No network-validation success is fabricated.


## Native emoji fallback: Noto COLRv1 without an eager download

The Lichess home greeting uses U+1F319 CRESCENT MOON at night and U+2600 U+FE0F during
the day. Both sequences are present in the APK's Dart AOT data, and the upstream home
widget confirms their use. Its bundled icon fonts do not provide a general emoji face;
the native fonts.xml previously contained only Roboto. Roboto has no moon glyph.

Added the unmodified, officially distributed Noto Color Emoji 2.051 COLRv1 font,
with its OFL license, pinned source revision and checksum under vendor/. It contains
1,499 mapped codepoints and is 4,991,984 bytes, versus 10,673,480 bytes for the upstream
CBDT font. Native Skia successfully rendered the yellow crescent through the standard
unnamed und-Zsye Android fallback family, with no new native missing APIs. No app or
glyph-specific replacement, font subset, or alternate rendering path was introduced.

The existing RangeFile mounts the face into /system/fonts, served by the cached vendor
route. A fresh headless launcher fetched only HEAD (300 header bytes, zero font body,
0.9 ms locally); Roboto requests in that run took 1.4–1.9 ms. On first native use in
Chrome, Skia opened the entire font: four 1,048,576-byte ranges and one 797,680-byte range.
Those requests took 4.4, 4.7, 3.6, 5.3 and 2.8 ms; HEAD took 2.2 ms. The five body ranges
are cached by the browser and bounded RangeFile cache. Lichess boot was 11,256 ms versus
an earlier 11,484 ms run, but that was not a controlled performance comparison. The
lazy mount avoids charging the body transfer to applications that never open this
native fallback; it does not reduce bytes when the font is used.


## Android trust store restores Lichess native TLS (2026-09-08)

The native socket trace reached connect completion, then fstatat64 on
`/system/etc/security/cacerts` failed with ENOENT. Dart's
[Android security context](https://raw.githubusercontent.com/dart-lang/sdk/main/runtime/bin/security_context_linux.cc)
always loads that directory; [LoadRootCertCache](https://raw.githubusercontent.com/dart-lang/sdk/main/runtime/bin/security_context.cc)
throws before the handshake if it is absent. The earlier Cronet DNS configuration
warning and the missing VALIDATED network capability were not this failure.

The shell now mounts 149 genuine AOSP certificates from pinned revision
45c7f199cb11b08f6d1ae2b75da25e53140a0c7d. The source provenance and upstream licensing
metadata accompany the asset. The unchanged PEM blocks occupy 222,448 bytes in one
file; a generated filename/length index mounts slices without an initial fetch or
HEAD request. Reads share a bounded 256 KiB range cache.

A clean Lichess run now sends real TLS ClientHello, verifies the server chain,
finishes the handshake and exchanges encrypted HTTP/WebSocket data through the TCP
relay. Requests reach image, API and WebSocket hosts; the network warning disappears.
No verification callback or hostname exception is installed. Native missing APIs
remain empty, with only the optional AndroidX Sidecar class reported by Java.
Typecheck and the asset test pass (451 assertions covering every certificate,
manifest boundaries, the pinned digest and lazy mounting).

## Browser input and Flutter editing connections

Lichess's Import PGN field is deliberately read-only and reads the clipboard on tap
(`lib/src/view/more/import_pgn_screen.dart` in the upstream lichess-org/mobile source).
Its empty TextInputPlugin client was not evidence of lost platform messages. After
native TLS could validate certificates, Watch → Broadcasts → Search provided a real
editable field. That path reached DynamicLayout while creating the app's InputConnection.

Browser input now requests the served view's real InputConnection and delivers edits,
composition, selection, and editor actions on the main queue. BaseInputConnection uses
virtual getEditable/replace calls and selection spans, preserving Flutter's editable
listeners. DynamicLayout reuses the existing layout engine and refreshes after text
changes. In a private Lichess browser run, typing Candidates rendered in the Flutter
search field; browser select-all, typing World, and Backspace left Worl in both the
Java editable and browser control. The search action completed without new missing
APIs. Focused IME and package tests and typecheck passed; Lichess smoke compilation
reported zero method failures. This was targeted verification, not the final E2E run.

## Lichess: playable native engine

The bundled Fairy-Stockfish wrapper creates pipes and redirects descriptors 0 and 1 with
dup2. fdWrite previously sent every write to descriptor 1 to the browser log, even after
redirection, so Dart's reader never received the engine's UCI responses. Console output now
belongs to the open file description and follows duplication; standard descriptors can be
closed and reused normally. FILE pushback also preserves the underlying pipe or file bytes.
No engine-specific transport or app bytecode replacement is involved.

A fresh headless Lichess game at level 1, playing white, reached `1. e4 h5` using the actual
ARM64 engine. Its initialization took roughly 3.1 seconds of active CPU work in a 12-second
profile with 8.9 seconds idle. The app's five-second startup timeout did not need changing.
The earlier timeout, cached FILE pointer, and uncalled sqrtl theories were not the cause.
Manual Chrome checks also verified board editing, Back, real network content, emoji fallback,
and browser text input. Authentication and account-specific features were not exercised.

The automated Lichess flow now uses stable offline tools: home, More, board editor, an e2–e4
drag, and Back. All five steps rendered, and the captured board shows the moved pawn. Java's
remaining reached absence is the optional AndroidX SidecarProvider extension; native missing
calls and JNI misses were empty in the targeted runs. Cronet still logs its DNS configuration
warning, but native TLS/HTTP/WebSocket traffic succeeds. Empty reached telemetry is not a
claim of complete API coverage.

## Regression review

The first full E2E capture found FitNotes' ActionBar title and Up navigation disappearing.
Deferring decor installation until after onCreate lets Lichess set its normal window theme,
but Activity.getActionBar also needs to install that decor before returning the bar. Otherwise
setTitle, setDisplayHomeAsUpEnabled and setNavigationMode silently discard their updates.
The lazy getActionBar path now preserves those settings, with a focused regression test and
a headless FitNotes navigation check.

Review also caught two input-connection cases hidden by Flutter's custom Editable: ordinary
EditText deletion needed to update the view's text, and its cached Editable needed linking
before virtual span calls. A cold regression test now checks deletion, selection and rereads.
Scoped configuration overrides now merge defined values against their source configuration;
zero fontScale/density and empty locales mean unspecified, not zero-sized text. The merge
preserves independent qualifier bit groups and keeps scoped display metrics in sync.

A longer Mihon onboarding replay then exposed two native SQLite handles aliasing the same
cached connection: both issued BEGIN IMMEDIATE in the same millisecond. Moving the cache
lookup after SQLite initialization had made concurrent opens reuse that connection. Native
opens now own separate connections over the shared file, while Java's database cache remains
shared. Tests verify committed visibility, independent TEMP tables, writer locking, read-only
opens, close rollback, and independent in-memory databases. Contention is reported rather
than silently accepting a second transaction.

Independent connections exposed the actual initialization race: the same Kotlin synchronized
lazy object was entered concurrently by the main thread and a dispatcher worker while its
value was still uninitialized, creating duplicate database pools. monitor-enter/monitor-exit
were no-ops. The shared JVM monitor table now tracks ownership and recursion, queues contended
entrants, and releases/reacquires locks around wait. Uncontended entry remains synchronous.
JNI uses the same table and Java thread identity. Compiler await guards restore thread identity
on rejected promises too, so catch-all monitor-exit runs as the thread that acquired the lock.
Compiled DEX tests cover the lazy-initializer race and exceptional release; runtime tests cover
notification, timeouts, interruption, recursion and Java/native contention.

Both inspected APKs use explicit monitor bytecode for every declared synchronized method:
173 in Mihon and 65 in Lichess, with no native synchronized methods. The
[DEX access flags](https://source.android.com/docs/core/runtime/dex-format#access-flags)
make DECLARED_SYNCHRONIZED informational; no extra method wrapper is added. A fresh 17-second
Mihon startup probe renders Welcome without nested-transaction or database-lock failures.

A fresh headless Lichess interaction check measured Play and computer setup settling in
0.8–1.3 seconds, e2 selection rendering in 93 ms, and e4 rendering in 219 ms. Stockfish's g6
reply appeared by 2.08 seconds. Native work still caused 120–341 ms timer pauses, so this is
usable emulation rather than a claim of consistently smooth frames. A reached custom-equality
Map.get suspension is now declared without wrapping its synchronous primitive-key path.

The remaining new Mihon composition failure was an application-startup queue race, not a
monitor failure. Application.onCreate ran outside onMain while its newly correct main executor
posted DI initialization. Activity launch mistook that other job's global queue depth for its
own ownership and ran inline. The preload finished before activity attachment, letting a frame
job enter composition creation a second time. Application construction, providers, onCreate,
and the initial activity now run in one main job. Before/after traces showed overlapping
composition and four layout failures becoming ordered initialization and zero layout failures.
Lichess still rendered Home after this change. EnumMap's typed put(Enum,Object) entry now shares
the existing erased implementation, fixing a newly reached analytics call without another map
backend. Local Binder attachments retain their owner and descriptor.

Chrome also reached RingtoneManager.getDefaultUri(TYPE_NOTIFICATION) during local play.
It now returns Android's symbolic settings URI, with the same mask precedence for ringtone,
notification, and alarm types. This lookup does not invent an installed sound or claim playback.

The software-rendered E2E launch initially captured a stable Flutter loading frame and sent
later taps before their screens were ready. Its Lichess flow now allows 40 seconds for cold
startup and two seconds after each interaction; a targeted replay visibly reached the editor
and moved e2 to e4. These are capture dwell times, not changes to guest clocks or engine limits.

## Verification

The final full E2E replay rendered all 101 steps without a wedged main queue, layout error,
or draw error. Content differences (lower is better) were FitNotes 43.07%, Mihon onboarding
17.56%, Mihon app 79.01%, and Harmonic 37.43%. An isolated replay of starting commit 7e557647
gave FitNotes 43.08% and onboarding 17.55%. The prior full report had Mihon app at 96.22%
with only 14/17 steps rendered; the final run rendered 17/17 and no longer logged Compose
failures. Coordinate fallbacks still limit which settings screens that flow actually reaches.
Harmonic's stable dialog/settings steps matched the prior report; its difference increase
from 35.70% was concentrated in the final two live-content scroll captures.

Per-step telemetry still reports established FitNotes FragmentManager/animation/Handler gaps,
Flappy Bird's DexClassLoader absence, and a Doodle Jump audio callback after Back that also
appears in the pre-work cleanup log. Mihon now reaches an optional account-class lookup;
Harmonic and Lichess query absent AndroidX vendor extensions. Lichess's five intended screens
were visually inspected, including the moved pawn; its only error-prefixed line was Cronet's
DNS configuration warning. No step reported a native-required library.

Against the isolated baseline, FitNotes elapsed time and draw count were essentially unchanged.
Mihon onboarding elapsed time rose 1%; recorded layout time rose 59%, while boot time rose 6%
and compiled classes rose 4%. Those counters include newly reached initialization and do not
justify a claim that the broader framework changes are free. Native Flutter still has noticeable
cold-start cost and occasional long CPU slices, as recorded above.

Typecheck and the full unit suite passed (773 tests, 9,279 assertions). All eight APK/XAPK smoke
compilations reported zero method failures; Lichess, Mihon and FitNotes were repeated after the
last framework changes. Framework bytecode exercises passed, including text/resources, and
textcmp broke all six paragraphs identically. The final-stage corpus rendered all eight APKs;
targeted Lichess natcheck reported zero false-synchronous delegates. Duplicate registration and
library-name matching checks were clean. Visual goldens were not changed.

## Saved databases and the running Chrome process

The last check in the original Chrome profile exposed two additional SQLite problems.
sqflite supplies typed arguments through SQLiteDatabase.CursorFactory, passing an empty
String array to rawQueryWithFactory. Ignoring the factory silently bound every query argument
to null. SQLiteQuery and SQLiteStatement now share SQLiteProgram's binding methods; the real
factory creates the cursor from its bound query. A test exercises long, double, string, blob,
and null arguments through Java virtual dispatch.

The live Lichess database also had 17 pages and user_version=5, while its saved snapshot had
only one page and version 0. Copying the main file omitted committed WAL pages. Persistence
now attempts a nonblocking PASSIVE checkpoint and defers snapshots when readers or a raw SQL
transaction prevent completion. Tests cover committed rows and schema version, raw BEGIN and
COMMIT, and preserving a prepared statement, TEMP table, and TEMP trigger. The existing browser
database was checkpointed before reload; its subsequently saved 94,208-byte snapshot retained
version 5. Concurrent sql.js initialization was investigated and rejected as a cause: the
package already memoizes its initialization promise.

The original Chrome process remained too slow for Lichess's five-second Stockfish startup
deadline. It was still running 152.0.7977.64, whereas the installed browser was 152.0.7977.82.
The same roughly 570 million guest instructions completed in 2.6 seconds in both headless
and visible fresh instances of the installed browser, but took over 15 seconds in the original
process. A fresh tab in that process was also slow. Foregrounding it, removing debugger
attachment, and resetting CPU throttling did not resolve the difference; enabling the debugger
in a fresh instance did not reproduce it. This establishes a browser-process difference,
not proof that the version update alone caused it. Guest clocks and the app's timeout remain
unchanged.

A normal, separately launched visible Chrome 152.0.7977.82 window, without Playwright's
launch defaults, played `1. e4 d6 2. Nf3 Bg4` and was left open. Its database persisted
61,440 bytes at version 5; app_log had no rows, including no engine timeouts or database-lock
warnings. Reached native/JNI misses were empty and Java reported only optional SidecarProvider.
The existing Chrome windows and their profile were preserved. External-OES shader precompile
diagnostics and Cronet's DNS warning still appeared without blocking ordinary rendering or play.

After both SQLite changes, typecheck and all 775 unit tests passed (9,295 assertions), and
Lichess, FitNotes, and Mihon smoke compilation again reported zero method failures. The final
full E2E replay rendered 101/101 steps with zero main-loop wedges, layout errors, draw errors,
or native-required libraries. Scores were FitNotes 43.07%, onboarding 17.56%, Mihon app 81.90%,
and Harmonic 36.23%. The same established missing APIs and non-rendering errors remained.
Lichess's editor pawn capture was inspected again. Mihon's change from the preceding 79.01%
run was concentrated in dialog dismissal (43.78% to 96.71%): the fallback-driven flow was
on Data and storage instead of the golden Reader settings. This limits the flow's fidelity
claim despite complete rendering and no Compose errors. Harmonic's stable screens remained
unchanged; its live scroll captures varied. Goldens were unchanged.

## Lichess: reclaiming short-lived native threads

A longer-lived game exhausted the 512 KiB host-data arena in Cpu construction. A controlled
120-second idle replay added 92 finished DartWorkers while live threads stayed at 18. Host
usage increased by exactly 24,288 bytes: 264 bytes of TLS and errno storage per worker.
Stacks were recycled, but thread data was bump-allocated forever and both CPU and pthread
registries retained completed threads. This was ordinary thread churn, not growing concurrency.

TLS/errno and JNI environments now use reclaimable allocations. Exit runs TLS destructors
and waits for active signal handlers before releasing storage and CPU bindings. Join records
retain only completion/result state and disappear on join or detached completion. Detach
attributes use Bionic's flags word; ARM32 joins write one pointer rather than eight bytes.
Allocation failures leave fixed-arena cursors unchanged, and exhausted thread resources return
EAGAIN without retaining a partially constructed CPU. Guest-set TLS pointers do not transfer
ownership of the original allocation.

The matching corrected idle replay stayed at 18 live CPUs, zero retained finished CPUs, and
7,880 host bytes for all 120 seconds. It then played `2. Nf3 d5` after `1. e4 h5`.
Idle malloc growth was similar before and after (947,456 versus 926,480 bytes); the host-data
leak disappeared. Tests include 3,000 CPU/JNI lifetimes, actual ARM32/A64 pthread churn,
join/detach results, destructor rounds/failures, and a parked signal during thread exit.
All 783 unit tests and typecheck passed; all eight APK/XAPK smoke compilations had zero
method failures.

The final full E2E rendered 101/101 steps with zero wedges, layout/draw errors, or
native-required libraries. FitNotes stayed at 43.07%, onboarding at 17.56%, Mihon app was
75.34%, and Harmonic 37.14%; Harmonic's differences remained confined to live content.
No new regression errors appeared, and goldens were unchanged. A visible Chrome game was
left at `1. e4 e6 2. Nf3 Nh6` throughout that run. About seven minutes later it still had
18 live CPUs, zero finished CPUs, and exactly 7,880 host bytes, with an idle main queue
and no native fault or new uncaught error.

## Lichess: native heap reuse during computer games

Moving the knight to e5 exposed a sign-extended native pointer such as
`0xffffffff_8a4f1840`. Malloc's small-bin heads and both free-list next-pointer reads used
signed Int32 values; an aligned block's owner pointer had the same problem. Reusing heap
addresses above 2 GiB therefore returned a negative JavaScript number, which the native ABI
correctly sign-extended as an integer result. Unsigned heads and pointer reads fix the source
of corruption, including calloc zeroing, realloc copies, and aligned frees. A subprocess
regression advances the heap past 2 GiB while touching only allocation headers, then exercises
real A64 host malloc returns and these reuse paths without contaminating later ARM32 tests.

The next longer game reached the third engine reply but then exited with
`Failed to allocate 410MB for transposition table.` Allocation tracing showed that Stockfish
requested 410 MiB with 2 MiB alignment. Memalign allocated 432,013,328 bytes, then discarded
that allocation record in favor of the aligned pointer and 429,916,160-byte payload. Free
released only the payload, leaving a hole too small for the next inflated request. Five
successive tables occupied different addresses; the sixth allocation failed. This was not
concurrent table growth or an engine timeout.

Large aligned allocations now select an aligned page run directly, with no oversized
intermediate allocation. Tests repeatedly reuse aligned blocks, check exact allocation
accounting, and preserve neighboring data. A fresh Chrome game completed ten white moves
and ten engine replies, ending at `10. d7 g5`. Every traced 410 MiB table reused address
127,926,272, with no allocation failure; the bump-allocation high-water mark stayed near
58.5 MB instead of 2.249 GB. Total live malloc storage was about 487 MB, including the table.
There were 18 live CPUs, zero retained finished CPUs, no native fault, and no reached native
or JNI misses. Optional SidecarProvider remained absent. Guest engine limits and clocks were
unchanged.

The adjacent libc handlers also now honor Android aligned-allocation semantics: POSIX failures
return EINVAL/ENOMEM without changing the output pointer or errno, while Android memalign
rounds arbitrary alignment upward and sets errno on allocation failure. Full-width size_t
arguments cannot wrap oversized A64 requests into successful tiny allocations. Real host-call
tests cover both ABIs; behavior follows Android Scudo's wrappers_c.inc.

Typecheck and all 787 unit tests passed (25,144 assertions), and all eight APK/XAPK smoke
compilations reported zero method failures. The expanded Lichess-only E2E rendered 15/15
steps, visibly reaching `1. e4 e6 2. Nf3 c5 3. Ne5 Nc6` at level 1. The final full E2E
rendered 111/111 steps, with zero wedges, settle timeouts, layout/draw errors, or native-required
libraries. Its Lichess setup transition was delayed and used default level 4 instead of the
intended level 1; the actual game still completed `1. e4 d5 2. Nf3 e6 3. Ne5 Qd6` without
native errors. The intermediate setup capture was black, so rendered-step counts alone do
not establish that each intended setup selection was reached.

Final content differences were FitNotes 43.07%, onboarding 17.56%, Mihon app 81.16%, and
Harmonic 35.38%. FitNotes/onboarding remained stable; Mihon's coordinate-driven settings and
dialog transitions varied as previously documented, and Harmonic still contains live content.
No new missing APIs appeared. Doodle Jump's intermittent null audio listener after Back
reappeared; this error predates this work. Its game still rendered, and Flappy Bird's frame
rates matched the preceding run. Goldens were unchanged.

The dedicated visible Chrome window was reloaded with saved databases intact and left at
`1. e4 b6 2. Nf3 g6 3. Ne5 a5 4. d4 Bb7`. The main queue was idle, with 18 live CPUs,
zero finished CPUs, no native fault, and about 487 MB live malloc storage. Lichess's database
remained 61,440 bytes at schema version 5.

## Mihon: extension repository and installation

The visible Chrome flow uses Mihon 0.20.4 at 1080×2424@480. Keiyoushi's real
`index.pb` repository loads and persists. Gzip decoding initially rejected the response:
Inflater reported compressed input length as output length, breaking Okio's ISIZE check.
The counters now track consumed input and drained output separately, excluding the trailer.

Several apparent Compose failures had platform causes. Managed popup windows were never
attached or positioned; saved-state lists lacked Serializable; and persisted string sets
serialized Java collection internals into unusable objects. Popup attachment now follows
window lifecycle, Arrays.asList retains its live backing and Java interfaces, and preferences
snapshot string sets into a validated storage representation. Old malformed set records cannot
recover their lost strings. View focus-rectangle dispatch and inset-controller ownership now
reach their Java entry points. The browser shell reports zero controllable system-inset types.

A separate startup Optional failure was a DEX field collision: two obfuscated statics shared
a name but had different descriptors. Qualifying only colliding static field names preserves
ordinary fast property access while keeping reflective and inherited lookup correct.

Package installation support parses actual APK manifests and resources, verifies APK v2/v3
signatures and content digests, persists installed archives, and loads extension DEX through
isolated class loaders with parent delegation. Service lifecycle runs on the main queue.
MangaDex's actual archive passes smoke compilation with zero method failures, as does Mihon.
ImageDecoder now uses the existing bitmap pipeline with the Java header callback before
target-size rasterization; a real PNG check verifies dimensions, pixels, repeated decoding,
and unchanged ByteBuffer position. The catalog visibly renders MangaDex's icon with empty
reached missing-API telemetry.

Mihon's normal PackageInstaller flow installed MangaDex 1.4.212 and its English source
survived reload. FileProvider needed real PackageItemInfo XML metadata, attachment before
onCreate, and ContentResolver dispatch into its bundled bytecode. MatrixCursor reuses the
existing cursor implementation and unboxes the provider's Long size. A real FileProvider
test checks file bytes, filename/size queries, and rejected traversal. The notification builder
also now preserves its own extras when setExtras receives null and copies user metadata at
build time, matching AOSP's separate user-extras bundle.

The live catalog rendered manga covers, but selecting a title initially reported
SourceNotInstalledException. SQLite had stored source ID 2499283573021220255 as
2499283573021220352. Preserving BigInt only at the JS boundary was insufficient: upstream
sql.js binds BigInt as TEXT and large Number values as DOUBLE. The pinned local sql.js build
exports sqlite3_bind_int64 and binds BigInt as INTEGER; its patch and reproducible build live
under vendor/sql.js. Java and bundled JNI paths now preserve integer reads and scalar results.
Tests cover signed 64-bit endpoints, INTEGER parameter type, arithmetic, and source-ID lookup;
transaction/persistence tests still pass. Rebuilding the vendor artifacts twice gave identical
hashes. Existing rounded database values cannot recover their discarded bits; fresh source
queries use the correct ID.

An isolated full Mihon boot loaded the real MangaDex factory and all 61 language sources.
Its safe popular query returned 20 manga. PropertyResourceBundle and shared Java properties
parsing then enabled translated manga details. Frieren's live English chapter feed returned
zero chapters; The Eminence in Shadow returned 99 chapters, 37 pages for chapter 1, and a
376,828-byte first image that decoded to 980×795. This source-level probe does not substitute
for completing the visible reader. LocalDate.until and ChronoUnit date arithmetic unblock
relative dates in the live details screen.

The visible details screen now renders its blurred cover using software RenderEffect. Pixel
checks cover unequal blur radii, a zero-radius axis, and child display-list updates. SQLite
reads retain their numeric fast path and only reread rows containing unsafe integers with
BigInt enabled. A 20,000-row browser benchmark measured 7.6 ms for ordinary integer rows
versus 20.1 ms when converting every integer to BigInt; exact large-ID rows cost 25.6 ms.

The saved library survives reload and opens chapter 1's 37-page reader. Reader setup needed
Bundle identity, nullable Paint metrics, and removeView ignoring null or unrelated children.
Browser checks verify metrics spacing without a destination object and unchanged parent,
callbacks, and layout state when removing a non-child. Software Canvas bitmap limits match
the paired AOSP bytecode's 32766-pixel dimensions.

The visible reader now renders pages 1–3 and Back followed by Start resumes at page 3.
Read/write locks use stable typed handles, per-thread hold counts, reentrant writes, downgrade,
and parked contention instead of fresh no-op handles. Native image decoding then reached
Matrix.setPolyToPoly: the existing affine solver is shared with the framework delegate and
accepts four-point affine mappings after checking the remaining corner. True perspective
still fails without mutating the matrix. Confirmed taps now reach the registered gesture
listener on main; the reader toolbar and wide-page panning respond to clicks.

Two separate issues surfaced in image decoding. AsyncTask ignored its executor and overlapped
background native calls under main-thread identity. It now uses actual executor workers with
main-queue lifecycle callbacks; each worker runs one task through completion. A native test
with real Java worker threads decoded overlapping tiles successfully, including recycle during
an in-flight decode. Cancellation of an already recycled decoder throws the app's expected
exception and does not explain the observed null bitmaps.

The live fifth page exposed a second failure: an intact 394,524-byte PNG decoded in Chrome
but returned null through the bundled native decoder. Native inflate consumed the final IDAT
input while retaining about 95 rows internally; libpng reached IEND after only 1,676,960 of
the required 1,784,000 filtered bytes. Input consumption now waits for its buffered output to
drain. The exact PNG completes with Z_STREAM_END and a non-null 1114×1600 bitmap. A focused
scanline-reader regression also verifies total input/output counts and zero-output behavior.
Six repeated decodes pass, and all 7,129,600 full-size RGBA bytes match Chrome's decoder.
The live reader now displays pages 5 and 6 with no decoder errors or reached missing APIs.

Chrome automation immediately canceled its native directory chooser despite visible focus
and live user activation. Native computer clicks also failed with no available window. The
user was asked to select Downloads/untitled manually. After the user completed that step,
Mihon's visible storage location changed to the `untitled folder` document tree, confirming
the selection. Native picker cancellation now stays canceled instead of silently selecting an
unrelated OPFS directory. OPFS fallback remains available when the browser lacks the picker
API. No server filesystem mount was introduced to bypass this browser boundary.

Search exposed two independent text and scheduling issues. ReplacementSpan now measures and
draws through the real Java callbacks, retaining indivisible span geometry and builder slices;
plain text keeps its synchronous measurement path. This removed Mihon's PlaceholderSpan
layout error but did not resolve the spinner. The cold search response then deadlocked while
initializing Jsoup's EscapeMode and TagSet. Async merge sorting and Map.compute callbacks
had lost the initiating Java thread, making initializer re-entry wait on itself. Restoring
thread identity before those callbacks fixes the deadlock without weakening class-initialization
serialization. A clean ViewModel probe emits paging inserts for both popular and search
results; the visible Chrome UI now renders Frieren search results after reload with no reached
missing APIs or errors. The saved chapter resumes visibly at page 6 of 37.

Array Class objects also retain their component's defining loader, including nested arrays,
without eagerly linking optional component classes. Sibling-loader identity and a fresh
MangaDex factory load are checked; all 61 source instances load without missing classes.

Final verification at aeeb47f: typecheck passes; 856 tests pass with 25,848 assertions and no
failures. All eight bundled APK/XAPK inputs and the MangaDex archive compile with zero method
failures. Framework checks pass with 295/363 declared-native delegates (81%); the six browser
text comparisons break identically. Literal and generated registration checks find no duplicate
class registrations or library-name matching.

The final full E2E capture renders all 111 steps, including all 75 scored steps, with no
wedges, settle timeouts, layout errors, or draw errors. Both Mihon flows reach no missing APIs
or errors. Content difference against the unchanged goldens is FitNotes 43.22% (starting
43.07%), Mihon onboarding 17.56% (17.56%), Mihon app 78.27% (81.16%), and Harmonic 32.88%
(35.38%); lower is better. FitNotes has 35 pixel-identical screenshots, three blinking-caret
differences, and one returned list preserving its earlier scroll position where the baseline
shifted 62 pixels. That last difference explains almost all of its 0.15-point increase; its
causal commit was not isolated. Existing FitNotes, game, and Lichess diagnostics remain.
Harmonic additionally logs an unsupported atomic-group regular expression: its actual URL
helper reproduces the same failure at the starting commit de745af, independent of the new
executor implementation.

Mihon app draw work fell from 6,838 to 5,874 ms and frame work from 25,502 to 21,518 ms, with
17/17 steps still rendered. These are single-run measurements, not throughput guarantees.
Calculator's first full-run timing rose from 18.53 to 23.34 seconds despite nearly identical
work counters. A subsequent isolated eight-step run completes in 17.97 seconds, with no
missing APIs or errors; the large compilation/drawing outliers do not reproduce. Its isolated
run is now in actual/calculatorm; the scored report remains the full capture.

## Presented frames and drawable callbacks

Typing in Calculator M3 (Compose + Material 3) flashed the screen white. Every frame was painted
straight into the visible canvas, and a draw pass runs app bytecode whose compiled loops yield
to the browser through `refuel()` at most every 8 ms. That yield is a task boundary, so the
compositor showed whatever had landed: for Compose, the decor's white window background before
the app's dark surface. Capturing the visible canvas at each in-draw yield reproduced it headless;
the calculator's keypress frames cost about 20 ms of bytecode draw and yielded once or twice
each, Mihon's cost the same, FitNotes' 0.3 ms draws never did. An image decode or class
initialisation inside a draw has the same effect.

Frames are now composed in an OffscreenCanvas and handed to a `bitmaprenderer` screen canvas
with `transferToImageBitmap`, a zero-copy swap. In the E2E's SwiftShader browser a synthetic
frame (fills, arcs, text, a WebGL canvas) presents in 8 ms this way against 30 ms drawn straight
into the visible canvas and 35 ms with a drawImage blit; the blit variant cost flappybird a
fifth of its fps. The transfer's one cost is readback: `toDataURL` on the transferred bitmap
takes 300 ms to 3.6 s there, so the harness captures with `toBlob`, which reads the same pixels
in single-digit milliseconds once warm. The first capture after a step's dwell in the GL game
flows still waits about a second on the software compositor, which the per-step wall time in
`run.json` reflects while the fps counts stay at their earlier values. A real GPU has neither
cost. With nothing presented until a pass ends, an in-draw yield only costs a macrotask
and lets unrelated timers run on the frame's clock, so the frame loop stretches the yield gap
to 50 ms while drawing. Boot draws stopped absorbing about 60 ms of other work each, and the
calculator's "=" frames fell from roughly 10 to 2 ms of wall time.

Ripples stuck at full strength on the calculator's buttons whenever the frame loop ran slowly,
which is what the earlier isolated E2E capture had recorded. Two causes. `setBackground` and
ImageView never set a drawable's callback, so `invalidateSelf` reached nobody and Compose's
RippleHostView only appeared to animate while Compose's own press state layer re-recorded the
button for other reasons. And the ripple invalidated from inside its own draw: Compose records
a layer with its dirty flag already set and clears it after the record, so an invalidate raised
mid-record is dropped and the frozen display list replays until something else re-records the
layer. AOSP's ripple is driven by animators that invalidate from the Choreographer. Views now
own their drawables' callbacks and the animating ripple queues its invalidate behind the frame
job. A 6× CPU-throttled harness loop that reproduced the stuck ripples now settles clean.

The calculatorm flow normalised its taps against a 720×1280 layout while running at 1080×2424;
Compose does not scale the keypad proportionally, so the 7 tap landed on backspace. The
calculator reaches no missing APIs or errors across the keypad, the function row, the error
path, the history sheet, and Back.

## Reddit: boot, and a login that reaches the server

Reddit is a split APK (base plus `config.*` splits) with Compose screens, Cronet, Tink and
reCAPTCHA. Getting it from a wedged boot to a login the server answers took the following,
each verified against the app rather than assumed.

**Boot.** androidx.startup's provider ran before the ones it depends on: providers are now
started in `initOrder` order like the framework does. Activities never received
`attachBaseContext`, so a theme lookup on the base context found nothing. The drawables and
English strings live in the splits, whose `resources.arsc` are merged into the base table with
their string pools remapped; the config matcher also learned regions, without which the
pseudolocale entries won. `getResourceId` on a resolved attribute answered the value rather
than the id it came from, which Reddit's own button style asked for. `Bundle.EMPTY`, Moshi's
generic reflection, a real `Parcel`, `AccountManager` persistence and X.509 verification for
Cronet's handshakes were the remaining boot blockers.

**A GC storm from generated code.** With the welcome screen up, V8 spent 9.3 s of a 12 s window
in major GCs ("allocation failure", nothing freed, heap around 590 MB of which 350 MB code
objects for 39k compiled bodies) and tapping a text field took 14 s to connect an input session.
The storm disappears under `--jitless`, `--no-sparkplug`, `--no-maglev` and
`--no-flush-bytecode`; a larger old space, 1 GB of guest memory, no backgrounding, no memory
reducer and the code-range flag change nothing. It is a flush-and-recompile loop over
machine code, so the lever is the size of the bodies. The one change that mattered: every
suspension point was `try { $t = await $t } finally { R.st($th) }`, a handler per call site.
Re-pinning the thread once in the method's own catch instead leaves the same 12 s window with
40 ms of GC, the input session connects in 1 ms, and frames more than double. Mihon's E2E
content diff moved from 61% to 59% on the same change. The heap is still large; the sync tier
remains the next lever, unchanged from its own section above.

**Cronet responses that arrived after their timeout.** After the first body chunk nothing
crossed the JNI boundary for 23 s while the main thread sat idle. Not epoll (its one-shot relay
subscription re-arms), not executor starvation (no pool had a task queued behind a busy worker),
but `BlockingQueue.add`: it was the plain list push, so a result added to a queue whose
`poll(timeout)` was already parked waited out the whole timeout. `add`, the timed `offer` and
the deque's `addFirst/addLast` now hand the element to a parked taker like `put` does.
`parkNanos` parks for its real duration instead of polling every second, which had 44 coroutine
workers waking each second.

**Unsafe and protobuf.** protobuf's Android accessor reads a double field with `getLong` and a
float with `getInt`, and rounds the offset down to a word; the offsets were table indices, so
the rounding hit a different field and the wide read returned the raw double, which
`Double.longBitsToDouble` then refused. Offsets stride by 8 and an access wider or narrower than
the field's declared type moves the bits.

**Login.** With the network right, Continue still failed inside the app without a request.
Tracing every call in `com/reddit/auth` at the tap showed the login use case waiting on a
reCAPTCHA token whose client job was already cancelled: reCAPTCHA's Tink keyset had failed at
boot on `java.security.KeyFactory`, then `RSAPublicKeySpec`, then `BigInteger.modPow`. EC keys
on the NIST curves, `KeyFactory` for EC and RSA specs and encodings, ECDH key agreement that
matches WebCrypto bit for bit, and the RSA key interfaces cover that chain. The device also now
declares its system features (a touchscreen, both orientations, a WebView) instead of answering
no to everything, and names its WebView provider. The login request then reaches Reddit and the
server answers "Invalid username or password" for the test credentials, which is the app
working. The feed itself needs an account, which this session did not have.

## Reddit: past the feed

**The community drawer.** Opening it gave a drawer container 0 wide with a NaN offset: Reddit
sizes it as a fraction of the screen, read through `TypedValue.getFloat`, which reinterprets
`data` as IEEE bits; a float resource was filled with the number itself, so every fraction read
that way was 0. With the width right the drawer opened onto a white pane: its RecyclerView, 0dp
wide with start/end constraints, measured 0. ConstraintLayout maps start/end to left/right in
`LayoutParams.resolveLayoutDirection`, which Android calls from `setLayoutParams` (so from
`addView` and a detached inflate); nothing called it, and the compiled override also needs the
MarginLayoutParams super and `getLayoutDirection`. Sized, the list stayed empty. Its screen's
presenter never attached: Conductor's ViewAttachHandler registers an attach listener on the
screen's root view, and at the root's attach a one-shot listener registered ahead of it removed
itself from the list being iterated, so the for-of skipped the handler. Attach, layout-change and
animator listeners now dispatch over a snapshot, as AOSP's copy-on-write lists do. The same fault
had left the post detail screen blank.

**A screen that never painted.** A text post opens a Compose screen inside a `ScreenPager`
hosted by Compose's `AndroidViewHolder`. It composed 318 layout nodes and drew nothing, and the
draw pass never reached the hosted subtree: a hosted view is baked into the display list of the
Compose layer around it, and the layer is re-recorded only when the child's invalidate reaches
`AndroidViewHolder.onDescendantInvalidated`. `View.invalidate` was a global flag and the native
`requestLayout` walk skipped compiled overrides of the parent's `requestLayout`, which Android
calls virtually. Both walks now hand off to an overriding ancestor, which resumes them through
super; the base walks on. The comment sheet's content view stayed 0x0 for another reason: its
`requestLayout` came during a layout pass, stopped at an ancestor the pass had flagged and then
cleared, and the pass cleared the requester's own flag on its way down. As
`ViewRootImpl.mLayoutRequesters` does, requests made mid-pass are recorded, their paths' flags
cleared, and the requests made again after the pass.

**Sixty threads.** With the detail screen visible, every GraphQL call failed with "out of stack
address space". The fixed stack span holds sixty 1 MiB stacks; Reddit's coroutine dispatcher,
OkHttp pool, Glide and Cronet threads pass that even with finished threads' stacks reclaimed. A
stack past the span is page-mapped arena memory, so the thread count is bounded by memory, as in
a process. 68 were alive after a drawer, a post and some scrolling.

**A native fault that was the tooling's.** Image requests through Cronet failed intermittently
with a fault at address 0x8 inside `setHttpMethod`, then "Invalid http method GET" and "Invalid
header" from the Java side. A fault now records a frame-pointer backtrace and the calls in
progress: the main Cpu had two nested `setHttpMethod` calls with no upcall between them, so two
Java threads were sharing it. The OkHttp outcome hook used for these sessions awaited a Java call
before invoking the method it wrapped, and app code then continued as whichever thread had last
resumed, usually main; `Thread.currentThread()` said so. A wrapper that awaits must restore the
thread it was entered on (`rt.st`). With the hook fixed, a login plus drawer, post and scrolling
produced no fault and no failed image request. Compiled code is not exposed to this: each method
captures its thread at entry and restores it after every await.

**Opening a post took 9.5 s** on the no-JIT driver, 9.3 s of it inside the tap's dispatch, with
the page 42% idle in a CPU profile: the main thread was in ConstraintLayout's solver yielding at
back edges every 8 ms through `setTimeout(0)`, which Chrome clamps to 4 ms once nested. The
native tier's MessageChannel yield has no clamp and is now the back-edge yield too. The effect is
not measured yet: the run meant to time it hit a post whose detail threw on the then-missing
`Html.escapeHtml`, and the pixel probe had caught the feed's own white before the screen changed.

## Reddit: shared cold bytecode execution

Stock arm64 Chrome still exhausted its executable-code range after login. Moving all awaits
in a method to one continuation point let the login form remain responsive, but the feed
again spent 80% of a 13.9-second CPU profile in GC with 211 MiB of executable code allocated
and about 237 MiB committed. A generator per Java method had failed earlier, at the form
(84% GC). The small welcome-screen working set was not a sufficient test.

Other rejected paths: a clock cache retaining 8 MiB of generated method source, stable lazy
entries and releasable compiled bodies churned through 200k compilations and still reached
215 MiB executable allocation. Retaining emitted source and raising the cache to 16 MiB
reduced recompilation work, but login still entered a long GC storm before eventually
settling. A heap snapshot then found only 44 MiB of live instruction streams: keeping fewer
JavaScript function references does not adequately control V8's code reclamation timing.
Sharing complete small method templates removed many duplicate bodies, but also failed at
the feed. None of those caches or method-template experiments remain.

Cold methods now execute shared instruction handlers made from the existing compiler's
emission, with register operands and constants in a per-instruction pool. There is one opcode
implementation, including float reaching definitions, Java calls, array stores and resource
references. A central runner owns the instruction PC, catch ranges and thread identity.
Handlers that may suspend are shared generators: an async helper would insert a suspension
even when all its calls returned synchronously, which broke lifecycle ordering at boot.
The generator only yields for an actual promise. After 32 calls a method gets its ordinary
specialized body; captured direct/interface entries follow the same promotion cell, while
fresh virtual calls find the body directly. A root runtime admits at most 32 MiB of specialized
async source (measured in code units); its classloader children share the budget. A denied
method remains cold without repeatedly generating source. This favors earlier hot methods;
synchronous bodies and shared handler code are outside this admission bound. The reached
post used 24.1 MB of specialized async source; broader navigation reached 24.7 MB.
Syntactically synchronous methods remain direct.
Hot bodies share one await site per method, preserving the DEX throwing PC separately from
the continuation index. Missing targets in pooled instructions retain their DEX owner and
descriptor in diagnostics.

On stock Chrome 152 arm64, the reached Reddit feed rendered text and images with 106 MiB of
executable code allocated and 122 MiB committed, roughly half the failing working set.
A settled 10.1-second profile was 65% idle, with GC below 0.3%. Opening a long text post grew
the loaded set to 18.8k classes; its content and composer rendered with no draw/layout errors,
and the following 7.2-second profile still had GC below 0.5%. These are reached-flow results,
not a guarantee that an arbitrarily large hot working set fits V8's code range.

The compiler fixture exercises synchronous effects before the first actual suspension,
mixed synchronous/asynchronous calls, throwing and fuel-refill continuations, catch ranges,
wide and floating arrays, object arrays, captured entries across promotion, and repeated calls after denied promotion. Pool tests
cover escaped strings containing compiler tokens and `await `, exponent numbers, bigint,
negative zero, and distinct field/method constant pools. `smoke --cold` lowers every method
through the shared handlers without running app code; ordinary smoke still checks every
specialized body. `coldCalls`, `coldHandlers` and `hotMethods` expose the execution split.

## Reddit: text, collections, and navigation after login

A fresh stock-V8 Playwright Chromium run renders the profile, settings, and account settings.
Search renders its trending topics, typed suggestions, and community results. A later fresh run
renders the community post list after the copy-on-write iterator correction below. These
observations do not establish every subreddit or video behavior; profile-return and Inbox
evidence is recorded separately below. The opt-in `tests/e2e/reddit.ts` diagnostic keeps
credentials in environment variables, avoids credential screenshots, and records rendered text
and per-step telemetry. It is separate from the golden flows. Final regression captures remain
pending while these investigations continue.

Two collection failures were platform bugs. Glide's obfuscated cache-eviction loop (`gwe.f`)
creates an entry iterator, removes its first entry, then schedules that resource for recycling.
The map view iterator removed only its snapshot, leaving the backing entry available to every
new iterator. Tests reproduced repeated eviction of the same resource; removal now unlinks the
owning fast or custom-equality entry. A fresh session completed 49 feed swipes without the
previous recycled-resource errors. Separately, search drawing called `Collections.sort` on a
Compose-owned List. Accessing native `l.a` threw on its different storage. Collections now
invokes overridable `List.sort`; the default implementation obtains `toArray` and writes through
`set`. A test covers custom storage and an overridden sorting method.

The deep-link parser's binary index was corrupted by `String.getBytes(Charset)` always encoding
UTF-8. Latin-1 must preserve byte values 0x80–0xff, including the C1 control range that web
TextDecoder's Latin-1 alias maps differently. Shared standard-charset conversion now handles
that distinction, ASCII replacement, UTF-16 byte order and BOMs, and the byte String constructor
overloads. The deprecated high-byte constructor combines each unsigned byte with its high byte.
A real deep-link index parses after the correction. Manifest activity resolution now handles
implicit action/category/data queries and launch, using separate scheme/host/path declarations
as Android does, with enabled/package/default filters and priority. Unsupported advanced path
filters fail closed. Unknown activities raise ActivityNotFoundException.

Other reached fixes include Java Number formatting via its numeric virtual method, Character
Unicode directionality, paired-framework Patterns expressions, Java regex character-class
unions/intersections, RectEvaluator, SweepGradient, normal BlurMaskFilter shape rendering,
PointerIcon values, FrameLayout's covariant default layout-parameter entry, TextUtils capitalization
and bounded searches, locale display language, permission metadata, immutable SpannedString
snapshots, and reflective IOException constructor discovery. Blur modes beyond NORMAL remain
unsupported; text/bitmap mask filtering is not established by the shape test. ActivityOptions
uses Android's default animation when the source window has not enabled activity transitions;
shared-element animation with that feature enabled remains explicitly unsupported.

Diagnostic pitfalls: enabling suspension stack tracing (`wd.suspends.on`) made Error.stack
capture dominate CPU and turned a working post into an apparent multi-minute stall. Turning it
off recovered the content and comments. The old scratch driver's space-split RD_FLAGS passed
`--no-maglev` as a Chromium flag instead of part of V8's `--js-flags`; its label was not proof
both tiers were disabled. Use the test driver's single WEBDROID_JS_FLAGS argument for that
experiment. `wd.tap` is asynchronous through DOWN and UP; awaiting an unrelated settle between
them can observe the previous screen. Await the complete tap when diagnosing input. Rendered
text observation avoids stale white-pixel matches but does not account for all clipping and
occlusion, so screenshots still establish what is visible.

A warm text-post reopening with suspension tracing off reached the detail-only rendered marker
and visible content after 3.528 seconds and settled after 12.106 seconds. That run used the old
scratch browser with Sparkplug disabled, before shared cold execution. It is a valid reached
transition, but is not a controlled speed comparison against the earlier 9.5-second measurement:
network content, warmed classes, and browser flags differ. No reply or post was submitted during
composer testing; a typed draft was discarded through the app's discard prompt.

## Reddit: sorted-collection suspension and profile resume

Returning from account settings through settings to the profile stalled before the next
Inbox tap. Runtime sampling found `vmt.l` repeatedly processing the same first entry of a
Compose `SortedSet`. Its backing array was `[19,16]` by node depth: removal of the first key
returned false even though the identical object remained at index zero. Instrumenting native
operations before navigation showed two overlapping adds with an asynchronous comparator.
A depth-19 add started on `[16,16]` and finished on `[16,16,19,16]`; the key's depth had not
changed. Both operations had computed an insertion index before another continuation mutated
the array. The extra promise continuation between search and splice also permitted this race.

Sorted searches now validate a structural revision after comparison and apply the result in
that same continuation. Clear, poll and inherited map-view removals invalidate pending searches;
callbacks retain their initiating Java thread. A regression with overlapping adds, duplicate
keys, removal and clear fails against the starting implementation and passes for TreeSet and
TreeMap after the fix. Natural-order primitive operations keep their synchronous path.

The runaway layout also exposed a separate compiler problem: its loop limit was inside the
DEX catch dispatch. A catch handler within its own try range caught the loop-limit error before
it could execute its move-exception/goto cleanup, producing an infinite non-yielding error loop.
The limit now escapes that method's catch dispatch in both execution tiers. This is a diagnostic
escape, not the sorted-collection repair.

With the collection fix, fresh stock Chrome 152 arm64 rendered profile, settings, account
settings, both Back transitions and Inbox without errors. Specialized async source grew to
28.29 MB, below the admission limit. The successful run used no runtime method probes.


## Reddit: cached media, surfaces, and listener snapshots

Community navigation exposed another listener-removal failure. A Java CopyOnWriteArrayList
iterator traversed the live list, so a callback removing itself shifted the next listener behind
the cursor. The skipped visibility callback left the community presenter detached. Snapshot
iterators now retain their original elements and reject mutation, including listIterator. A
fresh source-only run rendered r/Android's post headlines, comments, images and ad. An implicit
ACTION_VIEW link also opened an actual post and its comments; that particular live post had
been removed by a moderator, so it was unsuitable as a video reference.

The video data path reads cached DASH manifests and segments through RandomAccessFile. Its
read-only open check incorrectly rejected a present byte array when no lazy asset source
existed. Correcting that check admitted real manifests and cached segments. FileChannel's
read-only mapping then supplied direct, read-only ByteBuffer views over file ranges, restoring
feed thumbnails. Read-only status propagates through slices, duplicates and typed views;
writable mappings remain explicitly unsupported. ErrnoException retains typed errno and
functionName fields and preserves its cause when rethrown. The generic throwable factory now
links cached exception classes before constructing them, preserving Java catch identity.

TextureView previously reported permanent unavailability. It now creates a software surface
when attached with positive bounds, dispatches availability, size, update and destruction
callbacks on the main looper, and honors listener-retained SurfaceTexture ownership. Surface
handles release independently of their producer. EGL and decoded-video presentation share the
same framebuffer layer, accepting ImageBitmap or VideoFrame without an extra bitmap copy.
AudioTrack's builder and positioned ByteBuffer PCM input retain format, buffer capacity and
session identity, with nonblocking writes respecting queued capacity. These primitives are
unit-tested; their existence alone does not establish working video playback.

Process.getGidForName uses a generated Android 15 identity table and bionic's numeric, OEM and
multi-user group conventions. Unknown names return -1; there is no app-specific name rule.
The full unit suite passed after the surface, identity and collection changes; final regression
captures remain pending until the media integration is complete.

### Stock first-post content timing and hot-source plateau

A later stock Chrome 152 arm64 run, with the other diagnostic browsers closed and runtime
tracing disabled, opened a fresh session's first long text post in **3.70 s**. Two reopens of
the same post reached content in **2.31 s** and **2.19 s**. The detector required a new rendered
frame containing the post title, composer and at least four long body lines absent from the
feed, with the Home label gone. It did not use a white pixel or input-dispatch completion.
Full-page screenshots confirmed the body but finished at 10.04, 9.20 and 8.28 s respectively;
that separate capture/paint delay remains. Layout and draw errors were zero. These are current
measurements of one live post, not a controlled comparison with the handoff's older 9.5 s post.

Broader navigation reached 23.5k classes and the admission ceiling: specialized async source
stopped at 33,554,357 code units with 10,261 promotions. Text post, search and community-header
navigation continued with additional methods cold. The community feed itself remained empty
in that run, so this is not full community-content verification. A settled Inbox profile before
the ceiling was 2.6% GC, with 155 MiB executable allocation and 185 MiB committed. At the ceiling,
a profile was dominated by `transferToImageBitmap` (84.5%), with GC below 0.1%; a detailed memory
dump timed out, so there is no final executable-allocation measurement at the ceiling. The
source limit constrains admission, not V8's exact allocation or reclamation policy.

### BitmapShader and mutable bitmap drawing

Reddit's fullscreen video path reached the missing BitmapShader constructor. DEX references
use CLAMP/CLAMP in `uhj0.d`, `ar8.c` and `tly.b`, and REPEAT/CLAMP in `xsp0.O`; the platform
implementation accepts independent CLAMP, REPEAT, MIRROR and DECAL modes. Bitmap fills clip
the original shape and draw cached source/edge patterns, avoiding a viewport-sized atlas per
fill. Stroke/text use a pattern bounded to the target canvas. The shared shader local matrix
continues to map shader coordinates into canvas coordinates.

`WEBDROID_URL=http://localhost:4098 bun scripts/bitmap-shader-test.ts` passed 4,807 checks in
Chrome: all sixteen mode pairs, negative coordinates, rotated/reset local matrices, circle
clipping, stroked shapes, bitmap pixel changes, Canvas source mutations and reused Canvas
targets. Testing also exposed a preexisting stale pixel memo after a retained Canvas drew into
a bitmap. Bitmap-backed context writes now invalidate that memo and advance the generation
used by shader caches; ordinary framebuffer contexts do not acquire this tracking wrapper.
Constructor errors follow [AOSP BitmapShader](https://android.googlesource.com/platform/frameworks/base/+/master/graphics/java/android/graphics/BitmapShader.java)
and [Bitmap.checkRecycled](https://android.googlesource.com/platform/frameworks/base/+/master/graphics/java/android/graphics/Bitmap.java).

### Video decoding and frame scheduling

MediaCodec now probes browser WebCodecs support and supplies bounded decoder queues,
synchronous dequeue and Handler callbacks, actual decoded video frames and native-order PCM.
Real encoder fixtures exercise VP8, H.264, VP9 and Opus through the Java-facing adapter. Reddit's
AVC stream omits Android's key-frame flag, so the adapter reads the elementary stream's frame
header instead of requiring that optional flag. CryptoInfo and LogSessionId retain their actual
Java fields and identity. ByteBuffer.order links ByteOrder before exposing its values.

A current public video (`1w7xji6`, a 68-second drawing demonstration) reached 720x1280 AVC
frames and stereo 48-kHz AAC decoded to PCM. Its playback renderer then required
Choreographer.postVsyncCallback. These callbacks now use the existing main-thread frame queue,
with callback-scoped FrameData and one predicted browser presentation timeline. Recent rAF
cadence rejects an isolated delayed frame; each emulator frame snapshots its prediction before
awaiting callbacks. There is no fabricated set of Android compositor timelines.

The fresh session advanced through 2,066 surface frames with a running 48-kHz Web Audio clock,
but a screenshot was black: a cached RenderNode command held a VideoFrame after presentation
had replaced and closed it. Recorded surface draws now read the live surface at replay time,
just as nested RenderNodes read their current display lists. This avoids both retaining closed
frames and copying decoded pixels. That counter evidence alone is not visual playback proof;
a fresh capture is required after the replay fix.

Saved navigation separately exposed Material's inherited View.EMPTY_STATE_SET and
SELECTED_STATE_SET, followed by TypedArray.getFraction. The arrays come from platform state
IDs; fraction decoding shares TypedValue's complex representation, including base versus parent
base, missing-value defaults and invalid-type errors. TextUtils cursor offsets honor surrogate
pairs and ReplacementSpan boundaries through Java CharSequence/Spanned methods.

A subsequent fresh source-only session verified visible playback after that fix: two captures
show the same video advancing from pink lines to the hand completing a pink-and-teal pattern.
After using the app's Unmute and Replay controls, read-only CDP snapshots 2.003 seconds apart
recorded 1,429→1,481 presented frames, AudioTrack head 922,171→1,014,139 at 48 kHz, a running
AudioContext, gain 1 and queued PCM RMS 0.21435. This establishes changing video pixels and
nonzero scheduled audio with an advancing playback clock, not subjective headless audibility.
The temporary evidence is `/tmp/media-visual-a.png`, `/tmp/media-visual-b.png` and
`/tmp/media-playback-proof.json`.

Read-only navigation also reached History's explicit empty state, saved comments and a saved
post after switching tabs, and the Custom Feed picker. Create loaded the account's actual
communities; choosing a community with required body text kept Post disabled for a title alone
and enabled it after entering body text. The draft was explicitly discarded. No vote, comment,
post, subscription or account-setting change was submitted. The initial Saved population issue
was subsequently fixed below, followed by the startup Intent getter and final verification.


### Saved: queued attachment and themed tab colors

Saved initially measured and laid out its ViewPager before attachment. The real ViewPager
population method returned while getWindowToken was null; its later onAttachedToWindow reset
firstLayout, but another measurement never followed. An ordinary requestLayout populated the
saved posts. Read-only callback observations confirmed measure/layout and an empty draw before
attachment, then repeated empty draws without another measurement. The earlier hosted-display
invalidation fix refreshed drawing but could not restart this attachment-dependent population.

Queued attachment now marks newly attached descendants for measurement during the existing
linear traversal and requests layout once at the subtree root. It retains the hosted-display
invalidation and does not walk ancestors for each descendant. A regression verifies that a
child measured without attachment is measured again with identical specs after attachment, then
uses the measurement cache normally. Fresh source-only navigation populated Saved on its first
open, with actual post text and an image, without switching tabs or manually invalidating views.

The selected Posts label separately had color zero. Material TabLayout called
TypedArray.getColor on a selector whose color referred to a theme attribute; the old unthemed
selector fallback returned transparent. Reading the same value through getColorStateList
resolved the intended dark color. TypedArray.getColor now shares that theme-aware loader for
references, declares conditional suspension with maySuspend, and keeps literal/default reads
synchronous. A selector fixture checks distinct themes against real framework attribute IDs.
The full unit suite and typecheck passed; a fresh screenshot confirmed both visible selected
tab text and saved content (`/tmp/harness-saved-theme-fixed.png`).

The codec adapter still has two unobserved limitations: streams needing more than eight
submitted access units before any decoded output may require admission based on WebCodecs
decodeQueueSize rather than output callbacks, and midstream decoded format changes do not yet
produce revised output-format notifications. Neither occurred in the verified clip; no
speculative queue rewrite was included before final verification.

The apparent deep-link exception actually came from the first boot, before login. A debugger
breakpoint retained across reload captured `l0t` invoking Intent.getComponent. That zero-argument
getter had accidentally acquired resolveActivity's implementation and tried to call an undefined
PackageManager. Restoring the synchronous explicit-component-or-null getter fixes the source
error; the regression also checks setPackage alone, explicit class, cleared component and linked
ComponentName metadata. The later direct package-manager query was valid, so neither DEX
register handling nor package resolution needed a workaround.


### Reddit: final verification and baseline comparison

Verification completed on 2026-09-09 (report timestamp 2026-09-10 UTC), after commit `339de96`.
The authenticated standalone smoke passed all ten steps: feed, drawer/back, post, two comment
scrolls, comments, empty composer/back and post/back. It recorded no Java/page errors, native
faults, main-loop wedges, or layout/draw/GL errors. Its nine reached missing queries are optional
OEM/AppsFlyer reflection probes, ObjectStreamClass/MemberClasses and the absent captioning and
media_metrics services; they do not establish complete API coverage. Chromium's embedded DNS
WARNING remains in the raw logs and separate warning field. Credentials are redacted.

The smoke now uses a running wall clock, waits for the input connection before typing, and
observes completion of each swipe before continuing. The earlier failed login/composer attempts
were harness races, not grounds for app-specific runtime patches. Content latency and screenshot
latency are separate. Artifacts are in `tests/e2e/actual/reddit`; changing video frames and the
unmuted PCM/clock observations are preserved in `tests/e2e/actual/reddit-media`.

Full verification: typecheck passed; 924 unit tests passed with 26,646 assertions; all twelve
APKs compiled with zero method failures. Framework verification reported 295/363 declarations
(81%) and passed its executable checks; browser text comparison matched all six paragraphs.
The duplicate literal registration-name grep was empty, with no library-name suffix matching.
No visual goldens changed.

The final full E2E rendered all eight flows (111 steps). Content differences below compare
against the unchanged device goldens, not against the starting commit's images:

| Flow | Starting `fcc3d0c` | Final | Rendered |
|---|---:|---:|---:|
| FitNotes | 40.88% | 40.88% | 39/39 |
| Mihon onboarding | 17.56% | 17.56% | 5/5 |
| Mihon app | 60.85% | 59.51% | 17/17 |
| Harmonic | 33.08% | 31.84% | 14/14 |

Both full captures reproduce FitNotes' one destroyed-FragmentManager exception and Lichess'
missing PhantomReference failure. Lichess stays on its initial Flutter screen: its 15 rendered
steps do not prove a game was played. Harmonic's content is live. No final step reported a native
requirement/fault, main-loop wedge, layout error or draw error. Flappy Bird rendered seven steps,
Calculator eight, and Doodle Jump six; Doodle's active play measured roughly 40–43 fps.

Doodle's Back step exposed an existing queued AudioTrack notification race (one baseline error,
23 in the earlier current run). The timer checked its listener before enqueueing but read it
again after release cleared it. AOSP retains the original listener for queued messages. Capturing
that listener and setting playback state to stopped on release removes the null receiver without
cancelling already queued events. A regression holds the real main queue across listener
replacement/release; the final full Doodle flow has no errors or missing APIs.

An earlier current Mihon run scored 79.55% after a 45-pixel scroll offset moved the recorded
fallback tap above the rotation row, cascading into wrong screens. Two bounded repeats on each
revision opened the dialog, as did the final full run. All observed swipes completed about
3.4 seconds before capture; a generic gesture-acknowledgement change was therefore rejected.
This shows intermittent scroll/fallback sensitivity, not a measured change in its probability.
The baseline and current timings and screenshots remain under `/tmp/mihon-gesture-*` and
`/tmp/mihon-{baseline,current}-*`.

The boot-only corpus rendered frames for 11/12 APKs on both revisions. TikTok failed before a
frame with the same executor queue/Keva gaps; ChatGPT reached the same missing device configuration
API, and Resy the same AppOps/Koin failures. These are existing breadth limits, not successful
application flows. Per-step performance rollups preserve work/render counts alongside costs;
full-flow elapsed times remained within roughly 2% of baseline, but this includes settling and
capture and is not an isolated CPU benchmark. The rollup script does not parse the standalone
Reddit schema, so its zero Reddit row is not a performance measurement.

The report is `tests/e2e/report/index.html`, with per-step telemetry under `tests/e2e/actual`.
The baseline archive, corpus JSONs and command logs remain in `/tmp/webdroid-*`. Push notification
delivery, every media variant, and submitted votes/posts/replies remain unverified; no external
content or account-setting mutations were submitted. The reached Reddit handoff flows, stock
Chrome code-pressure problem, valid post timing and real video/audio path are verified above.
