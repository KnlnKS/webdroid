// android.view.KeyEvent, its DispatcherState, and the BACK key as a window's callback receives it.

import { rt, JObj, stubs, driven, type Gen } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { parcelCreator, type JParcel } from "./parcel";
import { keyCodes, deadChar } from "./keycodes";
import { uptimeMillis } from "./os";

export class JKeyEvent extends JObj {
  action = 0; keyCode = 0; tracking = false; canceled = false;
  downTime = 0n; eventTime = 0n; repeat = 0; meta = 0; deviceId = -1; scanCode = 0; flags = 0; source = 0x101;
}
export const KEYCODE_BACK = 4;
const M_dispatchKey = "(Landroid/view/KeyEvent;)Z";
const keySet = (names: string) => new Set(names.split(" ").map((name) => keyCodes.get(name)!));
// KeyEvent.isSystemKey, isModifierKey, isGamepadButton and isMediaSessionKey
const SYSTEM_KEYS = keySet("MENU SOFT_RIGHT HOME BACK CALL ENDCALL VOLUME_UP VOLUME_DOWN VOLUME_MUTE MUTE POWER HEADSETHOOK MEDIA_PLAY " +
  "MEDIA_PAUSE MEDIA_PLAY_PAUSE MEDIA_STOP MEDIA_NEXT MEDIA_PREVIOUS MEDIA_REWIND MEDIA_RECORD MEDIA_FAST_FORWARD CAMERA FOCUS SEARCH " +
  "BRIGHTNESS_DOWN BRIGHTNESS_UP MEDIA_AUDIO_TRACK SYSTEM_NAVIGATION_UP SYSTEM_NAVIGATION_DOWN SYSTEM_NAVIGATION_LEFT SYSTEM_NAVIGATION_RIGHT");
const MODIFIER_KEYS = keySet("SHIFT_LEFT SHIFT_RIGHT ALT_LEFT ALT_RIGHT CTRL_LEFT CTRL_RIGHT META_LEFT META_RIGHT SYM NUM FUNCTION");
const MEDIA_SESSION_KEYS = keySet("MEDIA_PLAY MEDIA_PAUSE MEDIA_PLAY_PAUSE MUTE HEADSETHOOK MEDIA_STOP MEDIA_NEXT MEDIA_PREVIOUS " +
  "MEDIA_REWIND MEDIA_RECORD MEDIA_FAST_FORWARD");
const isGamepadButton = (code: number) => (code >= 96 && code <= 110) || (code >= 188 && code <= 203);
/** KeyEvent.DispatcherState: which DOWN a target is tracking, so its UP arrives with FLAG_TRACKING */
class JKeyDispatcherState extends JObj { downKey = 0; target: unknown = null; }
rt.register({
  name: "android/view/KeyEvent$DispatcherState", ctor: JKeyDispatcherState,
  methods: {
    "<init>()V": function () {},
    "reset()V": function (this: JKeyDispatcherState) { this.downKey = 0; this.target = null; },
    "reset(Ljava/lang/Object;)V": function (this: JKeyDispatcherState, target: unknown) { if (this.target === target) { this.downKey = 0; this.target = null; } },
    "startTracking(Landroid/view/KeyEvent;Ljava/lang/Object;)V": function (this: JKeyDispatcherState, ev: JKeyEvent, target: unknown) {
      if (ev.action !== 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Can only start tracking on a down event");
      this.downKey = ev.keyCode; this.target = target; ev.tracking = true;
    },
    "isTracking(Landroid/view/KeyEvent;)Z": function (this: JKeyDispatcherState, ev: JKeyEvent) { return +(this.target !== null && this.downKey === ev.keyCode); },
    "handleUpEvent(Landroid/view/KeyEvent;)V": function (this: JKeyDispatcherState, ev: JKeyEvent) {
      if (this.target !== null && this.downKey === ev.keyCode) { ev.tracking = true; this.downKey = 0; this.target = null; }
    },
    "performedLongPress(Landroid/view/KeyEvent;)V": function () {},
  },
});
/** a window's dispatcher state, shared by every view in it (View.getKeyDispatcherState) */
export const keyDispatcherState = new JKeyDispatcherState();
/** A BACK press as ViewRootImpl delivers it to a window's callback: DOWN, then an UP that carries
 *  FLAG_TRACKING when the DOWN's receiver started tracking it (KeyEvent.DispatcherState). */
export const pressBackKey = driven(function* pressBackKey(callback: JObj): Gen {
  const downTime = BigInt(Math.floor(uptimeMillis()));
  const down = Object.assign(new JKeyEvent(), { keyCode: KEYCODE_BACK, downTime, eventTime: downTime });
  yield vcall(callback, "dispatchKeyEvent", M_dispatchKey, down);
  yield vcall(callback, "dispatchKeyEvent", M_dispatchKey, Object.assign(new JKeyEvent(), { action: 1, keyCode: KEYCODE_BACK, tracking: down.tracking,
    downTime, eventTime: BigInt(Math.floor(uptimeMillis())) }));
});
/** KeyEvent.dispatch to an Activity or Dialog: onKeyDown/onKeyUp by action */
const dispatchKeyToCallback = (callback: JObj, ev: JKeyEvent) => ev.action === 0 ? vcall(callback, "onKeyDown", "(ILandroid/view/KeyEvent;)Z", ev.keyCode, ev)
  : ev.action === 1 ? vcall(callback, "onKeyUp", "(ILandroid/view/KeyEvent;)Z", ev.keyCode, ev) : 0;
/** The tail of Activity's and Dialog's dispatchKeyEvent: the window's view tree first, then
 *  KeyEvent.dispatch to the callback itself. BACK finishes the window's action mode before its
 *  views see it (DecorView.superDispatchKeyEvent). */
export const dispatchWindowKey = driven(function* dispatchWindowKey(callback: JObj & { actionMode?: JObj | null }, root: JObj | null, ev: JKeyEvent): Gen {
  if (ev.keyCode === KEYCODE_BACK && callback.actionMode) {
    if (ev.action === 1) yield vcall(callback.actionMode, "finish", "()V");
    return 1;
  }
  if (root && (yield vcall(root, "dispatchKeyEvent", M_dispatchKey, ev))) return 1;
  return dispatchKeyToCallback(callback, ev);
});
/** Activity's and Dialog's own onKeyDown/onKeyUp: a BACK DOWN is tracked, and its tracked,
 *  uncanceled UP is onBackPressed */
export const backKeyMethods = {
  "onKeyDown(ILandroid/view/KeyEvent;)Z": (code: number, ev: JKeyEvent) => { if (code !== KEYCODE_BACK) return 0; ev.tracking = true; return 1; },
  "onKeyUp(ILandroid/view/KeyEvent;)Z": driven(function* (this: JObj, code: number, ev: JKeyEvent): Gen {
    if (code !== KEYCODE_BACK || !ev.tracking || ev.canceled) return 0;
    yield vcall(this, "onBackPressed", "()V");
    return 1;
  }),
};
rt.register({
  name: "android/view/KeyEvent", ctor: JKeyEvent, ifaces: ["android/os/Parcelable"],
  statics: {
    get CREATOR() { return parcelCreator("android/view/KeyEvent", async p => {
      const action: number = await vcall(p, "readInt", "()I");
      const keyCode: number = await vcall(p, "readInt", "()I");
      return Object.assign(new JKeyEvent(), { action, keyCode });
    }); },
    ACTION_DOWN: 0, ACTION_UP: 1, MAX_KEYCODE: 84,
    ...Object.fromEntries([...keyCodes].map(([name, code]) => ["KEYCODE_" + name, code])),
  },
  methods: {
    "<init>(II)V": function (this: JKeyEvent, a: number, k: number) { this.action = a; this.keyCode = k; },
    // AOSP's (downTime, eventTime, action, code, repeat[, metaState[, deviceId, scancode[, flags[, source]]]])
    ...Object.fromEntries(["", "I", "III", "IIII", "IIIII"].map((tail) => [`<init>(JJIII${tail})V`,
      function (this: JKeyEvent, down: bigint, at: bigint, action: number, code: number, repeat: number, meta = 0, device = -1, scan = 0, flags = 0, source = 0x101) {
        Object.assign(this, { downTime: down, eventTime: at, action, keyCode: code, repeat, meta, deviceId: device, scanCode: scan, flags, source });
      }])),
    "<init>(Landroid/view/KeyEvent;)V": function (this: JKeyEvent, o: JKeyEvent) { Object.assign(this, o); },
    "getMetaState()I": function (this: JKeyEvent) { return this.meta; },
    "isSystem()Z": function (this: JKeyEvent) { return +SYSTEM_KEYS.has(this.keyCode); },
    "static isModifierKey(I)Z": (code: number) => +MODIFIER_KEYS.has(code),
    "static isGamepadButton(I)Z": (code: number) => +isGamepadButton(code),
    "static isMediaSessionKey(I)Z": (code: number) => +MEDIA_SESSION_KEYS.has(code),
    // KeyEvent.dispatch: route to the callback by action, as Activity/View/Dialog dispatch does
    "dispatch(Landroid/view/KeyEvent$Callback;Landroid/view/KeyEvent$DispatcherState;Ljava/lang/Object;)Z": function (this: JKeyEvent, callback: JObj) {
      return dispatchKeyToCallback(callback, this);
    },
    "getModifiers()I": function (this: JKeyEvent) { return this.meta & 0x770ff; },
    "getRepeatCount()I": function (this: JKeyEvent) { return this.repeat; },
    "getDownTime()J": function (this: JKeyEvent) { return this.downTime; },
    "getEventTime()J": function (this: JKeyEvent) { return this.eventTime; },
    "getDeviceId()I": function (this: JKeyEvent) { return this.deviceId; },
    "getScanCode()I": function (this: JKeyEvent) { return this.scanCode; },
    "getFlags()I": function (this: JKeyEvent) { return this.flags | (this.tracking ? 0x200 : 0) | (this.canceled ? 0x20 : 0); },
    "getSource()I": function (this: JKeyEvent) { return this.source; },
    "isLongPress()Z": function (this: JKeyEvent) { return +!!(this.flags & 0x80); },
    // META_SHIFT_ON 1, META_ALT_ON 2, META_SYM_ON 4, META_CTRL_ON 0x1000, META_META_ON 0x10000, caps/num lock 0x100000/0x200000
    ...Object.fromEntries(([["Shift", 1], ["Alt", 2], ["Sym", 4], ["Ctrl", 0x1000], ["Meta", 0x10000], ["CapsLockOn", 0x100000], ["NumLockOn", 0x200000]] as const)
      .map(([name, bit]) => [`is${name}${name.endsWith("On") ? "" : "Pressed"}()Z`, function (this: JKeyEvent) { return +!!(this.meta & bit); }])),
    "startTracking()V": function (this: JKeyEvent) { this.tracking = true; },
    "isTracking()Z": function (this: JKeyEvent) { return +this.tracking; },
    "isCanceled()Z": function (this: JKeyEvent) { return +this.canceled; },
    "static getDeadChar(II)I": deadChar,
    "static getMaxKeyCode()I": () => keyCodes.size - 1,
    "static keyCodeFromString(Ljava/lang/String;)I": (name: string) => {
      if (name == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      if (/^[+-]?\d+$/.test(name)) {
        const code = Number(name);
        if (code >= 0 && code < keyCodes.size) return code | 0;
      }
      return keyCodes.get(name.startsWith("KEYCODE_") ? name.slice(8) : name) ?? 0;
    },
    "static getModifierMetaStateMask()I": () => 0x770ff,
    "static normalizeMetaState(I)I": (state: number) => {
      if (state & 0xc0) state |= 1;
      if (state & 0x30) state |= 2;
      if (state & 0x6000) state |= 0x1000;
      if (state & 0x60000) state |= 0x10000;
      if (state & 0x100) state |= 0x100000;
      if (state & 0x200) state |= 2;
      if (state & 0x400) state |= 4;
      return state & 0x7770ff;
    },
    "getAction()I": function (this: JKeyEvent) { return this.action; },
    "getKeyCode()I": function (this: JKeyEvent) { return this.keyCode; },
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JKeyEvent, p: JParcel): Gen {
      yield vcall(p, "writeInt", "(I)V", this.action);
      yield vcall(p, "writeInt", "(I)V", this.keyCode);
    }),
    "hasNoModifiers()Z": function (this: JKeyEvent) { return +!(this.meta & 0x770ff); },
    ...stubs(0, "getUnicodeChar()I", "hasModifiers(I)Z"),
  },
});
rt.markers("android/view/KeyEvent$Callback");
