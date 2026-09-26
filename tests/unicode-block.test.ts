import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
const cls = rt.link("java/lang/Character$UnicodeBlock").ctor;
const of = (cp: number) => vcall(cls, "of", "(I)Ljava/lang/Character$UnicodeBlock;", cp);
const named = (name: string | null) => vcall(cls, "forName", "(Ljava/lang/String;)Ljava/lang/Character$UnicodeBlock;", name);

test("Unicode blocks preserve range boundaries, gaps and singleton identity", async () => {
  for (const [cp, name] of [[0, "BASIC_LATIN"], [0x7f, "BASIC_LATIN"], [0x80, "LATIN_1_SUPPLEMENT"],
    [0x4e00, "CJK_UNIFIED_IDEOGRAPHS"], [0xd800, "HIGH_SURROGATES"], [0xdb80, "HIGH_PRIVATE_USE_SURROGATES"],
    [0xdc00, "LOW_SURROGATES"], [0x1f600, "EMOTICONS"], [0x30000, "CJK_UNIFIED_IDEOGRAPHS_EXTENSION_G"],
    [0x10ffff, "SUPPLEMENTARY_PRIVATE_USE_AREA_B"]] as const) {
    const block = await of(cp);
    expect(block).toBe(await named(name));
    expect(await vcall(block, "toString", "()Ljava/lang/String;")).toBe(name);
    expect(rt.iof(block, "java/lang/Character$Subset")).toBe(1);
  }
  expect(await of(0x2fe0)).toBe(null);
  expect(await of(0x31350)).toBe(null);
  expect(await vcall(cls, "of", "(C)Ljava/lang/Character$UnicodeBlock;", 0x41)).toBe(await of(0x41));
  for (const cp of [-1, 0x110000]) await expect((async () => of(cp))()).rejects.toMatchObject({ msg: "Not a valid Unicode code point" });
});

test("Unicode block names accept Java aliases without inventing spellings", async () => {
  expect(await named("basic latin")).toBe(await named("BasicLatin"));
  expect(await named("Greek and Coptic")).toBe(await named("GREEK"));
  expect(await named("Latin-1Supplement")).toBe(await named("LATIN_1_SUPPLEMENT"));
  expect(await named("Cyrillic Supplement")).toBe(await named("CYRILLIC_SUPPLEMENTARY"));
  for (const name of ["BASIC-LATIN", " Basic Latin", "SURROGATES_AREA"]) await expect((async () => named(name))()).rejects.toMatchObject({ msg: "Not a valid block name: " + name });
  await expect((async () => named(null))()).rejects.toMatchObject({ msg: "blockName" });
});
