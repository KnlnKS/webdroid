// WindowManagerService and its Session, for AOSP's ViewRootImpl: windows on the one display, their
// frames (computed by AOSP's own WindowLayout, as the server's DisplayPolicy does), the insets the
// device's bars give, a surface per window on the display's layer tree, and an input channel each.
import { rt, JObj, noops, stubs, declaredField } from "../../jvm/runtime";
import { newObj, vcall, scall } from "../../jvm/natives/jlang";
import { hostStub } from "../binder";
import { device } from "../../shell/config";
import { uptimeMillis } from "../../guest-clock";
import { type Layer, displayLayer, removeLayer, javaSurfaceControl, scheduleComposite } from "../surfaceflinger";
import { type Channel, channelOf, sendFocus, publish } from "../inputchannel";
import { javaConfiguration } from "../resources";
import { deviceConfiguration } from "../resnative";

const VISIBLE = 0;
const ADD_OKAY = 0, ADD_FLAG_IN_TOUCH_MODE = 1, ADD_FLAG_APP_VISIBLE = 2;
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
  layer: Layer;
  frame = { left: 0, top: 0, right: 0, bottom: 0 };
  channel: Channel | null = null;
  visibility = 8;
  requestedVisibleTypes = 0;
  backCallback: JObj | null = null;
  javaSurface: JObj | null = null;
  dim: Layer | null = null;
  requested = { width: -1, height: -1 };
  constructor(readonly client: JObj, readonly attrs: JObj, readonly parent: WindowState | null, name: string, type: number, z: number) {
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
const field = (name: string) => declaredField(LP, name);
const lp = <T>(attrs: JObj, name: string) => (attrs as unknown as Record<string, T>)[field(name)];

const rect = (l: number, t: number, r: number, b: number) => newObj("android/graphics/Rect", "(IIII)V", l, t, r, b);
const displayRect = () => rect(0, 0, device.width, device.height);
const insetsType = async (name: string): Promise<number> => scall("android/view/WindowInsets$Type", name, "()I");

/** the display's insets: the status bar (when the profile has one) and the gesture navigation bar */
async function insetsState(): Promise<JObj> {
  const state = await newObj("android/view/InsetsState", "()V");
  await vcall(state, "setDisplayFrame", "(Landroid/graphics/Rect;)V", await displayRect());
  const { width: w, height: h, statusBar, navBar } = device;
  const add = async (index: number, type: number, l: number, t: number, r: number, b: number, visible = true) => {
    const id = await scall("android/view/InsetsSource", "createId", "(Ljava/lang/Object;II)I", null, index, type);
    const source = await newObj("android/view/InsetsSource", "(II)V", id, type);
    await vcall(source, "setFrame", "(IIII)Landroid/view/InsetsSource;", l, t, r, b);
    await vcall(source, "setVisible", "(Z)Landroid/view/InsetsSource;", +visible);
    await vcall(state, "addSource", "(Landroid/view/InsetsSource;)V", source);
  };
  if (statusBar) await add(0, await insetsType("statusBars"), 0, 0, w, statusBar);
  if (navBar) {
    await add(0, await insetsType("navigationBars"), 0, h - navBar, w, h);
    await add(1, await insetsType("mandatorySystemGestures"), 0, h - navBar, w, h);
  }
  // the input method's window: the browser keyboard, which the page lays out outside the display
  await add(0, await insetsType("ime"), 0, h, w, h, imeShown);
  return state;
}
let imeShown = false;
/** the input method window shows or hides: every window hears the new state */
export async function setImeShown(shown: boolean): Promise<void> {
  if (imeShown === shown) return;
  imeShown = shown;
  const state = await insetsState(), controls = await newObj("android/view/InsetsSourceControl$Array", "()V");
  for (const ws of windows.values()) await vcall(ws.client, "insetsControlChanged", "(Landroid/view/InsetsState;Landroid/view/InsetsSourceControl$Array;)V", state, controls);
}

/** the device's configuration, and a full-screen task's override of it: what activities and
 *  windows are laid out against */
export async function configurations(): Promise<{ global: JObj; override: JObj }> {
  const global = await javaConfiguration(deviceConfiguration()) as JObj;
  const override = await newObj("android/content/res/Configuration", "(Landroid/content/res/Configuration;)V", global);
  const windowConfig = (override as unknown as Record<string, JObj>)[declaredField("android/content/res/Configuration", "windowConfiguration")];
  await vcall(windowConfig, "setActivityType", "(I)V", ACTIVITY_TYPE_STANDARD);
  return { global, override };
}
async function mergedConfiguration(out: JObj): Promise<void> {
  const { global, override } = await configurations();
  await vcall(out, "setConfiguration", "(Landroid/content/res/Configuration;Landroid/content/res/Configuration;)V", global, override);
}

async function addWindow(window: JObj, attrs: JObj, visibility: number, outChannel: JObj | null, outState: JObj | null, outFrame: JObj | null, outScale: Float32Array | null): Promise<number> {
  const copy = await newObj(LP, "()V");
  await vcall(copy, "copyFrom", `(L${LP};)I`, attrs);
  const type = lp<number>(attrs, "type"), token = lp<JObj | null>(attrs, "token");
  const parent = isSubWindow(type) && token ? windows.get(token) ?? null : null;
  const title = String(await vcall(attrs, "getTitle", "()Ljava/lang/CharSequence;") ?? "");
  const ws = new WindowState(window, copy, parent, title, type, windowZ(type, token, ++seq));
  ws.visibility = visibility;
  ws.requestedVisibleTypes = await insetsType("defaultVisible");
  windows.set(window, ws);
  if (outChannel) {
    const pair: JObj[] = await scall("android/view/InputChannel", "openInputChannelPair", "(Ljava/lang/String;)[Landroid/view/InputChannel;", title);
    ws.channel = channelOf(pair[0]);
    await vcall(pair[1], "copyTo", "(Landroid/view/InputChannel;)V", outChannel);
  }
  // after the channel exists, which the focus event travels on
  updateFocus();
  if (outState) await vcall(outState, "set", "(Landroid/view/InsetsState;)V", await insetsState());
  if (outFrame) await vcall(outFrame, "set", "(IIII)V", 0, 0, -1, -1);
  if (outScale) outScale[0] = 1;
  return ADD_OKAY | ADD_FLAG_IN_TOUCH_MODE | ADD_FLAG_APP_VISIBLE;
}

async function relayout(window: JObj, attrs: JObj | null, width: number, height: number, visibility: number, result: Record<string, JObj>): Promise<number> {
  const ws = windows.get(window);
  if (!ws) return 0;
  if (attrs) await vcall(ws.attrs, "copyFrom", `(L${LP};)I`, attrs);
  const R = (name: string) => result[declaredField("android/view/WindowRelayoutResult", name)];
  const state = await insetsState();
  ws.requested = { width, height };
  await computeFrames(ws, state, R("frames"));
  await mergedConfiguration(R("mergedConfiguration"));
  await vcall(R("insetsState"), "set", "(Landroid/view/InsetsState;)V", state);
  const frame = (R("frames") as unknown as Record<string, Record<string, number>>)[declaredField("android/window/ClientWindowFrames", "frame")];
  let res = 0;
  const firstTime = ws.visibility !== VISIBLE && visibility === VISIBLE;
  ws.visibility = visibility;
  if (visibility === VISIBLE) {
    if (!ws.javaSurface) { ws.javaSurface = await javaSurfaceControl(ws.layer, ws.layer.name); res |= RELAYOUT_RES_SURFACE_CHANGED; }
    await vcall(R("surfaceControl"), "copyFrom", "(Landroid/view/SurfaceControl;Ljava/lang/String;)V", ws.javaSurface, "relayout");
    // the surface extends past the frame by its insets (room for a shadow)
    const insets = lp<Record<string, number>>(ws.attrs, "surfaceInsets");
    ws.layer.x = frame.left - insets.left - (ws.parent?.layer.x ?? 0);
    ws.layer.y = frame.top - insets.top - (ws.parent?.layer.y ?? 0);
  } else {
    await vcall(R("surfaceControl"), "release", "()V");
  }
  ws.frame = { left: frame.left, top: frame.top, right: frame.right, bottom: frame.bottom };
  ws.layer.hidden = visibility !== VISIBLE;
  updateDim(ws);
  scheduleComposite();
  updateFocus();
  return res | (firstTime ? RELAYOUT_RES_FIRST_TIME : 0);
}

/** WindowLayout's frames for a window at the size it last asked for */
async function computeFrames(ws: WindowState, state: JObj, out: JObj): Promise<void> {
  const display = await displayRect();
  await vcall(await newObj("android/view/WindowLayout", "()V"), "computeFrames",
    `(L${LP};Landroid/view/InsetsState;Landroid/graphics/Rect;Landroid/graphics/Rect;IIIIFLandroid/window/ClientWindowFrames;)V`,
    ws.attrs, state, display, display, WINDOWING_MODE_FULLSCREEN, ws.requested.width, ws.requested.height, ws.requestedVisibleTypes, 1, out);
}
/** WindowState.reportResized after the display or configuration changed: each window's new frames,
 *  configuration and insets, its next traversal forced to relayout */
export async function resizeWindows(): Promise<void> {
  const state = await insetsState();
  for (const ws of [...windows.values()]) {
    const frames = await newObj("android/window/ClientWindowFrames", "()V"), merged = await newObj("android/util/MergedConfiguration", "()V");
    await computeFrames(ws, state, frames);
    await mergedConfiguration(merged);
    await vcall(ws.client, "resized", "(Landroid/window/ClientWindowFrames;ZLandroid/util/MergedConfiguration;Landroid/view/InsetsState;ZZIIZLandroid/window/ActivityWindowInfo;)V",
      frames, 0, merged, state, 1, 0, 0, 0, 0, null);
  }
}

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
function updateFocus(): void {
  const next = topFirst().find((ws) => !(flags(ws) & FLAG_NOT_FOCUSABLE)) ?? null;
  if (next === focused) return;
  if (focused?.channel) sendFocus(focused.channel, false);
  focused = next;
  if (next?.channel) sendFocus(next.channel, true);
}
let touchTarget: WindowState | null = null;
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
const ACTION_DOWN = 0, ACTION_UP = 1, ACTION_CANCEL = 3, SOURCE_TOUCHSCREEN = 0x1002, SOURCE_KEYBOARD = 0x101;
/** the display Z of a ViewRootImpl's window (its IWindow), or -Infinity when not added */
export function windowZOf(client: JObj): number {
  const ws = windows.get(client);
  // a sub-window's Z is relative to its parent's, and within the steps between its parent's siblings
  return !ws ? -Infinity : ws.parent ? ws.parent.layer.z + ws.layer.z / 10 : ws.layer.z;
}
/** a key from the virtual keyboard (device -1) to the focused window: DOWN, then UP */
export async function dispatchKey(keyCode: number): Promise<void> {
  const ws = focused;
  if (!ws?.channel) return;
  const down = BigInt(Math.floor(uptimeMillis()));
  for (const action of [ACTION_DOWN, ACTION_UP]) {
    const now = action === ACTION_DOWN ? down : BigInt(Math.floor(uptimeMillis()));
    const event = await newObj("android/view/KeyEvent", "(JJIIIIIIII)V", down, now, action, keyCode, 0, 0, -1, 0, 0x8, SOURCE_KEYBOARD);
    await publish(ws.channel, event);
  }
}
/** a touchscreen event at display (x, y): the window touched at DOWN gets the gesture, in its own
 *  coordinates. Resolves whether it handled the event. */
export async function dispatchTouch(action: number, x: number, y: number, downTime: bigint, eventTime: bigint): Promise<boolean> {
  if (action === ACTION_DOWN) touchTarget = touchedWindow(x, y);
  const ws = touchTarget;
  if (action === ACTION_UP || action === ACTION_CANCEL) touchTarget = null;
  if (!ws?.channel) return false;
  const event = await scall("android/view/MotionEvent", "obtain", "(JJIFFI)Landroid/view/MotionEvent;", downTime, eventTime, action, x, y, 0);
  await vcall(event, "setSource", "(I)V", SOURCE_TOUCHSCREEN);
  await vcall(event, "offsetLocation", "(FF)V", -ws.frame.left, -ws.frame.top);
  return publish(ws.channel, event);
}

const SESSION = "Landroid/view/IWindow;";
rt.register({ name: "webdroid/WindowSession", ctor: class extends JObj {}, sup: "android/view/IWindowSession$Stub", methods: {
  [`addToDisplayAsUser(${SESSION}L${LP};IIIILandroid/view/InputChannel;Landroid/view/InsetsState;Landroid/view/InsetsSourceControl$Array;Landroid/graphics/Rect;[F)I`]:
    (window: JObj, attrs: JObj, visibility: number, _display: number, _user: number, _types: number, channel: JObj | null, state: JObj | null, _controls: JObj, frame: JObj | null, scale: Float32Array | null) =>
      addWindow(window, attrs, visibility, channel, state, frame, scale),
  [`addToDisplay(${SESSION}L${LP};IIILandroid/view/InputChannel;Landroid/view/InsetsState;Landroid/view/InsetsSourceControl$Array;Landroid/graphics/Rect;[F)I`]:
    (window: JObj, attrs: JObj, visibility: number, _display: number, _types: number, channel: JObj | null, state: JObj | null, _controls: JObj, frame: JObj | null, scale: Float32Array | null) =>
      addWindow(window, attrs, visibility, channel, state, frame, scale),
  [`addToDisplayWithoutInputChannel(${SESSION}L${LP};IILandroid/view/InsetsState;Landroid/graphics/Rect;[F)I`]:
    (window: JObj, attrs: JObj, visibility: number, _display: number, state: JObj | null, frame: JObj | null, scale: Float32Array | null) =>
      addWindow(window, attrs, visibility, null, state, frame, scale),
  [`relayout(${SESSION}L${LP};IIIIIILandroid/view/WindowRelayoutResult;)I`]:
    (window: JObj, attrs: JObj | null, w: number, h: number, visibility: number, _flags: number, _seq: number, _sync: number, result: Record<string, JObj>) =>
      relayout(window, attrs, w, h, visibility, result),
  [`relayoutAsync(${SESSION}L${LP};IIIIII)V`]: async (window: JObj, attrs: JObj | null, w: number, h: number, visibility: number) => {
    const result = await newObj("android/view/WindowRelayoutResult", "()V");
    await relayout(window, attrs, w, h, visibility, result);
  },
  [`finishDrawing(${SESSION}Landroid/view/SurfaceControl$Transaction;I)V`]: async (window: JObj, transaction: JObj | null) => {
    if (transaction) await vcall(transaction, "apply", "()V");
    scheduleComposite();
  },
  "remove(Landroid/os/IBinder;)V": removeWindow,
  [`updateRequestedVisibleTypes(${SESSION}I)V`]: (window: JObj, types: number) => { const ws = windows.get(window); if (ws) ws.requestedVisibleTypes = types; },
  [`setOnBackInvokedCallbackInfo(${SESSION}Landroid/window/OnBackInvokedCallbackInfo;)V`]: (window: JObj, info: JObj | null) => {
    const ws = windows.get(window); if (ws) ws.backCallback = info;
  },
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

rt.register({ name: "webdroid/WindowManager", ctor: class extends JObj {}, sup: "android/view/IWindowManager$Stub", methods: {
  "openSession(Landroid/view/IWindowSessionCallback;)Landroid/view/IWindowSession;": () => newObj("webdroid/WindowSession"),
  "getCurrentAnimatorScale()F": () => 1,
  "getWindowInsets(ILandroid/os/IBinder;Landroid/view/InsetsState;)Z": async (_display: number, _token: JObj, out: JObj) => {
    await vcall(out, "set", "(Landroid/view/InsetsState;)V", await insetsState()); return 0;
  },
  "hasNavigationBar(I)Z": () => +(device.navBar > 0),
  "getDefaultDisplayRotation()I": () => device.width > device.height ? 1 : 0,
  "watchRotation(Landroid/view/IRotationWatcher;I)I": () => device.width > device.height ? 1 : 0,
  "removeRotationWatcher(Landroid/view/IRotationWatcher;)V": () => {},
  "isInTouchMode(I)Z": () => 1,
  // the keyguard is never shown and has no secure lock, as on the reference AVD, so an exit succeeds at once
  ...stubs(0, "isKeyguardLocked()Z", "isKeyguardSecure(I)Z"),
  ...noops("addKeyguardLockedStateListener(Lcom/android/internal/policy/IKeyguardLockedStateListener;)V",
    "removeKeyguardLockedStateListener(Lcom/android/internal/policy/IKeyguardLockedStateListener;)V"),
  "exitKeyguardSecurely(Landroid/view/IOnKeyguardExitResult;)V": (callback: unknown) => vcall(callback, "onKeyguardExitResult", "(Z)V", 1),
  "getInitialDisplaySize(ILandroid/graphics/Point;)V": (_d: number, p: Record<string, number>) => { p.x = device.width; p.y = device.height; },
  "getBaseDisplaySize(ILandroid/graphics/Point;)V": (_d: number, p: Record<string, number>) => { p.x = device.width; p.y = device.height; },
  "getInitialDisplayDensity(I)I": () => device.densityDpi,
  "getBaseDisplayDensity(I)I": () => device.densityDpi,
  // the compositor draws no blur behind or across windows, so cross-window blur is never enabled
  "registerCrossWindowBlurEnabledListener(Landroid/view/ICrossWindowBlurEnabledListener;)Z": () => 0,
  "unregisterCrossWindowBlurEnabledListener(Landroid/view/ICrossWindowBlurEnabledListener;)V": () => {},
  // a WindowContext's windows go on the one display, under its configuration
  ...Object.fromEntries([`attachWindowContextToDisplayArea(Landroid/app/IApplicationThread;Landroid/os/IBinder;IILandroid/os/Bundle;)`,
    `attachWindowContextToDisplayContent(Landroid/app/IApplicationThread;Landroid/os/IBinder;I)`].map((sig) =>
    [sig + "Landroid/window/WindowContextInfo;", async () => newObj("android/window/WindowContextInfo", "(Landroid/content/res/Configuration;I)V", (await configurations()).global, 0)])),
  "detachWindowContext(Landroid/os/IBinder;)V": () => {},
  // nothing records the screen
  "registerScreenRecordingCallback(Landroid/window/IScreenRecordingCallback;)Z": () => 0,
  "unregisterScreenRecordingCallback(Landroid/window/IScreenRecordingCallback;)V": () => {},
} });

/** WindowManagerGlobal's IWindowManager, for an app whose windows AOSP's ViewRootImpl manages */
export function hostWindowManager(): void { hostStub("window", "webdroid/WindowManager"); }
