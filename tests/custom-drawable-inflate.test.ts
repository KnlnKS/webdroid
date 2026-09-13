import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { JDrawable, inflateDrawableNode } from "../src/android/drawable";
import { Resources } from "../src/android/res";
import { mkJResources } from "../src/android/resnative";
import { TV, type XmlNode } from "../src/android/axml";

class XmlDrawable extends JDrawable {
  tag = "";
  value = -1;
  child = "";
  sameParserAndAttrs = false;
}

rt.register({
  name: "test/XmlDrawable",
  ctor: XmlDrawable,
  sup: "android/graphics/drawable/Drawable",
  methods: {
    "<init>()V": () => {},
    "inflate(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;Landroid/util/AttributeSet;Landroid/content/res/Resources$Theme;)V":
      async function (this: XmlDrawable, _res: unknown, parser: unknown, attrs: unknown) {
        this.sameParserAndAttrs = parser === attrs;
        this.tag = await vcall(parser, "getName", "()Ljava/lang/String;");
        this.value = await vcall(attrs, "getAttributeIntValue", "(Ljava/lang/String;Ljava/lang/String;I)I", "", "amount", -1);
        await vcall(parser, "next", "()I");
        this.child = await vcall(parser, "getName", "()Ljava/lang/String;");
      },
  },
});
rt.linkNatives();

test("fully qualified drawable tags construct and inflate the app class", async () => {
  const res = new Resources(null, {});
  mkJResources(res, false);
  const node: XmlNode = {
    name: "test.XmlDrawable",
    attrs: [{ ns: "", name: "amount", resId: 0, type: TV.INT_DEC, data: 17, str: null }],
    children: [{ name: "child", attrs: [], children: [] }],
  };
  const drawable = await inflateDrawableNode(res, node, null);
  expect(drawable).toBeInstanceOf(XmlDrawable);
  if (!(drawable instanceof XmlDrawable)) return;
  expect(drawable.tag).toBe("test.XmlDrawable");
  expect(drawable.value).toBe(17);
  expect(drawable.child).toBe("child");
  expect(drawable.sameParserAndAttrs).toBe(true);
});
