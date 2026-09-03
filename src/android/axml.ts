// Android binary XML (AXML) + shared string-pool / Res_value bits (also used by arsc.ts)

export const TV = { // typed value dataType
  NULL: 0x00, REFERENCE: 0x01, ATTRIBUTE: 0x02, STRING: 0x03, FLOAT: 0x04,
  DIMENSION: 0x05, FRACTION: 0x06, DYN_REF: 0x07, INT_DEC: 0x10, INT_HEX: 0x11,
  BOOLEAN: 0x12, COLOR_ARGB8: 0x1c, COLOR_RGB8: 0x1d, COLOR_ARGB4: 0x1e, COLOR_RGB4: 0x1f,
} as const;

const utf8Dec = new TextDecoder();

export class StringPool {
  strings: string[] = [];
  constructor(view: DataView, off: number) {
    const count = view.getUint32(off + 8, true);
    const flags = view.getUint32(off + 16, true);
    const stringsStart = off + view.getUint32(off + 20, true);
    const utf8 = (flags & 0x100) !== 0;
    const offsetsBase = off + view.getUint16(off + 2, true); // after header
    for (let i = 0; i < count; i++) {
      let p = stringsStart + view.getUint32(offsetsBase + i * 4, true);
      if (utf8) {
        let u16len = view.getUint8(p++);
        if (u16len & 0x80) u16len = ((u16len & 0x7f) << 8) | view.getUint8(p++);
        let bytelen = view.getUint8(p++);
        if (bytelen & 0x80) bytelen = ((bytelen & 0x7f) << 8) | view.getUint8(p++);
        const bytes = new Uint8Array(view.buffer, view.byteOffset + p, bytelen);
        this.strings.push(utf8Dec.decode(bytes));
      } else {
        let len = view.getUint16(p, true); p += 2;
        if (len & 0x8000) { len = ((len & 0x7fff) << 16) | view.getUint16(p, true); p += 2; }
        let s = "";
        for (let j = 0; j < len; j += 1024) {
          const end = Math.min(len, j + 1024);
          const arr: number[] = [];
          for (let k = j; k < end; k++) arr.push(view.getUint16(p + k * 2, true));
          s += String.fromCharCode(...arr);
        }
        this.strings.push(s);
      }
    }
  }
  get(i: number): string { return i === 0xffffffff ? "" : this.strings[i] ?? ""; }
}

export interface XmlAttr { ns: string; name: string; resId: number; type: number; data: number; str: string | null; }
export interface XmlNode { name: string; attrs: XmlAttr[]; children: XmlNode[]; }

export function parseAXML(bytes: Uint8Array): XmlNode {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0x0003) throw new Error("not AXML");
  const fileSize = view.getUint32(4, true);
  let pos = view.getUint16(2, true);
  let pool: StringPool | null = null;
  let resMap: number[] = [];
  const root: XmlNode = { name: "#root", attrs: [], children: [] };
  const stack: XmlNode[] = [root];

  while (pos < fileSize) {
    const type = view.getUint16(pos, true);
    const headerSize = view.getUint16(pos + 2, true);
    const chunkSize = view.getUint32(pos + 4, true);
    if (type === 0x0001) pool = new StringPool(view, pos);
    else if (type === 0x0180) {
      resMap = [];
      for (let p = pos + headerSize; p < pos + chunkSize; p += 4) resMap.push(view.getUint32(p, true));
    } else if (type === 0x0102) { // start element
      const name = pool!.get(view.getUint32(pos + 20, true));
      const attrCount = view.getUint16(pos + 28, true);
      const attrStart = pos + 16 + view.getUint16(pos + 24, true);
      const attrSize = view.getUint16(pos + 26, true);
      const node: XmlNode = { name, attrs: [], children: [] };
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
    } else if (type === 0x0103) {
      if (stack.length > 1) stack.pop();
    }
    pos += chunkSize;
  }
  return root.children[0] ?? root;
}

export function attr(node: XmlNode, name: string): XmlAttr | undefined {
  return node.attrs.find((a) => a.name === name);
}
export function attrStr(node: XmlNode, name: string): string | null {
  const a = attr(node, name);
  return a ? (a.str ?? String(a.data)) : null;
}
