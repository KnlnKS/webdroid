// HarfBuzz, as harfbuzzjs builds it (HB_TINY, 434 KB of wasm), instantiated without its
// emscripten glue: the module imports five trivial functions, and the calls made here pass plain
// pointers. It is loaded on first use, once per tab (the tab's realms share one thread, so they
// share one instance and its faces, as they share CanvasKit).


type Ptr = number;
interface Exports {
  memory: WebAssembly.Memory; __indirect_function_table: WebAssembly.Table; __wasm_call_ctors(): void;
  malloc(n: number): Ptr; free(p: Ptr): void;
  hb_blob_create(data: Ptr, length: number, mode: number, user: Ptr, destroy: Ptr): Ptr; hb_blob_destroy(b: Ptr): void;
  hb_face_create(blob: Ptr, index: number): Ptr; hb_face_destroy(f: Ptr): void; hb_face_get_upem(f: Ptr): number;
  hb_font_create(face: Ptr): Ptr; hb_font_destroy(f: Ptr): void; hb_font_set_variations(f: Ptr, v: Ptr, n: number): void; hb_font_set_scale(f: Ptr, x: number, y: number): void;
  hb_font_get_nominal_glyph(f: Ptr, cp: number, out: Ptr): number; hb_font_get_variation_glyph(f: Ptr, cp: number, vs: number, out: Ptr): number;
  hb_font_get_glyph_h_advance(f: Ptr, g: number): number; hb_font_get_glyph_extents(f: Ptr, g: number, out: Ptr): number;
  hb_font_draw_glyph(f: Ptr, g: number, funcs: Ptr, data: Ptr): void;
  hb_draw_funcs_create(): Ptr; hb_draw_funcs_set_move_to_func(d: Ptr, fn: number, user: Ptr, destroy: Ptr): void;
  hb_draw_funcs_set_line_to_func(d: Ptr, fn: number, user: Ptr, destroy: Ptr): void; hb_draw_funcs_set_quadratic_to_func(d: Ptr, fn: number, user: Ptr, destroy: Ptr): void;
  hb_draw_funcs_set_cubic_to_func(d: Ptr, fn: number, user: Ptr, destroy: Ptr): void; hb_draw_funcs_set_close_path_func(d: Ptr, fn: number, user: Ptr, destroy: Ptr): void;
  hb_buffer_create(): Ptr; hb_buffer_clear_contents(b: Ptr): void; hb_buffer_add_utf16(b: Ptr, text: Ptr, length: number, offset: number, n: number): void;
  hb_buffer_set_direction(b: Ptr, d: number): void; hb_buffer_set_language(b: Ptr, l: Ptr): void; hb_buffer_guess_segment_properties(b: Ptr): void;
  hb_buffer_get_length(b: Ptr): number; hb_buffer_get_glyph_infos(b: Ptr, n: Ptr): Ptr; hb_buffer_get_glyph_positions(b: Ptr, n: Ptr): Ptr;
  hb_language_from_string(s: Ptr, n: number): Ptr; hb_feature_from_string(s: Ptr, n: number, out: Ptr): number; hb_shape(f: Ptr, b: Ptr, features: Ptr, n: number): void;
  hb_ot_color_has_paint(face: Ptr): number; hb_ot_color_has_layers(face: Ptr): number; hb_ot_color_has_png(face: Ptr): number;
}

const HB_MEMORY_MODE_READONLY = 1;
export const HB_DIRECTION_INVALID = 0, HB_DIRECTION_LTR = 4, HB_DIRECTION_RTL = 5;

/** one face of a font file in wasm memory, and its fonts by variation settings */
interface Face { readonly face: Ptr; readonly data: Ptr; readonly upem: number; readonly color: boolean; readonly fonts: Map<string, Font> }
/** an hb_font whose positions, extents and outlines come in `units` per em: 256 per font unit, so a
 *  varied advance keeps its fraction; glyph outlines are cached */
export interface Font { readonly font: Ptr; readonly face: Face; readonly units: number; readonly outlines: Map<number, Path2D | null> }

/** what an outline is drawn into: a Path2D, or a control box */
export type Sink = Pick<Path2D, "moveTo" | "lineTo" | "quadraticCurveTo" | "bezierCurveTo" | "closePath">;
/** the box around an outline's points under (x, y) -> (a x + c y, d y), as FreeType's
 *  FT_Outline_Get_CBox bounds a transformed outline */
class ControlBox implements Sink {
  a = 1; c = 0; d = 1;
  x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity;
  private add(x: number, y: number): void {
    const px = this.a * x + this.c * y, py = this.d * y;
    if (px < this.x0) this.x0 = px; if (px > this.x1) this.x1 = px;
    if (py < this.y0) this.y0 = py; if (py > this.y1) this.y1 = py;
  }
  moveTo(x: number, y: number): void { this.add(x, y); }
  lineTo(x: number, y: number): void { this.add(x, y); }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void { this.add(cx, cy); this.add(x, y); }
  bezierCurveTo(ax: number, ay: number, bx: number, by: number, x: number, y: number): void { this.add(ax, ay); this.add(bx, by); this.add(x, y); }
  closePath(): void {}
}

/** a JS function as a wasm function of `sig` (i: i32, f: f32; the first letter the result), in
 *  the module's table, as emscripten's addFunction makes one */
function addFunction(table: WebAssembly.Table, sig: string, fn: (...args: number[]) => void): number {
  const code = (c: string) => (c === "i" ? 0x7f : 0x7d), params = [...sig.slice(1)].map(code);
  const type = [0x60, params.length, ...params, ...(sig[0] === "v" ? [0] : [1, code(sig[0])])];
  const section = (id: number, body: number[]) => [id, body.length, ...body];
  const bytes = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...section(1, [1, ...type]),
    ...section(2, [1, 1, 0x65, 1, 0x66, 0, 0]), ...section(7, [1, 1, 0x66, 0, 0])]);
  const f = new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { f: fn } }).exports.f;
  const at = table.grow(1);
  table.set(at, f);
  return at;
}

export class HarfBuzz {
  private readonly x: Exports;
  private u8!: Uint8Array; private u16!: Uint16Array; private i32!: Int32Array; private u32!: Uint32Array;
  private scratch: Ptr; private text: Ptr = 0; private textCap = 0;
  private readonly buffer: Ptr;
  private readonly drawFuncs: Ptr;
  private sink: Sink | null = null;
  private readonly languages = new Map<string, Ptr>();
  private readonly faces = new WeakMap<ArrayBufferLike, Map<string, Face>>();
  private readonly released = new FinalizationRegistry<Map<string, Face>>((faces) => this.destroy(faces));

  constructor(x: Exports) {
    this.x = x;
    x.__wasm_call_ctors();
    this.scratch = x.malloc(64);
    this.buffer = x.hb_buffer_create();
    const t = x.__indirect_function_table, d = this.drawFuncs = x.hb_draw_funcs_create();
    x.hb_draw_funcs_set_move_to_func(d, addFunction(t, "viiiffi", (_f, _d, _s, px, py) => this.sink!.moveTo(px, py)), 0, 0);
    x.hb_draw_funcs_set_line_to_func(d, addFunction(t, "viiiffi", (_f, _d, _s, px, py) => this.sink!.lineTo(px, py)), 0, 0);
    x.hb_draw_funcs_set_quadratic_to_func(d, addFunction(t, "viiiffffi", (_f, _d, _s, cx, cy, px, py) => this.sink!.quadraticCurveTo(cx, cy, px, py)), 0, 0);
    x.hb_draw_funcs_set_cubic_to_func(d, addFunction(t, "viiiffffffi", (_f, _d, _s, ax, ay, bx, by, px, py) => this.sink!.bezierCurveTo(ax, ay, bx, by, px, py)), 0, 0);
    x.hb_draw_funcs_set_close_path_func(d, addFunction(t, "viiii", () => this.sink!.closePath()), 0, 0);
    this.views();
  }
  private views(): void {
    const b = this.x.memory.buffer;
    if (this.u8?.buffer === b) return;
    this.u8 = new Uint8Array(b); this.u16 = new Uint16Array(b); this.i32 = new Int32Array(b); this.u32 = new Uint32Array(b);
  }

  /** the face of `bytes` at `ttcIndex`, copied into wasm memory once per file for the tab */
  face(bytes: Uint8Array, ttcIndex: number): Face {
    let byFile = this.faces.get(bytes.buffer);
    if (!byFile) {
      this.faces.set(bytes.buffer, byFile = new Map());
      this.released.register(bytes.buffer, byFile);
    }
    const key = bytes.byteOffset + ":" + bytes.byteLength + ":" + ttcIndex;
    let f = byFile.get(key);
    if (!f) {
      const x = this.x, data = x.malloc(bytes.length);
      this.views();
      this.u8.set(bytes, data);
      const blob = x.hb_blob_create(data, bytes.length, HB_MEMORY_MODE_READONLY, 0, 0), face = x.hb_face_create(blob, ttcIndex);
      x.hb_blob_destroy(blob);
      f = { face, data, upem: x.hb_face_get_upem(face), color: !!(x.hb_ot_color_has_paint(face) || x.hb_ot_color_has_layers(face) || x.hb_ot_color_has_png(face)), fonts: new Map() };
      byFile.set(key, f);
    }
    return f;
  }
  private destroy(faces: Map<string, Face>): void {
    for (const f of faces.values()) {
      for (const font of f.fonts.values()) this.x.hb_font_destroy(font.font);
      this.x.hb_face_destroy(f.face);
      this.x.free(f.data);
    }
  }
  /** the face's font under variation settings: [tag, value] pairs */
  font(face: Face, axes: readonly (readonly [number, number])[]): Font {
    const key = axes.length ? axes.map(([t, v]) => t + "=" + v).join(",") : "";
    let f = face.fonts.get(key);
    if (!f) {
      const font = this.x.hb_font_create(face.face), units = face.upem * 256;
      this.x.hb_font_set_scale(font, units, units);
      if (axes.length) {
        const at = this.x.malloc(axes.length * 8);
        this.views();
        const f32 = new Float32Array(this.x.memory.buffer, at, axes.length * 2);
        axes.forEach(([tag, value], i) => { this.u32[(at >> 2) + i * 2] = tag >>> 0; f32[i * 2 + 1] = value; });
        this.x.hb_font_set_variations(font, at, axes.length);
        this.x.free(at);
      }
      face.fonts.set(key, f = { font, face, units, outlines: new Map() });
    }
    return f;
  }

  glyph(font: Font, cp: number, vs = 0): number {
    const ok = vs ? this.x.hb_font_get_variation_glyph(font.font, cp, vs, this.scratch) : this.x.hb_font_get_nominal_glyph(font.font, cp, this.scratch);
    if (!ok) return 0;
    this.views();
    return this.u32[this.scratch >> 2];
  }
  advance(font: Font, glyph: number): number { return this.x.hb_font_get_glyph_h_advance(font.font, glyph); }
  /** [xMin, yMin, xMax, yMax] in font units, y up; null for a glyph without extents */
  extents(font: Font, glyph: number): [number, number, number, number] | null {
    if (!this.x.hb_font_get_glyph_extents(font.font, glyph, this.scratch)) return null;
    this.views();
    const i = this.scratch >> 2, xb = this.i32[i], yb = this.i32[i + 1], w = this.i32[i + 2], h = this.i32[i + 3];
    return [xb, yb + h, xb + w, yb];
  }
  /** the glyph's outline in font units, y up; null when it has none */
  outline(font: Font, glyph: number): Path2D | null {
    let p = font.outlines.get(glyph);
    if (p === undefined) {
      const path = new Path2D();
      this.draw(font, glyph, path);
      p = this.extents(font, glyph) ? path : null;
      font.outlines.set(glyph, p);
    }
    return p;
  }
  private readonly box = new ControlBox();
  /** [left, top, right, bottom] of the glyph's control points in font units under
   *  (x, y) -> (a x + c y, d y); null when it has no outline */
  controlBox(font: Font, glyph: number, a: number, c: number, d: number): [number, number, number, number] | null {
    const b = this.box;
    b.a = a; b.c = c; b.d = d; b.x0 = b.y0 = Infinity; b.x1 = b.y1 = -Infinity;
    this.draw(font, glyph, b);
    return b.x0 <= b.x1 ? [b.x0, b.y0, b.x1, b.y1] : null;
  }
  /** the glyph's outline in font units, y up, into `sink` */
  draw(font: Font, glyph: number, sink: Sink): void {
    this.sink = sink;
    try { this.x.hb_font_draw_glyph(font.font, glyph, this.drawFuncs, 0); } finally { this.sink = null; }
  }

  /** `text` into wasm memory as UTF-16, for addText */
  setText(text: string, start: number, end: number): void {
    const n = end - start;
    if (n > this.textCap) {
      if (this.text) this.x.free(this.text);
      this.text = this.x.malloc((this.textCap = Math.max(64, n)) * 2);
    }
    this.views();
    const at = this.text >> 1;
    for (let i = 0; i < n; i++) this.u16[at + i] = text.charCodeAt(start + i);
    this.textLength = n;
  }
  private textLength = 0;
  private features: Ptr = 0; private featureKey: string | null = null; private featureCount = 0;
  /** Shape [offset, offset + n) of the text set by setText, the rest its context: the glyph
   *  count, then infos() and positions() read the results. `features` is CSS
   *  font-feature-settings, as minikin hands it to HarfBuzz. */
  shape(font: Font, offset: number, n: number, direction: number, language: string, features: string | null): number {
    const x = this.x, b = this.buffer;
    x.hb_buffer_clear_contents(b);
    x.hb_buffer_add_utf16(b, this.text, this.textLength, offset, n);
    x.hb_buffer_set_direction(b, direction);
    x.hb_buffer_set_language(b, this.language(language));
    x.hb_buffer_guess_segment_properties(b);
    if (features !== this.featureKey) this.parseFeatures(features);
    x.hb_shape(font.font, b, this.features, this.featureCount);
    return x.hb_buffer_get_length(b);
  }
  /** glyph infos (5 words each: codepoint, mask, cluster, ...) and positions (x_advance,
   *  y_advance, x_offset, y_offset, ...) of the last shape, as word offsets into words() */
  infos(): number { return this.x.hb_buffer_get_glyph_infos(this.buffer, 0) >> 2; }
  positions(): number { return this.x.hb_buffer_get_glyph_positions(this.buffer, 0) >> 2; }
  words(): Int32Array { this.views(); return this.i32; }

  private language(tag: string): Ptr {
    let l = this.languages.get(tag);
    if (l === undefined) {
      const at = this.x.malloc(tag.length);
      this.views();
      for (let i = 0; i < tag.length; i++) this.u8[at + i] = tag.charCodeAt(i) & 0x7f;
      this.languages.set(tag, l = this.x.hb_language_from_string(at, tag.length));
      this.x.free(at);
    }
    return l;
  }
  private parseFeatures(css: string | null): void {
    const items = css ? css.split(",").map((s) => s.trim()).filter(Boolean) : [];
    if (this.features) this.x.free(this.features);
    this.features = items.length ? this.x.malloc(items.length * 16) : 0;
    let n = 0;
    for (const item of items) {
      const at = this.x.malloc(item.length);
      this.views();
      for (let i = 0; i < item.length; i++) this.u8[at + i] = item.charCodeAt(i) & 0x7f;
      if (this.x.hb_feature_from_string(at, item.length, this.features + n * 16)) n++;
      this.x.free(at);
    }
    this.featureKey = css; this.featureCount = n;
  }
}

let ready: HarfBuzz | null = null, loading: Promise<HarfBuzz> | undefined;
/** the tab's HarfBuzz, loading it on first use */
export function harfBuzz(): PromiseOrVal<HarfBuzz> {
  return ready ?? (loading ??= load().then((hb) => ready = hb));
}
/** the tab's HarfBuzz, which preloadFonts loaded with the realm's fonts: text is measured
 *  synchronously */
export function loadedHarfBuzz(): HarfBuzz {
  if (!ready) throw new Error("HarfBuzz is not loaded");
  return ready;
}
/** where the page serves one of harfbuzzjs' builds; node reads it from node_modules */
const wasmUrl = (name: string) => typeof location !== "undefined" && location.protocol.startsWith("http") ? `/${name}`
  : `file://${process.cwd()}/node_modules/harfbuzzjs/dist/${name}`;
async function instantiate(name: string, imports: WebAssembly.Imports): Promise<WebAssembly.Exports> {
  const res = await fetch(wasmUrl(name));
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return (await WebAssembly.instantiate(await res.arrayBuffer(), imports)).instance.exports;
}

// hb-subset as harfbuzzjs builds it (a reactor with no imports), loaded on first use per tab
interface SubsetExports {
  memory: WebAssembly.Memory; _initialize(): void; malloc(n: number): Ptr; free(p: Ptr): void;
  hb_blob_create(data: Ptr, length: number, mode: number, user: Ptr, destroy: Ptr): Ptr; hb_blob_destroy(b: Ptr): void;
  hb_blob_get_length(b: Ptr): number; hb_blob_get_data(b: Ptr, length: Ptr): Ptr;
  hb_face_create(blob: Ptr, index: number): Ptr; hb_face_destroy(f: Ptr): void; hb_face_reference_blob(f: Ptr): Ptr;
  hb_subset_input_create_or_fail(): Ptr; hb_subset_input_destroy(i: Ptr): void; hb_subset_input_keep_everything(i: Ptr): void;
  hb_subset_input_pin_axis_location(i: Ptr, face: Ptr, tag: number, value: number): number; hb_subset_or_fail(face: Ptr, input: Ptr): Ptr;
}
let subset: Promise<SubsetExports> | undefined;
/** face `ttcIndex` of a font file as a font of its own, the variation axes in `pins` fixed at their
 *  values: everything else (glyph ids, layout tables, other axes) kept */
export async function instanceFace(bytes: Uint8Array, ttcIndex: number, pins: readonly (readonly [number, number])[]): Promise<Uint8Array> {
  const x = await (subset ??= (async () => {
    const e = await instantiate("harfbuzz-subset.wasm", {}) as unknown as SubsetExports;
    e._initialize();
    return e;
  })());
  const data = x.malloc(bytes.length);
  new Uint8Array(x.memory.buffer).set(bytes, data);
  const blob = x.hb_blob_create(data, bytes.length, HB_MEMORY_MODE_READONLY, 0, 0), face = x.hb_face_create(blob, ttcIndex);
  const input = x.hb_subset_input_create_or_fail();
  try {
    x.hb_subset_input_keep_everything(input);
    for (const [tag, value] of pins) x.hb_subset_input_pin_axis_location(input, face, tag >>> 0, value);
    const out = x.hb_subset_or_fail(face, input);
    if (!out) throw new Error("HarfBuzz could not instance the face");
    const result = x.hb_face_reference_blob(out);
    const copy = new Uint8Array(x.memory.buffer, x.hb_blob_get_data(result, 0), x.hb_blob_get_length(result)).slice();
    x.hb_blob_destroy(result); x.hb_face_destroy(out);
    return copy;
  } finally {
    x.hb_subset_input_destroy(input); x.hb_face_destroy(face); x.hb_blob_destroy(blob); x.free(data);
  }
}

async function load(): Promise<HarfBuzz> {
  let exports: Exports;
  const memory = () => exports.memory;
  const imports = {
    env: {
      _abort_js: () => { throw new Error("HarfBuzz aborted"); },
      _emscripten_runtime_keepalive_clear: () => {},
      _setitimer_js: () => 0,
      emscripten_resize_heap: (size: number) => {
        const have = memory().buffer.byteLength, want = Math.max(size >>> 0, have + (have >>> 2));
        try { memory().grow(Math.ceil((want - have) / 65536)); return 1; } catch { return 0; }
      },
    },
    wasi_snapshot_preview1: { proc_exit: (code: number) => { throw new Error(`HarfBuzz exited ${code}`); } },
  };
  exports = await instantiate("harfbuzz.wasm", imports) as unknown as Exports;
  return new HarfBuzz(exports);
}
