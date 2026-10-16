// Android binary XML (AXML) + shared string-pool / Res_value bits (also used by arsc.ts)
import { u8, utf8 } from "../jvm/abi.ts";
import { perf } from "../perf.ts";

export const TV = { // typed value dataType
  NULL: 0x00, REFERENCE: 0x01, ATTRIBUTE: 0x02, STRING: 0x03, FLOAT: 0x04,
  DIMENSION: 0x05, FRACTION: 0x06, DYN_REF: 0x07, INT_DEC: 0x10, INT_HEX: 0x11,
  BOOLEAN: 0x12, COLOR_ARGB8: 0x1c, COLOR_RGB8: 0x1d, COLOR_ARGB4: 0x1e, COLOR_RGB4: 0x1f,
} as const;

/** A string pool chunk. Strings decode on first read: a resource table holds tens of thousands,
 *  and an app reads a small share of them. A split table's pool is appended past the base one. */
export class StringPool {
  private readonly view: DataView;
  private readonly cache: (string | undefined)[];
  private readonly offsets: number;
  private readonly start: number;
  private readonly utf8: boolean;
  private readonly count: number;
  private next: StringPool | null = null;
  private stylesOff = 0;      // 0 when the pool carries no style spans
  private styleOffsets = 0;
  private styleCount = 0;
  constructor(view: DataView, off: number) {
    this.view = view;
    this.count = view.getUint32(off + 8, true);
    this.cache = new Array(this.count);
    this.utf8 = (view.getUint32(off + 16, true) & 0x100) !== 0;
    this.start = off + view.getUint32(off + 20, true);
    this.offsets = off + view.getUint16(off + 2, true); // after header
    this.styleCount = view.getUint32(off + 12, true);
    const stylesStart = view.getUint32(off + 24, true);
    if (this.styleCount && stylesStart) {
      this.stylesOff = off + stylesStart;
      this.styleOffsets = this.offsets + this.count * 4;   // the style offsets follow the string ones
    }
  }
  /** strings across this pool and any appended to it */
  get length(): number { return this.count + (this.next?.length ?? 0); }
  /** Append a pool; returns the index its first string now has. */
  append(pool: StringPool): number {
    const at = this.length;
    let tail: StringPool = this;
    while (tail.next) tail = tail.next;
    tail.next = pool;
    return at;
  }
  at(i: number): string | undefined {
    if (i < 0) return undefined;
    if (i >= this.count) return this.next?.at(i - this.count);
    return this.cache[i] ??= this.decode(i);
  }
  get(i: number): string { return i === 0xffffffff ? "" : this.at(i) ?? ""; }
  private decode(i: number): string {
    const view = this.view;
    let p = this.start + view.getUint32(this.offsets + i * 4, true);
    if (this.utf8) {
      if (view.getUint8(p++) & 0x80) p++;                    // the UTF-16 length, unused
      let bytelen = view.getUint8(p++);
      if (bytelen & 0x80) bytelen = ((bytelen & 0x7f) << 8) | view.getUint8(p++);
      return utf8.dec.decode(u8(view, p, bytelen));
    }
    let len = view.getUint16(p, true); p += 2;
    if (len & 0x8000) { len = ((len & 0x7fff) << 16) | view.getUint16(p, true); p += 2; }
    let s = "";
    for (let j = 0; j < len; j += 1024) {
      const end = Math.min(len, j + 1024);
      const arr: number[] = [];
      for (let k = j; k < end; k++) arr.push(view.getUint16(p + k * 2, true));
      s += String.fromCharCode(...arr);
    }
    return s;
  }
  /** the style spans of string `i` as (nameIdx, firstChar, lastChar) triples, or null when the
   *  pool has none — which is what a pool without a styles array is, not an empty span list */
  styleOf(i: number): Int32Array | null {
    if (!this.stylesOff || i >= this.styleCount) return null;
    const v = this.view;
    const offset = v.getUint32(this.styleOffsets + i * 4, true);
    if (offset === 0xffffffff) return null;
    let p = this.stylesOff + offset;
    const out: number[] = [];
    for (;;) {
      const name = v.getUint32(p, true);
      if (name === 0xffffffff) break;             // END sentinel
      out.push(name, v.getUint32(p + 4, true), v.getUint32(p + 8, true));
      p += 12;
    }
    return out.length ? Int32Array.from(out) : null;
  }
}

export interface XmlAttr { ns: string; name: string; resId: number; type: number; data: number; str: string | null; }
export interface XmlNode { name: string; attrs: XmlAttr[]; children: XmlNode[]; }

/** The event codes AOSP's `XmlBlock.nativeNext` returns: the JNI maps libandroidfw's own
 *  ResXMLParser codes onto XmlPullParser's before the Java side ever sees them, and skips the
 *  namespace events entirely. Read out of `XmlBlock$Parser.next`'s bytecode, not from memory. */
export const XE = { START_DOCUMENT: 0, END_DOCUMENT: 1, START_TAG: 2, END_TAG: 3, TEXT: 4 } as const;

/** One event of the document's own stream. `nameIdx`/`nsIdx` are string-pool indices — the form
 *  XmlBlock hands out, with -1 for "none", which is what the framework reads as null or "".
 *  `raw` is (ns, name, rawValue) per attribute; `idIdx`/`classIdx`/`styleIdx` are attribute
 *  indices, -1 when the element declares none. */
export interface XmlEvent {
  type: number; node: XmlNode | null; depth: number; line: number;
  nameIdx: number; nsIdx: number;
  raw: Int32Array | null;
  idIdx: number; classIdx: number; styleIdx: number;
}
export interface XmlDoc { pool: StringPool; root: XmlNode; events: XmlEvent[] }

const idx = (v: number) => (v === 0xffffffff ? -1 : v);

/** out of line: the event objects are only built when a caller asked for the stream, and the
 *  literals sitting inside the chunk loop cost the tree-only parse ~10% (measured) */
function mkEvent(type: number, node: XmlNode | null, depth: number, line: number, nameIdx: number, nsIdx: number,
                 raw: Int32Array | null, idIdx = -1, classIdx = -1, styleIdx = -1): XmlEvent {
  return { type, node, depth, line, nameIdx, nsIdx, raw, idIdx, classIdx, styleIdx };
}

/** One pass over the chunk list. The tree is what everything above inflates from; `events` adds
 *  the pool indices and the TEXT and line-number chunks the tree drops, for the XmlBlock
 *  delegates. It is off by default because the inflater walks this on every layout. */
export function parseAXMLDoc(bytes: Uint8Array, events = false): XmlDoc {
  const started = performance.now();
  try { return parseChunks(bytes, events); } finally { perf.resParseMs += performance.now() - started; }
}
function parseChunks(bytes: Uint8Array, events: boolean): XmlDoc {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0x0003) throw new Error("not AXML");
  const fileSize = view.getUint32(4, true);
  let pos = view.getUint16(2, true);
  let pool: StringPool | null = null;
  let resMap: number[] = [];
  const root: XmlNode = { name: "#root", attrs: [], children: [] };
  const stack: XmlNode[] = [root];
  const evs: XmlEvent[] = [];
  if (events) evs.push(mkEvent(XE.START_DOCUMENT, null, 0, 0, -1, -1, null));

  while (pos < fileSize) {
    const type = view.getUint16(pos, true);
    const headerSize = view.getUint16(pos + 2, true);
    const chunkSize = view.getUint32(pos + 4, true);
    if (type === 0x0001) pool = new StringPool(view, pos);
    else if (type === 0x0180) {
      resMap = [];
      for (let p = pos + headerSize; p < pos + chunkSize; p += 4) resMap.push(view.getUint32(p, true));
    } else if (type === 0x0102) { // start element
      const nodeName = view.getUint32(pos + 20, true);
      const attrCount = view.getUint16(pos + 28, true);
      const attrStart = pos + 16 + view.getUint16(pos + 24, true);
      const attrSize = view.getUint16(pos + 26, true);
      const node: XmlNode = { name: pool!.get(nodeName), attrs: [], children: [] };
      for (let i = 0; i < attrCount; i++) {
        const p = attrStart + i * attrSize;
        const nsIdx = view.getUint32(p, true);
        const nameIdx = view.getUint32(p + 4, true);
        const rawIdx = view.getUint32(p + 8, true);
        const dataType = view.getUint8(p + 15);
        const data = view.getInt32(p + 16, true); // Java ints are signed (MATCH_PARENT = -1)
        node.attrs.push({
          ns: pool!.get(nsIdx),
          name: pool!.get(nameIdx),
          resId: resMap[nameIdx] ?? 0,
          type: dataType,
          data,
          str: dataType === TV.STRING || rawIdx !== 0xffffffff ? pool!.get(rawIdx !== 0xffffffff ? rawIdx : data) : null,
        });
      }
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      // the pool indices are re-read here rather than in the attribute loop above: a branch per
      // attribute there cost the tree-only parse 10%, and this loop does not run without events
      let raw: Int32Array | null = null;
      if (events) {
        raw = new Int32Array(attrCount * 3);
        for (let i = 0, o = 0; i < attrCount; i++, o += 3) {
          const p = attrStart + i * attrSize;
          raw[o] = idx(view.getUint32(p, true));
          raw[o + 1] = idx(view.getUint32(p + 4, true));
          raw[o + 2] = idx(view.getUint32(p + 8, true));
        }
      }
      // idIndex/classIndex/styleIndex are 1-based attribute indices, 0 meaning the element has none
      if (events) evs.push(mkEvent(XE.START_TAG, node, stack.length - 1, view.getUint32(pos + 8, true),
        idx(nodeName), idx(view.getUint32(pos + 16, true)), raw,
        view.getUint16(pos + 30, true) - 1, view.getUint16(pos + 32, true) - 1, view.getUint16(pos + 34, true) - 1));
    } else if (type === 0x0103) { // end element
      const node = stack.length > 1 ? stack.pop()! : null;
      if (events) evs.push(mkEvent(XE.END_TAG, node, stack.length, view.getUint32(pos + 8, true),
        idx(view.getUint32(pos + 20, true)), idx(view.getUint32(pos + 16, true)), null));
    } else if (type === 0x0104 && events) { // cdata
      evs.push(mkEvent(XE.TEXT, null, stack.length - 1, view.getUint32(pos + 8, true), idx(view.getUint32(pos + 16, true)), -1, null));
    }
    pos += chunkSize;
  }
  if (events) evs.push(mkEvent(XE.END_DOCUMENT, null, 0, 0, -1, -1, null));
  return { pool: pool!, root: root.children[0] ?? root, events: evs };
}

const trees = new WeakMap<Uint8Array, XmlNode>();
export function parseAXML(bytes: Uint8Array): XmlNode {
  let root = trees.get(bytes);
  if (!root) trees.set(bytes, (root = parseAXMLDoc(bytes).root));
  return root;
}

export function attr(node: XmlNode, name: string): XmlAttr | undefined {
  return node.attrs.find((a) => a.name === name);
}
export function attrStr(node: XmlNode, name: string): string | null {
  return xmlAttrString(attr(node, name));
}

function xmlAttrString(a: XmlAttr | undefined): string | null {
  if (!a) return null;
  if (a.str !== null) return a.str;
  return a.type === TV.BOOLEAN ? (a.data ? "true" : "false") : String(a.data);
}
