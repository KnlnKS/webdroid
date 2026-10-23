// WindowManagerService and its Session, for AOSP's ViewRootImpl: windows on the one display, their
// frames (computed by AOSP's own WindowLayout, as the server's DisplayPolicy does), the insets the
// device's bars give, a surface per window on the display's layer tree, and an input channel each.
import { awaited, rt, JObj, noops, stubs, getDeclared, driven, declaredField, waits, type Gen } from "../../jvm/runtime.ts";
import { jarray } from "../../jvm/abi.ts";
import { after, callOn, newObj, vcall, scall, staticField, JThread } from "../../jvm/natives/jentry.ts";
import { csText } from "../../jvm/natives/jchars.ts";
import { hostService } from "../binder.ts";
import { device } from "../../shell/config.ts";
import { uptimeMillis } from "../../guest-clock.ts";
import { type Layer, displayLayer, removeLayer, javaSurfaceControl, scheduleComposite } from "../surfaceflinger.ts";
import { type Channel, channelOf, sendFocus, publish } from "../inputchannel.ts";
import { javaConfiguration, systemResource } from "../configuration.ts";
import { edges } from "../graphics.ts";
import { TOUCHSCREEN, TOUCH_SOURCE, VIRTUAL_KEYBOARD, touchPrecision } from "../inputdevices.ts";
import { ACTION_CANCEL, ACTION_DOWN, ACTION_MOVE, ACTION_UP, KEY_ACTION_DOWN, KEY_ACTION_UP, KEY_FLAG_FROM_SYSTEM, SOURCE_KEYBOARD } from "../input-codes.ts";
import type { TouchPointer } from "../../shell/pointer-queue.ts";

const VISIBLE = 0;
const ADD_OKAY = 0, ADD_FLAG_IN_TOUCH_MODE = 1, ADD_FLAG_APP_VISIBLE = 2;
let touchMode = true;
const RELAYOUT_RES_FIRST_TIME = 1, RELAYOUT_RES_SURFACE_CHANGED = 2;
const WINDOWING_MODE_FULLSCREEN = 1, ACTIVITY_TYPE_STANDARD = 1;

/** WindowManagerPolicy.getWindowLayerFromTypeLw: the display's band for a window type */
function windowLayer(type: number): number {
  if (type >= 1 && type <= 99) return 2;
  switch (type) {
    case 2013: return 1;                         // wallpaper
    case 2002: return 3;                         // phone
    case 2001: return 4;                         // search bar
    case 2003: return 9;                         // system alert
    case 2038: return 12;                        // application overlay
    case 2005: return 8;                         // toast
    case 2011: return 15;                        // input method
    case 2012: return 16;                        // input method dialog
    case 2000: return 17;                        // status bar
    default: return 2;
  }
}
/** ActivityRecord.isFirstChildWindowGreaterThanSecond: an activity's windows stack by its token, and
 *  within it the base application window sits below the rest, a starting window above them, the
 *  others in the order they were added (a dialog shown in onCreate is added before its activity's
 *  window, at resume) */
const TYPE_BASE_APPLICATION = 1, TYPE_APPLICATION_STARTING = 3;
const tokenOrder = new WeakMap<JObj, number>();
let tokens = 0;
function windowZ(type: number, token: JObj | null, seq: number): number {
  const band = windowLayer(type) * 1e9;
  if (type > 99 || !token) return band + seq;
  let order = tokenOrder.get(token);
  if (order === undefined) tokenOrder.set(token, order = ++tokens);
  return band + order * 1000 + (type === TYPE_BASE_APPLICATION ? 0 : type === TYPE_APPLICATION_STARTING ? 999 : 1 + seq % 998);
}
/** WindowManagerPolicy.getSubWindowLayerFromTypeLw: a sub-window against its parent */
const SUB_LAYERS: Record<number, number> = { 1000: 1, 1001: -2, 1002: 2, 1003: 1, 1004: -1, 1005: 3 };
const isSubWindow = (type: number) => type >= 1000 && type <= 1999;

class WindowState {
  readonly client: JObj; readonly attrs: JObj; readonly parent: WindowState | null;
  layer: Layer;
  frame = { left: 0, top: 0, right: 0, bottom: 0 };
  channel: Channel | null = null;
  visibility = 8;
  requestedVisibleTypes = 0;
  javaSurface: JObj | null = null;
  dim: Layer | null = null;
  requested = { width: -1, height: -1 };
  constructor(client: JObj, attrs: JObj, parent: WindowState | null, name: string, type: number, z: number) {
    this.client = client; this.attrs = attrs; this.parent = parent;
    if (parent) {
      this.layer = displayLayer(name, 0);
      this.layer.layerStack = -1;
      this.layer.reparent(parent.layer);
      this.layer.z = SUB_LAYERS[type] ?? 1;
    } else this.layer = displayLayer(name, z);
  }
}
const windows = new Map<JObj, WindowState>();
let seq = 0;
const LP = "android/view/WindowManager$LayoutParams";
const lp = <T>(attrs: JObj, name: string) => getDeclared<T>(attrs, LP, name);

const rect = (l: number, t: number, r: number, b: number) => newObj("android/graphics/Rect", "(IIII)V", l, t, r, b);
const displayRect = () => rect(0, 0, device.width, device.height);
const insetsType = (name: string): number | Promise<number> => scall("android/view/WindowInsets$Type", name, "()I");

/** SystemUI's NavigationBar: its bar suppresses the scrim behind it unless config_navBarNeedsScrim asks for one */
let navBarFlags: number | undefined;
/** the display's insets: the status bar (when the profile has one) and the gesture navigation bar */
function* insetsState(): Gen<JObj> {
  const state = yield newObj("android/view/InsetsState", "()V");
  yield vcall(state, "setDisplayFrame", "(Landroid/graphics/Rect;)V", yield displayRect());
  const { width: w, height: h, statusBar, navBar } = device;
  const add = function* (index: number, type: number, l: number, t: number, r: number, b: number, visible = true): Gen<JObj> {
    const id = yield scall("android/view/InsetsSource", "createId", "(Ljava/lang/Object;II)I", null, index, type);
    const source = yield newObj("android/view/InsetsSource", "(II)V", id, type);
    yield vcall(source, "setFrame", "(IIII)Landroid/view/InsetsSource;", l, t, r, b);
    yield vcall(source, "setVisible", "(Z)Landroid/view/InsetsSource;", +visible);
    yield vcall(state, "addSource", "(Landroid/view/InsetsSource;)V", source);
    return source;
  };
  if (statusBar) yield* add(0, yield* awaited(insetsType("statusBars")), 0, 0, w, statusBar);
  if (navBar) {
    navBarFlags ??= (yield systemResource("bool", "config_navBarNeedsScrim", "getBoolean", "(I)Z")) ? 0 : yield staticField("android/view/InsetsSource", "FLAG_SUPPRESS_SCRIM");
    const bar = yield* add(0, yield* awaited(insetsType("navigationBars")), 0, h - navBar, w, h);
    if (navBarFlags) yield vcall(bar, "setFlags", "(I)Landroid/view/InsetsSource;", navBarFlags);
    yield* add(1, yield* awaited(insetsType("mandatorySystemGestures")), 0, h - navBar, w, h);
  }
  // the input method's window: the browser keyboard, which the page lays out outside the display
  yield* add(0, yield* awaited(insetsType("ime")), 0, h, w, h, imeShown);
  return state;
}
let imeShown = false;
/** the input method window shows or hides: every window hears the new state */
export const setImeShown = driven(function* (shown: boolean): Gen<void> {
  if (imeShown === shown) return;
  imeShown = shown;
  const state = yield* insetsState(), controls = yield newObj("android/view/InsetsSourceControl$Array", "()V");
  for (const ws of windows.values()) yield vcall(ws.client, "insetsControlChanged", "(Landroid/view/InsetsState;Landroid/view/InsetsSourceControl$Array;)V", state, controls);
});

/** the device's configuration, and a full-screen task's override of it: what activities and
 *  windows are laid out against */
export const configurations = driven(function* (): Gen<{ global: JObj; override: JObj }> {
  const global = yield* awaited(javaConfiguration());
  const override = yield newObj("android/content/res/Configuration", "(Landroid/content/res/Configuration;)V", global);
  const windowConfig = getDeclared<JObj>(override, "android/content/res/Configuration", "windowConfiguration");
  yield vcall(windowConfig, "setActivityType", "(I)V", ACTIVITY_TYPE_STANDARD);
  return { global, override };
});
function* mergedConfiguration(out: JObj): Gen<void> {
  const { global, override } = yield* awaited(configurations());
  yield vcall(out, "setConfiguration", "(Landroid/content/res/Configuration;Landroid/content/res/Configuration;)V", global, override);
}

/** ActivityRecord.mClientVisible: the activity tokens whose windows the server has hidden */
const hiddenTokens = new WeakSet<JObj>();
/** the activity token a window belongs to: its own, or for a sub-window its parent's */
const appToken = (ws: WindowState): JObj | null => lp<JObj | null>((ws.parent ?? ws).attrs, "token");
/** ActivityRecord.setClientVisible: every window of the activity, its dialogs and their sub-windows
 *  among them, hears that the app is shown or hidden, and lays itself out visible or gone */
export function* setClientVisible(token: JObj, visible: boolean): Gen<void> {
  if (hiddenTokens.has(token) !== visible) return;
  if (visible) hiddenTokens.delete(token); else hiddenTokens.add(token);
  for (const ws of [...windows.values()]) if (appToken(ws) === token) yield vcall(ws.client, "dispatchAppVisibility", "(Z)V", +visible);
}

function* addWindow(window: JObj, attrs: JObj, visibility: number, outChannel: JObj | null, outState: JObj | null, outFrame: JObj | null, outScale: Float32Array | null): Gen<number> {
  const copy = yield newObj(LP, "()V");
  yield vcall(copy, "copyFrom", `(L${LP};)I`, attrs);
  const type = lp<number>(attrs, "type"), token = lp<JObj | null>(attrs, "token");
  const parent = isSubWindow(type) && token ? windows.get(token) ?? null : null;
  const title = yield* awaited(csText(yield vcall(attrs, "getTitle", "()Ljava/lang/CharSequence;")));
  const ws = new WindowState(window, copy, parent, title, type, windowZ(type, token, ++seq));
  ws.visibility = visibility;
  ws.requestedVisibleTypes = yield* awaited(insetsType("defaultVisible"));
  windows.set(window, ws);
  if (outChannel) {
    const pair: JObj[] = yield scall("android/view/InputChannel", "openInputChannelPair", "(Ljava/lang/String;)[Landroid/view/InputChannel;", title);
    ws.channel = channelOf(pair[0]);
    yield vcall(pair[1], "copyTo", "(Landroid/view/InputChannel;)V", outChannel);
  }
  // after the channel exists, which the focus event travels on
  updateFocus();
  if (outState) yield vcall(outState, "set", "(Landroid/view/InsetsState;)V", yield* insetsState());
  if (outFrame) yield vcall(outFrame, "set", "(IIII)V", 0, 0, -1, -1);
  if (outScale) outScale[0] = 1;
  const app = appToken(ws);
  return ADD_OKAY | (touchMode ? ADD_FLAG_IN_TOUCH_MODE : 0) | (app && hiddenTokens.has(app) ? 0 : ADD_FLAG_APP_VISIBLE);
}

function* relayout(window: JObj, attrs: JObj | null, width: number, height: number, visibility: number, result: JObj): Gen<number> {
  const ws = windows.get(window);
  if (!ws) return 0;
  if (attrs) yield vcall(ws.attrs, "copyFrom", `(L${LP};)I`, attrs);
  const R = (name: string) => getDeclared<JObj>(result, "android/view/WindowRelayoutResult", name);
  const state = yield* insetsState();
  ws.requested = { width, height };
  yield* computeFrames(ws, state, R("frames"));
  yield* mergedConfiguration(R("mergedConfiguration"));
  yield vcall(R("insetsState"), "set", "(Landroid/view/InsetsState;)V", state);
  const frame = edges(getDeclared<JObj>(R("frames"), "android/window/ClientWindowFrames", "frame"));
  let res = 0;
  const firstTime = ws.visibility !== VISIBLE && visibility === VISIBLE;
  ws.visibility = visibility;
  if (visibility === VISIBLE) {
    if (!ws.javaSurface) { ws.javaSurface = yield* awaited(javaSurfaceControl(ws.layer, ws.layer.name)); res |= RELAYOUT_RES_SURFACE_CHANGED; }
    yield vcall(R("surfaceControl"), "copyFrom", "(Landroid/view/SurfaceControl;Ljava/lang/String;)V", ws.javaSurface, "relayout");
    // the surface extends past the frame by its insets (room for a shadow)
    const insets = edges(lp<JObj>(ws.attrs, "surfaceInsets"));
    ws.layer.x = frame.left - insets.left - (ws.parent?.layer.x ?? 0);
    ws.layer.y = frame.top - insets.top - (ws.parent?.layer.y ?? 0);
  } else {
    yield vcall(R("surfaceControl"), "release", "()V");
  }
  ws.frame = frame;
  ws.layer.hidden = visibility !== VISIBLE;
  updateDim(ws);
  scheduleComposite();
  updateFocus();
  return res | (firstTime ? RELAYOUT_RES_FIRST_TIME : 0);
}

/** WindowLayout's frames for a window at the size it last asked for */
function* computeFrames(ws: WindowState, state: JObj, out: JObj): Gen<void> {
  const display = yield displayRect();
  yield vcall(yield newObj("android/view/WindowLayout", "()V"), "computeFrames",
    `(L${LP};Landroid/view/InsetsState;Landroid/graphics/Rect;Landroid/graphics/Rect;IIIIFLandroid/window/ClientWindowFrames;)V`,
    ws.attrs, state, display, display, WINDOWING_MODE_FULLSCREEN, ws.requested.width, ws.requested.height, ws.requestedVisibleTypes, 1, out);
}
/** WindowState.reportResized after the display or configuration changed: each window's new frames,
 *  configuration and insets, its next traversal forced to relayout */
export const resizeWindows = driven(function* (): Gen<void> {
  const state = yield* insetsState();
  for (const ws of [...windows.values()]) {
    const frames = yield newObj("android/window/ClientWindowFrames", "()V"), merged = yield newObj("android/util/MergedConfiguration", "()V");
    yield* computeFrames(ws, state, frames);
    yield* mergedConfiguration(merged);
    yield vcall(ws.client, "resized", "(Landroid/window/ClientWindowFrames;ZLandroid/util/MergedConfiguration;Landroid/view/InsetsState;ZZIIZLandroid/window/ActivityWindowInfo;)V",
      frames, 0, merged, state, 1, 0, 0, 0, 0, null);
  }
});

/** WindowState's dim layer: a black effect layer under a FLAG_DIM_BEHIND window, at its dimAmount */
function updateDim(ws: WindowState): void {
  const dim = !!(lp<number>(ws.attrs, "flags") & FLAG_DIM_BEHIND) && ws.visibility === VISIBLE && !ws.parent;
  if (!dim) { if (ws.dim) { removeLayer(ws.dim); ws.dim = null; } return; }
  ws.dim ??= displayLayer(ws.layer.name + " dim", ws.layer.z - 0.5);
  ws.dim.color = [0, 0, 0];
  ws.dim.alpha = lp<number>(ws.attrs, "dimAmount");
}
function removeWindow(window: JObj): void {
  const ws = windows.get(window);
  if (!ws) return;
  windows.delete(window);
  removeLayer(ws.layer);
  if (ws.dim) removeLayer(ws.dim);
  if (touchTarget === ws) touchTarget = null;
  updateFocus();
}

// ── input: InputDispatcher's focus and touch-target rules over the windows, top first
const FLAG_DIM_BEHIND = 0x2, FLAG_NOT_FOCUSABLE = 0x8, FLAG_NOT_TOUCHABLE = 0x10, FLAG_NOT_TOUCH_MODAL = 0x20;
const flags = (ws: WindowState) => lp<number>(ws.attrs, "flags");
/** visible windows, the topmost first: by display band and order added, a sub-window by its sublayer over its parent */
function topFirst(): WindowState[] {
  const key = (ws: WindowState): [number, number] => ws.parent ? [ws.parent.layer.z, ws.layer.z] : [ws.layer.z, 0];
  return [...windows.values()].filter((ws) => ws.visibility === VISIBLE && !ws.layer.removed)
    .sort((a, b) => { const [a0, a1] = key(a), [b0, b1] = key(b); return b0 - a0 || b1 - a1; });
}
let focused: WindowState | null = null;
const inputWatchers = new Set<() => void>();
/** Copied hit regions for the owning page; Java input channels stay in this realm. */
export function inputWindowRegions(): { left: number; top: number; right: number; bottom: number }[] {
  return topFirst().filter(ws => ws.channel && !(flags(ws) & FLAG_NOT_TOUCHABLE)).map(ws =>
    flags(ws) & (FLAG_NOT_TOUCH_MODAL | FLAG_NOT_FOCUSABLE) ? { ...ws.frame } : { left: 0, top: 0, right: device.width, bottom: device.height });
}
export function watchInputWindows(changed: () => void): () => void {
  inputWatchers.add(changed); changed();
  return () => { inputWatchers.delete(changed); };
}
export const hasFocusedWindow = (): boolean => !!focused?.channel;
export const hasTouchWindow = (x: number, y: number): boolean => !!touchedWindow(x, y)?.channel;
function updateFocus(): void {
  const next = topFirst().find((ws) => !(flags(ws) & FLAG_NOT_FOCUSABLE)) ?? null;
  if (next !== focused) {
    if (focused?.channel) sendFocus(focused.channel, false);
    focused = next;
    if (next?.channel) sendFocus(next.channel, true);
  }
  for (const changed of inputWatchers) changed();
}
/** the window the gesture went down on, and when */
let touchTarget: WindowState | null = null, touchDown = 0n;
function touchedWindow(x: number, y: number): WindowState | null {
  for (const ws of topFirst()) {
    const f = flags(ws);
    if (f & FLAG_NOT_TOUCHABLE) continue;
    const { left, top, right, bottom } = ws.frame;
    if (x >= left && x < right && y >= top && y < bottom) return ws;
    // a touch-modal window takes the touches outside it too
    if (!(f & (FLAG_NOT_TOUCH_MODAL | FLAG_NOT_FOCUSABLE))) return ws;
  }
  return null;
}
/** the display Z of a ViewRootImpl's window (its IWindow), or -Infinity when not shown */
export function windowZOf(client: JObj): number {
  const ws = windows.get(client);
  if (ws?.visibility !== VISIBLE) return -Infinity;
  // a sub-window's Z is relative to its parent's, and within the steps between its parent's siblings
  return ws.parent ? ws.parent.layer.z + ws.layer.z / 10 : ws.layer.z;
}
/** InputDispatcher's thread, on which host input becomes events */
const inputDispatcher = Object.assign(new JThread(), { jname: "InputDispatcher" });
const onInputThread = async <T>(work: Gen<T>): Promise<T> => callOn(inputDispatcher, () => rt.drive(work));
/** a key from the virtual keyboard to the focused window: DOWN, then UP */
export const dispatchKey = (keyCode: number): Promise<void> => onInputThread(function* (): Gen<void> {
  const ws = focused;
  if (!ws?.channel) return;
  const down = BigInt(Math.floor(uptimeMillis()));
  for (const action of [KEY_ACTION_DOWN, KEY_ACTION_UP]) {
    const now = action === KEY_ACTION_DOWN ? down : BigInt(Math.floor(uptimeMillis()));
    const event = yield newObj("android/view/KeyEvent", "(JJIIIIIIII)V", down, now, action, keyCode, 0, 0, VIRTUAL_KEYBOARD, 0, KEY_FLAG_FROM_SYSTEM, SOURCE_KEYBOARD);
    yield publish(ws.channel, event, true);
  }
}());
const PP = "android/view/MotionEvent$PointerProperties", PC = "android/view/MotionEvent$PointerCoords", TOOL_TYPE_FINGER = 1;
let pointerFields: Record<"id" | "toolType" | "x" | "y" | "pressure" | "size", string> | null = null;
type Pointers = { props: Record<string, number>[]; coords: Record<string, number>[] };
/** the PointerProperties and PointerCoords obtain copies, kept for the next event: an event built
 *  while another waits makes its own */
let spare: Pointers | null = null;
/** a touchscreen event with `pointers` at display coordinates, built as InputDispatcher delivers one:
 *  every pointer down, a finger each, in id order. The window touched at DOWN gets the whole
 *  gesture (a split touch across windows is not modeled), in its own coordinates. Resolves whether
 *  it handled the event. */
export const dispatchTouch = (action: number, pointers: readonly TouchPointer[], eventTime: bigint): Promise<boolean> => onInputThread(function* (): Gen<boolean> {
  const masked = action & 0xff;
  if (masked === ACTION_DOWN) { touchTarget = touchedWindow(pointers[0].x, pointers[0].y); touchDown = eventTime; }
  const ws = touchTarget, downTime = touchDown;
  if (masked === ACTION_UP || masked === ACTION_CANCEL) touchTarget = null;
  if (!ws?.channel) return false;
  const f = pointerFields ??= { id: declaredField(PP, "id"), toolType: declaredField(PP, "toolType"), x: declaredField(PC, "x"),
    y: declaredField(PC, "y"), pressure: declaredField(PC, "pressure"), size: declaredField(PC, "size") };
  const pool: Pointers = spare ?? { props: jarray([], `L${PP};`), coords: jarray([], `L${PC};`) };
  spare = null;
  while (pool.props.length < pointers.length) {
    const pp: Record<string, number> = yield newObj(PP), pc: Record<string, number> = yield newObj(PC);
    pp[f.toolType] = TOOL_TYPE_FINGER;
    // obtain(JJIFFI)'s pressure and size, which a single-pointer dispatch delivered before
    pc[f.pressure] = 1; pc[f.size] = 1;
    pool.props.push(pp); pool.coords.push(pc);
  }
  for (let i = 0; i < pointers.length; i++) {
    const { id, x, y } = pointers[i], pc = pool.coords[i];
    pool.props[i][f.id] = id; pc[f.x] = Math.fround(x); pc[f.y] = Math.fround(y);
  }
  const event = yield scall("android/view/MotionEvent", "obtain", `(JJII[L${PP};[L${PC};IIFFIIII)Landroid/view/MotionEvent;`, downTime, eventTime,
    action, pointers.length, pool.props, pool.coords, 0, 0, touchPrecision(device.width), touchPrecision(device.height), TOUCHSCREEN, 0, TOUCH_SOURCE, 0);
  spare = pool;
  yield vcall(event, "offsetLocation", "(FF)V", -ws.frame.left, -ws.frame.top);
  // a move streams at the display's rate and is no event to answer at once
  return yield* awaited(publish(ws.channel, event, masked !== ACTION_MOVE));
}());

const SESSION = "Landroid/view/IWindow;";
rt.register({ name: "webdroid/WindowSession", ctor: class extends JObj {}, sup: "android/view/IWindowSession$Stub", methods: {
  [`addToDisplayAsUser(${SESSION}L${LP};IIIILandroid/view/InputChannel;Landroid/view/InsetsState;Landroid/view/InsetsSourceControl$Array;Landroid/graphics/Rect;[F)I`]:
    waits((window: JObj, attrs: JObj, visibility: number, _display: number, _user: number, _types: number, channel: JObj | null, state: JObj | null, _controls: JObj, frame: JObj | null, scale: Float32Array | null) =>
      rt.drive(addWindow(window, attrs, visibility, channel, state, frame, scale))),
  [`addToDisplay(${SESSION}L${LP};IIILandroid/view/InputChannel;Landroid/view/InsetsState;Landroid/view/InsetsSourceControl$Array;Landroid/graphics/Rect;[F)I`]:
    waits((window: JObj, attrs: JObj, visibility: number, _display: number, _types: number, channel: JObj | null, state: JObj | null, _controls: JObj, frame: JObj | null, scale: Float32Array | null) =>
      rt.drive(addWindow(window, attrs, visibility, channel, state, frame, scale))),
  [`addToDisplayWithoutInputChannel(${SESSION}L${LP};IILandroid/view/InsetsState;Landroid/graphics/Rect;[F)I`]:
    waits((window: JObj, attrs: JObj, visibility: number, _display: number, state: JObj | null, frame: JObj | null, scale: Float32Array | null) =>
      rt.drive(addWindow(window, attrs, visibility, null, state, frame, scale))),
  [`relayout(${SESSION}L${LP};IIIIIILandroid/view/WindowRelayoutResult;)I`]:
    (window: JObj, attrs: JObj | null, w: number, h: number, visibility: number, _flags: number, _seq: number, _sync: number, result: JObj) =>
      rt.drive(relayout(window, attrs, w, h, visibility, result)),
  [`relayoutAsync(${SESSION}L${LP};IIIIII)V`]: driven(function* (window: JObj, attrs: JObj | null, w: number, h: number, visibility: number) {
    yield* relayout(window, attrs, w, h, visibility, yield newObj("android/view/WindowRelayoutResult"));
  }),
  [`finishDrawing(${SESSION}Landroid/view/SurfaceControl$Transaction;I)V`]: (_window: JObj, transaction: JObj | null) =>
    after(transaction && vcall(transaction, "apply", "()V"), scheduleComposite),
  "remove(Landroid/os/IBinder;)V": removeWindow,
  [`updateRequestedVisibleTypes(${SESSION}I)V`]: (window: JObj, types: number) => { const ws = windows.get(window); if (ws) ws.requestedVisibleTypes = types; },
  // back reaches the focused window as a key, which its ViewRootImpl hands its own callbacks
  [`setOnBackInvokedCallbackInfo(${SESSION}Landroid/window/OnBackInvokedCallbackInfo;)V`]: () => {},
  [`cancelDraw(${SESSION})Z`]: () => 0,
  [`outOfMemory(${SESSION})Z`]: () => 0,
  "performHapticFeedback(IZZ)Z": () => 0,
  ...noops(`setInsets(${SESSION}ILandroid/graphics/Rect;Landroid/graphics/Rect;Landroid/graphics/Region;)V`,
    `clearTouchableRegion(${SESSION})V`, "pokeDrawLock(Landroid/os/IBinder;)V", "performHapticFeedbackAsync(IZZ)V",
    "onRectangleOnScreenRequested(Landroid/os/IBinder;Landroid/graphics/Rect;)V",
    `reportSystemGestureExclusionChanged(${SESSION}Ljava/util/List;)V`, `reportKeepClearAreasChanged(${SESSION}Ljava/util/List;Ljava/util/List;)V`,
    `reportDecorViewGestureInterceptionChanged(${SESSION}Z)V`, `updateTapExcludeRegion(${SESSION}Landroid/graphics/Region;)V`),
  ...stubs(null, "getWindowId(Landroid/os/IBinder;)Landroid/view/IWindowId;"),
} });

// WindowManagerGlobal's IWindowManager, for an app whose windows AOSP's ViewRootImpl manages
hostService("window", "webdroid/WindowManager", "android/view/IWindowManager$Stub", {
  "openSession(Landroid/view/IWindowSessionCallback;)Landroid/view/IWindowSession;": () => newObj("webdroid/WindowSession"),
  "getCurrentAnimatorScale()F": () => 1,
  "getWindowInsets(ILandroid/os/IBinder;Landroid/view/InsetsState;)Z": driven(function* (_display: number, _token: JObj, out: JObj) {
    yield vcall(out, "set", "(Landroid/view/InsetsState;)V", yield* insetsState()); return 0;
  }),
  "hasNavigationBar(I)Z": () => +(device.navBar > 0),
  "getDefaultDisplayRotation()I": () => device.width > device.height ? 1 : 0,
  "watchRotation(Landroid/view/IRotationWatcher;I)I": () => device.width > device.height ? 1 : 0,
  "removeRotationWatcher(Landroid/view/IRotationWatcher;)V": () => {},
  // the one display's touch mode, which a window's ViewRootImpl leaves and re-enters with its input
  "isInTouchMode(I)Z": () => +touchMode,
  "setInTouchMode(ZI)V": (on: number) => { touchMode = !!on; },
  "setInTouchModeOnAllDisplays(Z)V": (on: number) => { touchMode = !!on; },
  // the keyguard is never shown and has no secure lock, as on the reference AVD, so an exit succeeds at once
  ...stubs(0, "isKeyguardLocked()Z", "isKeyguardSecure(I)Z"),
  ...noops("addKeyguardLockedStateListener(Lcom/android/internal/policy/IKeyguardLockedStateListener;)V",
    "removeKeyguardLockedStateListener(Lcom/android/internal/policy/IKeyguardLockedStateListener;)V"),
  "exitKeyguardSecurely(Landroid/view/IOnKeyguardExitResult;)V": (callback: unknown) => vcall(callback, "onKeyguardExitResult", "(Z)V", 1),
  "getInitialDisplaySize(ILandroid/graphics/Point;)V": (_d: number, p: object) => vcall(p, "set", "(II)V", device.width, device.height),
  "getBaseDisplaySize(ILandroid/graphics/Point;)V": (_d: number, p: object) => vcall(p, "set", "(II)V", device.width, device.height),
  "getInitialDisplayDensity(I)I": () => device.densityDpi,
  "getBaseDisplayDensity(I)I": () => device.densityDpi,
  // the compositor draws no blur behind or across windows, so cross-window blur is never enabled
  "registerCrossWindowBlurEnabledListener(Landroid/view/ICrossWindowBlurEnabledListener;)Z": () => 0,
  "unregisterCrossWindowBlurEnabledListener(Landroid/view/ICrossWindowBlurEnabledListener;)V": () => {},
  // a WindowContext's windows go on the one display, under its configuration
  ...Object.fromEntries([`attachWindowContextToDisplayArea(Landroid/app/IApplicationThread;Landroid/os/IBinder;IILandroid/os/Bundle;)`,
    `attachWindowContextToDisplayContent(Landroid/app/IApplicationThread;Landroid/os/IBinder;I)`].map((sig) =>
    [sig + "Landroid/window/WindowContextInfo;", () => after(configurations(), ({ global }) => newObj("android/window/WindowContextInfo", "(Landroid/content/res/Configuration;I)V", global, 0))])),
  "detachWindowContext(Landroid/os/IBinder;)V": () => {},
  // nothing records the screen
  "registerScreenRecordingCallback(Landroid/window/IScreenRecordingCallback;)Z": () => 0,
  "unregisterScreenRecordingCallback(Landroid/window/IScreenRecordingCallback;)V": () => {},
});
