# Noto Color Emoji

`Noto-COLRv1.ttf` is the unmodified Noto Color Emoji 2.051 font, copyright 2022 Google Inc., distributed under the SIL Open Font License 1.1 in `NotoEmoji-LICENSE.txt`.

- Source: https://github.com/googlefonts/noto-emoji/blob/f3ae03f5e9b3b8516fa151f7168159ca1a3e7515/fonts/Noto-COLRv1.ttf
- SHA-256: `0ae57fe58645638523ba35f388d93739d292539a9acb84df5700c81b1e1a28d2`
- Size: 4,991,984 bytes. The full emoji font is retained; no application-specific subset is used.

The native Android font configuration uses this face as its `und-Zsye` fallback. Its bytes are mounted as a lazy range-readable file, so applications that do not open native system fonts do not download it.

The COLRv1 face was verified through Lichess’s native Skia/Impeller rendering path. First native use reads the entire font; the vendor HTTP route and RangeFile cache retain those ranges.
