// KeyEvent's and KeyCharacterMap's natives: InputEventLookup's key code labels, and libinput's
// KeyCharacterMap (KeyCharacterMap.cpp) over the reference device's .kcm files behind
// KeyCharacterMap's mPtr. KeyEvent, its DispatcherState and KeyCharacterMap run from AOSP bytecode.

import { rt, type JObj, declaredField } from "../jvm/runtime.ts";
import { jarray } from "../jvm/abi.ts";
import { after, newObj, scall } from "../jvm/natives/jentry.ts";
import { ownedHandle, deref } from "./handles.ts";
import { type NativeParcel, nativeParcel, readInt, writeInt, readCString, writeCString } from "./parcel.ts";
import { keyCodes } from "./keycodes.ts";
import { nextId } from "./motionevent.ts";
import { uptimeMillis } from "../guest-clock.ts";

const KE = "android/view/KeyEvent", KCM = "android/view/KeyCharacterMap";
export const SOURCE_KEYBOARD = 0x101;
const labels = [...keyCodes.keys()];

// ── KeyCharacterMap
const Meta = {
  SHIFT: 1, ALT: 2, SYM: 4, FUNCTION: 8, ALT_LEFT: 0x10, ALT_RIGHT: 0x20, SHIFT_LEFT: 0x40, SHIFT_RIGHT: 0x80,
  CTRL: 0x1000, CTRL_LEFT: 0x2000, CTRL_RIGHT: 0x4000, META: 0x10000, META_LEFT: 0x20000, META_RIGHT: 0x40000,
  CAPS_LOCK: 0x100000, NUM_LOCK: 0x200000, SCROLL_LOCK: 0x400000,
} as const;
const MODIFIERS: Record<string, number> = {
  shift: Meta.SHIFT, lshift: Meta.SHIFT_LEFT, rshift: Meta.SHIFT_RIGHT, alt: Meta.ALT, lalt: Meta.ALT_LEFT, ralt: Meta.ALT_RIGHT,
  ctrl: Meta.CTRL, lctrl: Meta.CTRL_LEFT, rctrl: Meta.CTRL_RIGHT, meta: Meta.META, lmeta: Meta.META_LEFT, rmeta: Meta.META_RIGHT,
  sym: Meta.SYM, fn: Meta.FUNCTION, capslock: Meta.CAPS_LOCK, numlock: Meta.NUM_LOCK, scrolllock: Meta.SCROLL_LOCK,
};
const TYPES: Record<string, number> = { NUMERIC: 1, PREDICTIVE: 2, ALPHA: 3, FULL: 4, SPECIAL_FUNCTION: 5, OVERLAY: 6 };
interface Behavior { meta: number; ch: number; fallback: number; replacement: number }
interface Key { label: number; number: number; behaviors: Behavior[] }
interface KeyMap { file: string; type: number; overlay: boolean; keys: Map<number, Key>; scanCodes: Map<number, number>; usageCodes: Map<number, number> }

const keyCodeByLabel = (label: string): number | undefined => keyCodes.get(label);
/** KeyCharacterMap::Parser over a .kcm file, as the device's format accepts it; null where it errs */
export function parseKeyMap(file: string, text: string): KeyMap | null {
  const map: KeyMap = { file, type: 0, overlay: false, keys: new Map(), scanCodes: new Map(), usageCodes: new Map() };
  let key: Key | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!key) {
      const [word, ...rest] = line.split(/\s+/);
      if (word === "type") {
        if (!(rest[0] in TYPES)) return null;
        map.type = TYPES[rest[0]];
      } else if (word === "map") {
        const code = keyCodeByLabel(rest[2]), from = Number(rest[1]);
        if ((rest[0] !== "key" && rest[0] !== "usage") || code === undefined || !Number.isFinite(from)) return null;
        (rest[0] === "key" ? map.scanCodes : map.usageCodes).set(from, code);
      } else if (word === "key") {
        const code = keyCodeByLabel(rest[0]);
        if (code === undefined || map.keys.has(code) || rest[1] !== "{") return null;
        map.keys.set(code, key = { label: 0, number: 0, behaviors: [] });
      } else return null;
      continue;
    }
    if (line === "}") { finishKey(key); key = null; continue; }
    if (!parseProperty(key, line)) return null;
  }
  return key || !map.type ? null : map;
}
function parseModifier(token: string): number | null {
  if (token === "base") return 0;
  let combined = 0;
  for (const part of token.split("+")) {
    const meta = MODIFIERS[part];
    if (!meta || combined & meta) return null;
    combined |= meta;
  }
  return combined;
}
/** one `names: behavior` line inside a key block */
function parseProperty(key: Key, line: string): boolean {
  const colon = line.indexOf(":");
  if (colon < 0) return false;
  const props: (["label" | "number"] | ["meta", number])[] = [];
  for (const name of line.slice(0, colon).split(",").map((s) => s.trim())) {
    if (name === "label" || name === "number") props.push([name]);
    else {
      const meta = parseModifier(name);
      if (meta === null) return false;
      props.push(["meta", meta]);
    }
  }
  const b: Behavior = { meta: 0, ch: 0, fallback: 0, replacement: 0 };
  let haveChar = false, haveFallback = false, haveReplacement = false;
  let rest = line.slice(colon + 1).trim();
  while (rest && !rest.startsWith("#")) {
    if (rest[0] === "'") {
      const m = /^'(\\u[0-9a-fA-F]{4}|\\[nt\\'"]|[ -~])'(?=\s|$)/.exec(rest);
      if (!m || haveChar || haveReplacement) return false;
      const lit = m[1];
      b.ch = lit.length === 1 ? lit.charCodeAt(0) : lit[1] === "u" ? parseInt(lit.slice(2), 16)
        : { n: 10, t: 9, "\\": 92, "'": 39, '"': 34 }[lit[1]]!;
      if (!b.ch) return false;
      haveChar = true;
      rest = rest.slice(m[0].length).trim();
      continue;
    }
    const [word, arg] = rest.split(/\s+/, 2);
    if (word === "none") {
      if (haveChar || haveReplacement) return false;
      haveChar = true;
      rest = rest.slice(word.length).trim();
    } else if (word === "fallback" || word === "replace") {
      const code = keyCodeByLabel(arg ?? "");
      if (code === undefined || haveFallback || haveReplacement || (word === "replace" && haveChar)) return false;
      if (word === "fallback") { b.fallback = code; haveFallback = true; } else { b.replacement = code; haveReplacement = true; }
      rest = rest.slice(rest.indexOf(arg) + arg.length).trim();
    } else return false;
  }
  for (const prop of props) {
    if (prop[0] === "meta") {
      if (key.behaviors.some((x) => x.meta === prop[1])) return false;
      key.behaviors.unshift({ ...b, meta: prop[1] });
    } else {
      if (key[prop[0]]) return false;
      key[prop[0]] = b.ch;
    }
  }
  return true;
}
const NUMBER_SYMBOLS = new Set("()#*-+,.':;/");
/** Parser::finishKey: a key without a number property takes its last digit, or symbol, behavior */
function finishKey(key: Key) {
  if (key.number) return;
  let digit = 0, symbol = 0;
  for (const { ch } of key.behaviors) {
    if (!ch) continue;
    if (ch >= 48 && ch <= 57) digit = ch;
    else if (NUMBER_SYMBOLS.has(String.fromCharCode(ch))) symbol = ch;
  }
  key.number = digit || symbol;
}
const EXACT = Meta.CTRL | Meta.CTRL_LEFT | Meta.CTRL_RIGHT | Meta.ALT | Meta.ALT_LEFT | Meta.ALT_RIGHT | Meta.META | Meta.META_LEFT | Meta.META_RIGHT;
/** KeyCharacterMap::matchesMetaState: CTRL, ALT and META must match exactly, a side or either */
function matchesMeta(event: number, behavior: number): boolean {
  if ((event & behavior) !== behavior) return false;
  let unmatched = event & ~behavior & EXACT;
  for (const [either, left, right] of [[Meta.CTRL, Meta.CTRL_LEFT, Meta.CTRL_RIGHT], [Meta.ALT, Meta.ALT_LEFT, Meta.ALT_RIGHT], [Meta.META, Meta.META_LEFT, Meta.META_RIGHT]]) {
    if (behavior & either) unmatched &= ~(left | right);
    else if (behavior & (left | right)) unmatched &= ~either;
  }
  return !unmatched;
}
const behaviorOf = (map: KeyMap, code: number, meta: number) => map.keys.get(code)?.behaviors.find((b) => matchesMeta(meta, b.meta));
/** KeyCharacterMap::findKey: the first key, by key code, with a behavior typing `ch`; its most general such behavior */
function findKey(map: KeyMap, ch: number): [number, number] | null {
  if (!ch) return null;
  for (const code of [...map.keys.keys()].sort((a, b) => a - b)) {
    let found: Behavior | undefined;
    for (const b of map.keys.get(code)!.behaviors) if (b.ch === ch) found = b;
    if (found) return [code, found.meta];
  }
  return null;
}
// Keyboard.cpp's updateMetaState
const normalize = (m: number) => m | (m & (Meta.ALT_LEFT | Meta.ALT_RIGHT) ? Meta.ALT : 0) | (m & (Meta.SHIFT_LEFT | Meta.SHIFT_RIGHT) ? Meta.SHIFT : 0)
  | (m & (Meta.CTRL_LEFT | Meta.CTRL_RIGHT) ? Meta.CTRL : 0) | (m & (Meta.META_LEFT | Meta.META_RIGHT) ? Meta.META : 0);
const EPHEMERAL: Record<number, number> = { 57: Meta.ALT_LEFT, 58: Meta.ALT_RIGHT, 59: Meta.SHIFT_LEFT, 60: Meta.SHIFT_RIGHT, 63: Meta.SYM,
  119: Meta.FUNCTION, 113: Meta.CTRL_LEFT, 114: Meta.CTRL_RIGHT, 117: Meta.META_LEFT, 118: Meta.META_RIGHT };
const LOCKED: Record<number, number> = { 115: Meta.CAPS_LOCK, 143: Meta.NUM_LOCK, 116: Meta.SCROLL_LOCK };
function updateMetaState(code: number, down: boolean, old: number): number {
  const ephemeral = EPHEMERAL[code];
  if (ephemeral) return normalize(down ? old | ephemeral : old & ~(ephemeral | Meta.ALT | Meta.SHIFT | Meta.CTRL | Meta.META));
  const locked = LOCKED[code];
  return locked && !down ? old ^ locked : old;
}
interface KeyStroke { code: number; meta: number; down: boolean }
/** KeyCharacterMap::getEvents: the strokes typing `chars`, modifiers pressed and released around each */
function strokes(map: KeyMap, chars: ArrayLike<number>): KeyStroke[] | null {
  const out: KeyStroke[] = [];
  for (let i = 0; i < chars.length; i++) {
    const found = findKey(map, chars[i]);
    if (!found) return null;
    const [code, meta] = found;
    let current = 0;
    const add = (key: number, down: boolean) => { current = updateMetaState(key, down, current); out.push({ code: key, meta: current, down }); };
    const single = (down: boolean, key: number, bits: number) => { if ((meta & bits) !== bits) return false; add(key, down); return true; };
    const double = (down: boolean, left: number, leftBits: number, right: number, rightBits: number, either: number) => {
      const specific = +single(down, left, leftBits) | +single(down, right, rightBits);
      if (!specific) single(down, left, either);
    };
    const lockedKey = (key: number, bits: number) => { if ((meta & bits) === bits) { add(key, true); add(key, false); } };
    const doubles: [number, number, number, number, number][] = [[59, Meta.SHIFT_LEFT, 60, Meta.SHIFT_RIGHT, Meta.SHIFT],
      [57, Meta.ALT_LEFT, 58, Meta.ALT_RIGHT, Meta.ALT], [113, Meta.CTRL_LEFT, 114, Meta.CTRL_RIGHT, Meta.CTRL], [117, Meta.META_LEFT, 118, Meta.META_RIGHT, Meta.META]];
    lockedKey(115, Meta.CAPS_LOCK); lockedKey(143, Meta.NUM_LOCK); lockedKey(116, Meta.SCROLL_LOCK);
    for (const d of doubles) double(true, ...d);
    single(true, 63, Meta.SYM); single(true, 119, Meta.FUNCTION);
    out.push({ code, meta: current, down: true }, { code, meta: current, down: false });
    single(false, 119, Meta.FUNCTION); single(false, 63, Meta.SYM);
    for (const d of [...doubles].reverse()) double(false, ...d);
    lockedKey(116, Meta.SCROLL_LOCK); lockedKey(143, Meta.NUM_LOCK); lockedKey(115, Meta.CAPS_LOCK);
  }
  return out;
}
function sameMap(a: KeyMap, b: KeyMap): boolean {
  if (a.type !== b.type || a.overlay !== b.overlay || a.keys.size !== b.keys.size) return false;
  const sameCodes = (x: Map<number, number>, y: Map<number, number>) => x.size === y.size && [...x].every(([k, v]) => y.get(k) === v);
  if (!sameCodes(a.scanCodes, b.scanCodes) || !sameCodes(a.usageCodes, b.usageCodes)) return false;
  for (const [code, k] of a.keys) {
    const o = b.keys.get(code);
    if (!o || o.label !== k.label || o.number !== k.number || o.behaviors.length !== k.behaviors.length) return false;
    if (k.behaviors.some((x, i) => { const y = o.behaviors[i]; return x.meta !== y.meta || x.ch !== y.ch || x.fallback !== y.fallback || x.replacement !== y.replacement; })) return false;
  }
  return true;
}

/** NativeKeyCharacterMap: a device's id and its map, or no map for obtainEmptyMap's */
class NativeKeyCharacterMap { readonly deviceId: number; readonly map: KeyMap | null; constructor(deviceId: number, map: KeyMap | null) { this.deviceId = deviceId; this.map = map; } }
const kcmAt = (h: bigint) => deref<NativeKeyCharacterMap>(h);
/** a Java KeyCharacterMap over `map` for device `deviceId` */
export const javaKeyCharacterMap = (deviceId: number, map: KeyMap | null): JObj | Promise<JObj> =>
  newObj(KCM, "(J)V", ownedHandle(new NativeKeyCharacterMap(deviceId, map)));

/** KeyCharacterMap::writeToParcel */
function writeMap(p: NativeParcel, map: KeyMap) {
  writeCString(p, map.file); writeInt(p, map.type); writeInt(p, +map.overlay);
  writeInt(p, map.keys.size);
  for (const code of [...map.keys.keys()].sort((a, b) => a - b)) {
    const k = map.keys.get(code)!;
    writeInt(p, code); writeInt(p, k.label); writeInt(p, k.number);
    for (const b of k.behaviors) { writeInt(p, 1); writeInt(p, b.meta); writeInt(p, b.ch); writeInt(p, b.fallback); writeInt(p, b.replacement); }
    writeInt(p, 0);
  }
  writeInt(p, 0); // key remapping
  for (const codes of [map.scanCodes, map.usageCodes]) {
    writeInt(p, codes.size);
    for (const [from, to] of [...codes].sort((a, b) => a[0] - b[0])) { writeInt(p, from); writeInt(p, to); }
  }
}
function readMap(p: NativeParcel): KeyMap | null {
  const map: KeyMap = { file: readCString(p) ?? "", type: readInt(p), overlay: readInt(p) !== 0, keys: new Map(), scanCodes: new Map(), usageCodes: new Map() };
  const count = readInt(p);
  if (count < 0 || count > 8192) return null;
  for (let i = 0; i < count; i++) {
    const code = readInt(p), key: Key = { label: readInt(p), number: readInt(p), behaviors: [] };
    while (readInt(p)) key.behaviors.push({ meta: readInt(p), ch: readInt(p), fallback: readInt(p), replacement: readInt(p) });
    map.keys.set(code, key);
  }
  for (let n = readInt(p); n > 0; n--) { readInt(p); readInt(p); }
  for (const codes of [map.scanCodes, map.usageCodes]) for (let n = readInt(p); n > 0; n--) codes.set(readInt(p), readInt(p));
  return map;
}

let fallbackFields: [string, string] | null = null;
rt.registerJnis(KCM, {
  "nativeReadFromParcel(Landroid/os/Parcel;)J": (parcel: JObj) => {
    const p = nativeParcel(parcel), deviceId = readInt(p);
    let map: KeyMap | null = null;
    if (readInt(p)) { map = readMap(p); if (!map) return 0n; }
    return ownedHandle(new NativeKeyCharacterMap(deviceId, map));
  },
  "nativeWriteToParcel(JLandroid/os/Parcel;)V": (ptr: bigint, parcel: JObj) => {
    const k = kcmAt(ptr), p = nativeParcel(parcel);
    writeInt(p, k.deviceId);
    writeInt(p, k.map ? 1 : 0);
    if (k.map) writeMap(p, k.map);
  },
  "nativeDispose(J)V": () => {},
  "nativeGetCharacter(JII)C": (ptr: bigint, code: number, meta: number) => { const m = kcmAt(ptr).map; return m ? behaviorOf(m, code, meta)?.ch ?? 0 : 0; },
  "nativeGetFallbackAction(JIILandroid/view/KeyCharacterMap$FallbackAction;)Z": (ptr: bigint, code: number, meta: number, out: Record<string, number>) => {
    const m = kcmAt(ptr).map, b = m && behaviorOf(m, code, meta);
    const [keyCode, metaState] = fallbackFields ??= [declaredField(`${KCM}$FallbackAction`, "keyCode"), declaredField(`${KCM}$FallbackAction`, "metaState")];
    out[keyCode] = b?.fallback ?? 0; out[metaState] = b?.fallback ? meta & ~b.meta : 0;
    return +!!b?.fallback;
  },
  "nativeGetNumber(JI)C": (ptr: bigint, code: number) => kcmAt(ptr).map?.keys.get(code)?.number ?? 0,
  "nativeGetMatch(JI[CI)C": (ptr: bigint, code: number, chars: Uint16Array, meta: number) => {
    const key = kcmAt(ptr).map?.keys.get(code);
    let result = 0;
    for (const b of key?.behaviors ?? []) {
      if (!b.ch || !chars.includes(b.ch)) continue;
      result = b.ch;
      if ((b.meta & meta) === b.meta) break;
    }
    return result;
  },
  "nativeGetDisplayLabel(JI)C": (ptr: bigint, code: number) => kcmAt(ptr).map?.keys.get(code)?.label ?? 0,
  "nativeGetKeyboardType(J)I": (ptr: bigint) => kcmAt(ptr).map?.type ?? 0,
  "nativeGetEvents(J[C)[Landroid/view/KeyEvent;": (ptr: bigint, chars: Uint16Array) => {
    const k = kcmAt(ptr);
    if (!k.map) return jarray([], `L${KE};`);
    const list = strokes(k.map, chars);
    if (!list) return null;
    const now = BigInt(Math.round(uptimeMillis() * 1e6)), events: JObj[] = [];
    const next = (i: number): unknown => i === list.length ? jarray(events, `L${KE};`)
      : after(scall(KE, "obtain", `(IJJIIIIIIIII[BLjava/lang/String;)L${KE};`, nextId(), now, now, list[i].down ? 0 : 1, list[i].code, 0,
        list[i].meta, k.deviceId, 0, 0, SOURCE_KEYBOARD, -1, new Int8Array(32), null) as JObj | Promise<JObj>, (ev: JObj) => { events.push(ev); return next(i + 1); });
    return next(0);
  },
  "nativeObtainEmptyKeyCharacterMap(I)Landroid/view/KeyCharacterMap;": (deviceId: number) => javaKeyCharacterMap(deviceId, null),
  "nativeEquals(JJ)Z": (a: bigint, b: bigint) => {
    const x = kcmAt(a).map, y = kcmAt(b).map;
    return +(x && y ? sameMap(x, y) : x === y);
  },
  "nativeApplyOverlay(JLjava/lang/String;Ljava/lang/String;)V": (ptr: bigint, descriptor: string, overlay: string) => {
    const base = kcmAt(ptr).map, layer = parseKeyMap(descriptor, overlay);
    if (!base || !layer || layer.type !== TYPES.OVERLAY) return;
    for (const [code, key] of layer.keys) base.keys.set(code, key);
    for (const [from, to] of layer.scanCodes) base.scanCodes.set(from, to);
    for (const [from, to] of layer.usageCodes) base.usageCodes.set(from, to);
    base.overlay = true;
  },
  // no key remapping is configured on the device
  "nativeGetMappedKey(JI)I": () => 0,
});

rt.registerJnis(KE, {
  "nativeNextId()I": nextId,
  "nativeKeyCodeToString(I)Ljava/lang/String;": (code: number) => labels[code] ?? null,
  "nativeKeyCodeFromString(Ljava/lang/String;)I": (label: string) => keyCodes.get(label) ?? 0,
});
