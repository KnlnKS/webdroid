export {};
// Distill AOSP values XML (vendor/aosp-res) → src/android/framework-res.json
// Gives real android.R ids, attr enum maps, Material theme/style bags, colors, dimens.

const dir = "vendor/aosp-res";
const read = (f: string) => Bun.file(`${dir}/${f}`).text();

// crude-but-adequate XML element scanner for AOSP values files
function* elements(xml: string, tag: string): Generator<{ attrs: Record<string, string>; body: string }> {
  const re = new RegExp(`<${tag}\\b([^>]*?)(/>|>([\\s\\S]*?)</${tag}>)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs: Record<string, string> = {};
    const attrRe = /([\w:-]+)\s*=\s*"([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(m[1]))) attrs[am[1]] = am[2];
    yield { attrs, body: m[3] ?? "" };
  }
}

// ── public ids
const ids: Record<string, Record<string, number>> = {};
for (const f of ["public-final.xml"]) {
  const xml = await read(f);
  for (const el of elements(xml, "public")) {
    const { type, name, id } = el.attrs;
    if (!type || !name || !id) continue;
    (ids[type] ??= {})[name] = parseInt(id, 16);
  }
}
console.log("public ids:", Object.entries(ids).map(([t, m]) => `${t}=${Object.keys(m).length}`).join(" "));

// ── attr enum/flag values
const attrEnums: Record<string, Record<string, number>> = {};
{
  const xml = await read("attrs.xml");
  for (const el of elements(xml, "attr")) {
    const name = el.attrs.name;
    if (!name || !el.body) continue;
    const map: Record<string, number> = {};
    for (const en of elements(el.body, "enum")) map[en.attrs.name] = parseInt(en.attrs.value);
    for (const fl of elements(el.body, "flag")) map[fl.attrs.name] = parseInt(fl.attrs.value, fl.attrs.value?.startsWith("0x") ? 16 : 10);
    if (Object.keys(map).length) attrEnums[name] = map;
  }
  console.log("attr enums:", Object.keys(attrEnums).length);
}

// ── colors & dimens (raw strings; resolved at runtime)
const colors: Record<string, string> = {};
const dimens: Record<string, string> = {};
for (const f of ["colors.xml", "colors_holo.xml", "colors_material.xml"]) {
  for (const el of elements(await read(f), "color")) colors[el.attrs.name] = el.body.trim();
  // colors also defined via <item type="color">
  for (const el of elements(await read(f), "item")) {
    if (el.attrs.type === "color") colors[el.attrs.name] = el.body.trim();
  }
}
for (const f of ["dimens.xml", "dimens_material.xml"]) {
  for (const el of elements(await read(f), "dimen")) dimens[el.attrs.name] = el.body.trim();
  for (const el of elements(await read(f), "item")) {
    if (el.attrs.type === "dimen") dimens[el.attrs.name] = el.body.trim();
  }
}
console.log("colors:", Object.keys(colors).length, "dimens:", Object.keys(dimens).length);

// ── styles/themes: name → {parent, items{attrName: rawValue}}
const styles: Record<string, { parent: string; items: Record<string, string> }> = {};
for (const f of ["themes.xml", "themes_holo.xml", "themes_material.xml", "themes_device_defaults.xml", "styles.xml", "styles_holo.xml", "styles_material.xml"]) {
  const xml = await read(f);
  for (const el of elements(xml, "style")) {
    const name = el.attrs.name;
    if (!name) continue;
    let parent = el.attrs.parent ?? "";
    if (!("parent" in el.attrs) && name.includes(".")) parent = name.slice(0, name.lastIndexOf("."));
    const items: Record<string, string> = {};
    for (const it of elements(el.body, "item")) {
      const an = it.attrs.name;
      if (an && !an.includes(":") || an?.startsWith("android:")) {
        items[an.replace("android:", "")] = it.body.trim();
      }
    }
    styles[name] = { parent: parent.replace(/^@(android:)?style\//, "").replace(/^android:/, ""), items };
  }
}
console.log("styles:", Object.keys(styles).length);

// ── the strings framework widgets need (buttons etc.)
const strings: Record<string, string> = {};
{
  const want = new Set(["ok", "cancel", "yes", "no", "copy", "paste", "cut", "selectAll", "search_go", "close", "untitled"]);
  for (const el of elements(await read("strings.xml"), "string")) {
    if (want.has(el.attrs.name)) strings[el.attrs.name] = el.body.trim().replace(/^"|"$/g, "");
  }
}

const out = { ids, attrEnums, colors, dimens, styles, strings };
await Bun.write("src/android/framework-res.json", JSON.stringify(out));
console.log("wrote src/android/framework-res.json", (JSON.stringify(out).length / 1024).toFixed(0) + "KB");
