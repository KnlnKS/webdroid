// Wire function indices include js-string imports omitted by Module.imports.
export function wasmWireMap(bytes: Uint8Array) {
  if (bytes.length < 8 || ![0, 97, 115, 109, 1, 0, 0, 0].every((v, i) => bytes[i] === v)) throw new Error("invalid Wasm header");
  let at = 8, limit = bytes.length;
  const byte = () => { if (at >= limit) throw new Error("truncated Wasm field"); return bytes[at++]; };
  const uint = () => {
    let n = 0, shift = 0, v;
    do { v = byte(); n += (v & 127) * 2 ** shift; shift += 7; if (shift > 70) throw new Error("oversized Wasm LEB"); } while (v & 128);
    return n;
  };
  const skip = (size: number) => { if (size > limit - at) throw new Error("truncated Wasm payload"); at += size; };
  const text = () => { const size = uint(), start = at; skip(size); return new TextDecoder().decode(bytes.subarray(start, at)); };
  const valueType = () => { const t = byte(); if (t === 0x63 || t === 0x64) uint(); };
  const limits = () => { const flags = uint(); uint(); if (flags & 1) uint(); };
  const names = new Map<number, string>(), types: number[] = [];
  const imports: { module: string; name: string; kind: number; functionIndex?: number; typeIndex?: number }[] = [];
  const bodies: { offset: number; bodyBytes: number }[] = [], sections: { kind: number; offset: number; bytes: number; name?: string }[] = [];
  let imported = 0;
  while (at < bytes.length) {
    limit = bytes.length;
    const offset = at, kind = byte(), size = uint(), end = at + size;
    if (end > bytes.length) throw new Error("truncated Wasm section");
    limit = end;
    const section: typeof sections[number] = { kind, offset, bytes: end - offset };
    if (kind === 0) {
      section.name = text();
      if (section.name === "name") while (at < end) {
        const subkind = byte(), length = uint(), subend = at + length;
        if (subend > end) throw new Error("truncated Wasm name subsection");
        limit = subend;
        if (subkind === 1) for (let i = uint(); i > 0; i--) { const index = uint(); names.set(index, text()); }
        at = subend; limit = end;
      }
    } else if (kind === 2) for (let i = uint(); i > 0; i--) {
      const item: typeof imports[number] = { module: text(), name: text(), kind: byte() };
      if (item.kind === 0) { item.functionIndex = imported++; item.typeIndex = uint(); }
      else if (item.kind === 1) { valueType(); limits(); }
      else if (item.kind === 2) limits();
      else if (item.kind === 3) { valueType(); byte(); }
      else if (item.kind === 4) { byte(); item.typeIndex = uint(); }
      else throw new Error(`unknown Wasm import kind ${item.kind}`);
      imports.push(item);
    }
    else if (kind === 3) for (let i = uint(); i > 0; i--) types.push(uint());
    else if (kind === 10) for (let i = uint(); i > 0; i--) { const bodyBytes = uint(); bodies.push({ offset: at, bodyBytes }); skip(bodyBytes); }
    at = end; sections.push(section);
  }
  if (types.length !== bodies.length) throw new Error("Wasm function/body count mismatch");
  return { imports, sections, functions: bodies.map((body, i) => ({ index: imported + i, name: names.get(imported + i) ?? "", typeIndex: types[i], ...body })) };
}
