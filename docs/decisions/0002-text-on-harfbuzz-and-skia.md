# 0002: text measures on HarfBuzz over the reference fonts; paths use Skia's PathOps

Status: adopted 2026-10-01 (plan §3 Stage E2). Measurements and failure mechanisms are in the
implementation history's "Stage E2" entry.

## Decision

- **Fonts are the reference build's.** `/system/fonts` (206 files) and `font_fallback.xml` are
  platform data like ICU; AOSP's SystemFonts parses the configuration. A system font's glyphs load
  on first shape or draw; style, metrics, axes and coverage come from `/font-index.json`, built from
  the same files (`scripts/font-index.ts`), as apps receive a serialized font map.
- **HarfBuzz is minikin's shaper for measurement too.** Paint and MeasuredText advances, line and
  run extents, and text bounds come from the layout `shaping.ts` makes (itemization, LayoutSplitter
  pieces, HarfBuzz at minikin's 24.8 scale, Skia's hinted advances). minikin's own algorithms
  (itemization, line breaking, grapheme and word breaks) stay a TS port: on every recorded case
  they agree with the device, which a wasm build of minikin and ICU4C could not improve on.
- **Canvas2D draws text with `fillText`,** each font registered as its own CSS face (an instance
  pinning what a canvas cannot set, such as `ital`), in the faces minikin itemized the string into.
  Text into a bitmap in Roboto or the emoji face is CanvasKit's drawGlyphs of minikin's glyphs and
  positions, rasterized by FreeType as on the device.
- **Path.op is SkPathOps and Paint.getFillPath SkStroke,** through the tab's CanvasKit, loaded
  lazily wherever it is first asked.

## Why

- Against the reference AVD: `textcmp` 72/72 layouts with widths within 0.00 px and every line's
  ascent and descent (71/72 within 1.03 px, CJK failing, on browser metrics and static fonts); the
  recorded per-character advances of every case including CJK; fwtest's glyph ids, positions,
  overrides, text bounds and per-text metrics (`getFontMetricsInt` over CJK: -47 -46 12 12).
- Fast e2e content differences against the device goldens: calculatorm 2.97 -> 1.17%, fitnotes
  13.94 -> 3.06% when its flow reaches the golden's content.
- Cost: a cold StaticLayout of 150 paragraphs 41-43 ms on HarfBuzz vs 46-49 ms on `measureText`;
  `cssFont` 0.9 µs a draw; launches and tap latency within run-to-run noise interleaved against
  the previous tree.
- Path.op matches the device's verbs and fill type exactly (the TS clipper returned a polygon
  starting elsewhere, dropped conics and ignored inverse fill types), with 200 lines fewer.
- Graphics fuzz (seed 20261001, 100 cases) against the reference AVD finds the same 8 differences
  as the tree before E2, after fixing the one it added (an inverse fill drawn through Path.op).

## Rejected

- Drawing text as HarfBuzz glyph outlines (Path2D fills): a 1080x2160 screen of text costs
  5.9-7.0 ms against `fillText`'s 0.36 ms in headless Chrome, 16-20x.
- A glyph atlas blitted with `drawImage` per glyph: 14-44 ms for the same screen; Canvas2D's
  per-call cost dominates.
- Relying on CSS for every axis: Chrome applies `wght` and `wdth` from the font and stretch but
  never `ital`, so an italic variable face draws upright (3% narrower than measured).

## Costs and follow-ups

- Applications receive the serialized font map (`/font-index.json`, built by AOSP's
  `Typeface.serializeFontMap`), but each realm's Typeface.<clinit> still parses the legacy
  `fonts.xml`; only the boot image (§4.3) removes it.
- FreeType's hinter can widen an advance HarfBuzz rounds down (Roboto l at wght 900, 20 px: 6 on
  the device, 5 here), and hinted outlines lift some bounds a pixel.
- CanvasKit 0.38's PathOps returns a whole conic arc as quads where the device's Skia keeps it.
- The page draws `/system/fonts`' preinstalled emoji font, which the recorded device glyphs
  match; the AVD has since installed a NotoColorEmoji update under `/data/fonts` through GMS.
- Hyphenation (minikin's Hyphenator over `/system/usr/hyphen-data`) has no device recording.
- `fillText` positions glyphs by Chrome's unhinted advances, so a drawn run can drift from its
  hinted layout by a fraction of a pixel per glyph.
