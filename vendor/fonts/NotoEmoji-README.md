# Noto Color Emoji

These unmodified fonts match the API 33 reference system image and its `und-Zsye` fallback order.
They are distributed under the SIL Open Font License 1.1 in `NotoEmoji-LICENSE.txt`.

| Installed file | Version | Copyright | Bytes | SHA-256 |
| --- | --- | --- | ---: | --- |
| `NotoColorEmoji.ttf` | 2.038 | 2022 Google Inc. | 2,767,876 | `83914c48dc1bb7ff27cd06a3728d2f997dbcdc15cdc81b7deb21079c6d36e108` |
| `NotoColorEmojiFlags.ttf` | 2.034 | 2013 Google Inc. | 849,060 | `a20c15a60b7761b8241ee5fe2b7538acca06198b9c5e2333ce87912f32183dd2` |

Source: AOSP `platform/external/noto-fonts` commit
[`896f6b4d50411b9798fe56eaec7ec817a94ea1f3`](https://android.googlesource.com/platform/external/noto-fonts/+/896f6b4d50411b9798fe56eaec7ec817a94ea1f3/emoji-compat/font/).
AOSP's `emoji-compat/Android.bp` installs `NotoColorEmojiCompat.ttf` as `NotoColorEmoji.ttf`.
The general face uses COLRv1; the flags face uses CBDT/CBLC. This is Android's standard split,
not an application-specific subset. The font pair replaces the previously bundled Noto 2.051
face; coverage follows the API 33 reference rather than that newer Unicode release.

Browser Paint loads these fonts before app layout, so cached text widths cannot use a temporary
host emoji fallback. Native Android font configuration names the same pair, mounted through
range-readable files. The pair totals 3,616,936 bytes; the HTTP cache reuses downloads.
