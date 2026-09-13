import { JObj, rt } from "../runtime";
import { UNICODE_BLOCKS } from "./unicode-blocks";

class JSubset extends JObj { constructor(public name = "") { super(); } }
rt.register({ name: "java/lang/Character$Subset", ctor: JSubset, methods: {
  "<init>(Ljava/lang/String;)V": function (this: JSubset, name: string | null) {
    if (name === null) throw rt.mkThrowable("java/lang/NullPointerException", "name");
    this.name = name;
  },
  "toString()Ljava/lang/String;": function (this: JSubset) { return this.name; },
} });

class JUnicodeBlock extends JSubset {}
const constants: Record<string, JUnicodeBlock> = {};
const aliases = new Map<string, JUnicodeBlock>();
const blocks: (JUnicodeBlock | null)[] = [];
const rows = UNICODE_BLOCKS.split("\n");
const starts = new Uint32Array(rows.length);
for (let i = 0; i < rows.length; i++) {
  const names = rows[i].split("|");
  const [start, name] = names[0].split(" ");
  starts[i] = parseInt(start, 16);
  if (!name) { blocks.push(null); continue; }
  const block = new JUnicodeBlock(name);
  constants[name] = block;
  blocks.push(block);
  names[0] = name;
  for (const alias of names) {
    aliases.set(alias, block);
    aliases.set(alias.replaceAll(" ", ""), block);
  }
}
constants.SURROGATES_AREA = new JUnicodeBlock("SURROGATES_AREA");

function blockOf(codePoint: number): JUnicodeBlock | null {
  if (codePoint < 0 || codePoint > 0x10ffff) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Not a valid Unicode code point");
  let lo = 0, hi = starts.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (codePoint >= starts[mid]) lo = mid; else hi = mid;
  }
  return blocks[lo];
}
rt.register({ name: "java/lang/Character$UnicodeBlock", ctor: JUnicodeBlock, sup: "java/lang/Character$Subset", statics: constants, methods: {
  "static of(I)Ljava/lang/Character$UnicodeBlock;": blockOf,
  "static of(C)Ljava/lang/Character$UnicodeBlock;": blockOf,
  "static forName(Ljava/lang/String;)Ljava/lang/Character$UnicodeBlock;": (name: string | null) => {
    if (name === null) throw rt.mkThrowable("java/lang/NullPointerException", "blockName");
    const block = aliases.get(name.toUpperCase());
    if (!block) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Not a valid block name: " + name);
    return block;
  },
} });
