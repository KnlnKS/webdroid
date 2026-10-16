import { existsSync, readFileSync } from "node:fs";

import { rt, declaredField, JObj } from "../../src/jvm/runtime.ts";
import { newObj, vcall, scall, iof } from "../../src/jvm/natives/jentry.ts";
import { Arsc } from "../../src/android/arsc.ts";
import { Resources } from "../../src/android/res.ts";
import { PackageRecord, packages } from "../../src/android/packages.ts";
import { parseAXML } from "../../src/android/axml.ts";
import { installFramework } from "../../src/android/framework.ts";
import { animateRenderThread } from "../../src/android/rtanimator.ts";
import { NativeRenderNode } from "../../src/android/rendernode.ts";
import { handle } from "../../src/android/handles.ts";
import { openInstall } from "../../src/shell/install.ts";
import { exercise, same, vectorProbeLines } from "./harness.ts";

// An attached window's root RenderNode and its AnimationHost, made as RenderNode.create(name, host)
// would make them but without a constructor: what AOSP's animators target and check is attached.
const HOST = "android/graphics/RenderNode$AnimationHost";
rt.register({ name: "webdroid/WindowAnimationHost", ctor: class extends JObj {}, ifaces: [HOST], methods: {
  "isAttached()Z": () => 1,
  // these animators run from the frame loop once started, wherever they were registered
  "registerAnimatingRenderNode(Landroid/graphics/RenderNode;Landroid/animation/Animator;)V": () => {},
  "registerVectorDrawableAnimator(Landroid/view/NativeVectorDrawableAnimator;)V": () => {},
} });
function windowRoot(): JObj {
  const n = rt.make("android/graphics/RenderNode") as JObj & Record<string, unknown>;
  n[declaredField("android/graphics/RenderNode", "mNativeRenderNode")] = handle(new NativeRenderNode("window"));
  n[declaredField("android/graphics/RenderNode", "mAnimationHost")] = rt.make("webdroid/WindowAnimationHost");
  return n;
}

// The resource natives, under AOSP's own Resources: the framework and an app installed as the
// package registry installs them, loaded through ApkAssets into an AssetManager, then read
// through Resources, Theme, TypedArray and XmlBlock as an app reads them.
if (existsSync("vendor/aosp/framework-res.apk") && existsSync("apks/FitNotes.apk")) {
  const read = (p: string) => new Uint8Array(readFileSync(p));
  installFramework(read("vendor/aosp/framework-res.apk"));
  const app = openInstall(read("apks/FitNotes.apk"));
  const appTable = new Arsc(app.zip["resources.arsc"], (path: string) => app.zip[path] ?? null);
  const manifest = parseAXML(app.zip["AndroidManifest.xml"]);
  const pkg = manifest.attrs.find((a) => a.name === "package")!.str!;
  packages.set(pkg, new PackageRecord(manifest, new Resources(appTable, app.zip, app.lazyEntries), "/data/app/base.apk", 10001, async () => []));
  const appTheme = manifest.children.find((n) => n.name === "application")!.attrs.find((a) => a.name === "theme")!.data;

  const S = "Ljava/lang/String;", T = "Landroid/content/res/Resources$Theme;";
  let res: unknown = null, theme: unknown = null;
  const id = (name: string, type: string, p: string): Promise<number> => vcall(res, "getIdentifier", `(${S}${S}${S})I`, name, type, p);
  await exercise("ApkAssets + AssetManager.Builder + Resources", async () => {
    const apk = await scall("android/content/res/ApkAssets", "loadFromPath", `(${S})Landroid/content/res/ApkAssets;`, "/data/app/base.apk");
    const builder = await newObj("android/content/res/AssetManager$Builder", "()V");
    await vcall(builder, "addApkAssets", "(Landroid/content/res/ApkAssets;)Landroid/content/res/AssetManager$Builder;", apk);
    const am = await vcall(builder, "build", "()Landroid/content/res/AssetManager;");
    const config = await newObj("android/content/res/Configuration", "()V");
    await vcall(config, "setToDefaults", "()V");
    res = await newObj("android/content/res/Resources", "(Landroid/content/res/AssetManager;Landroid/util/DisplayMetrics;Landroid/content/res/Configuration;)V",
      am, await newObj("android/util/DisplayMetrics", "()V"), config);
    theme = await vcall(res, "newTheme", `()${T}`);
    await vcall(theme, "applyStyle", "(IZ)V", appTheme, 1);
  });
  await exercise("Resources.getString (app and framework cookies)", async () => {
    same("app_name", await vcall(res, "getString", `(I)${S}`, await id("app_name", "string", pkg)), "FitNotes");
    same("android:ok", await vcall(res, "getString", `(I)${S}`, await id("ok", "string", "android")), "OK");
  });
  await exercise("Resources.getQuantityString (PluralRules over a bag)", async () => {
    const plural = appTable.findId("plurals", "exercise");
    same("one", await vcall(res, "getQuantityString", `(II)${S}`, plural, 1), appTable.values.get(appTable.entry(plural)!.bag!.map.find((e) => e[0] === 0x01000006)![2]));
    same("other", await vcall(res, "getQuantityString", `(II)${S}`, plural, 2), appTable.values.get(appTable.entry(plural)!.bag!.map.find((e) => e[0] === 0x01000004)![2]));
  });
  await exercise("Theme.obtainStyledAttributes (ApplyStyle over the theme)", async () => {
    const attrs = Int32Array.of(await id("colorBackground", "attr", "android"), await id("windowActionBar", "attr", "android"));
    const ta = await vcall(theme, "obtainStyledAttributes", "([I)Landroid/content/res/TypedArray;", attrs);
    const tv = await newObj("android/util/TypedValue", "()V");
    same("resolveAttribute", await vcall(theme, "resolveAttribute", "(ILandroid/util/TypedValue;Z)Z", attrs[0], tv, 1), 1);
    same("colorBackground", await vcall(ta, "getColor", "(II)I", 0, 7), (tv as Record<string, number>)[declaredField("android/util/TypedValue", "data")]);
    same("indices", await vcall(ta, "getIndexCount", "()I"), 2);
    await vcall(ta, "recycle", "()V");
  });
  await exercise("Resources.getLayout (XmlBlock walk, attribute strings from the block pool)", async () => {
    const parser = await vcall(res, "getLayout", "(I)Landroid/content/res/XmlResourceParser;", await id("activity_main", "layout", pkg));
    const tags: string[] = [];
    for (let ev = await vcall(parser, "next", "()I"); ev !== 1; ev = await vcall(parser, "next", "()I")) {
      if (ev !== 2) continue;
      tags.push(await vcall(parser, "getName", `()${S}`));
      // an XML string attribute comes back through the block's pool, cookie -1
      const ta = await vcall(res, "obtainAttributes", "(Landroid/util/AttributeSet;[I)Landroid/content/res/TypedArray;", parser, Int32Array.of(0x01010003));
      if (tags.length === 2) same("fragment android:name", await vcall(ta, "getString", `(I)${S}`, 0), "com.github.jamesgay.fitnotes.feature.home.datenavigation.DateNavigationFragment");
      await vcall(ta, "recycle", "()V");
    }
    same("tags", tags.join(","), "LinearLayout,fragment,androidx.viewpager.widget.ViewPager,ViewStub");
  });
  await exercise("Resources.getColorStateList (inflated from XML by ColorStateList)", async () => {
    const csl = await vcall(res, "getColorStateList", `(I${T})Landroid/content/res/ColorStateList;`, await id("primary_text_dark", "color", "android"), theme);
    same("default", await vcall(csl, "getDefaultColor", "()I"), -1);
  });
  await exercise("VectorDrawable: inflated tree, node properties, mutate, AnimatedVectorDrawable run (device values)", async () => {
    const d = await vcall(res, "getDrawable", `(I${T})Landroid/graphics/drawable/Drawable;`, await id("btn_checkbox_checked_mtrl", "drawable", "android"), theme);
    same("opacity", await vcall(d, "getOpacity", "()I"), -3);
    const targets = new Map(vectorProbeLines("target").map((l) => { const [name, ...v] = l.split(" "); return [name, v.map(Number)]; }));
    const read = async (v: unknown) => {
      const group = iof(v, "android/graphics/drawable/VectorDrawable$VGroup");
      const getters = group ? ["Rotation", "PivotX", "PivotY", "ScaleX", "ScaleY", "TranslateX", "TranslateY"]
        : ["StrokeWidth", "StrokeColor", "StrokeAlpha", "FillColor", "FillAlpha", "TrimPathStart", "TrimPathEnd", "TrimPathOffset"];
      return Promise.all(getters.map((g) => vcall(v, "get" + g, g.endsWith("Color") ? "()I" : "()F")));
    };
    for (const [name, want] of targets) {
      const got = (await read(await vcall(d, "getTargetByName", "(Ljava/lang/String;)Ljava/lang/Object;", name))).map((x: number) => Number.isInteger(x) ? x : +x.toPrecision(6));
      same(`target ${name}`, got.join(" "), want.join(" "));
    }
    // a mutated copy is a tree of its own: its changes stay out of the original
    const copy = await vcall(await vcall(d, "getConstantState", "()Landroid/graphics/drawable/Drawable$ConstantState;"), "newDrawable", "()Landroid/graphics/drawable/Drawable;");
    await vcall(copy, "mutate", "()Landroid/graphics/drawable/Drawable;");
    const path = await vcall(copy, "getTargetByName", "(Ljava/lang/String;)Ljava/lang/Object;", "check_path_merged");
    await vcall(path, "setTrimPathEnd", "(F)V", 0.5);
    same("copy trim", await vcall(path, "getTrimPathEnd", "()F"), 0.5);
    same("original trim", await vcall(await vcall(d, "getTargetByName", "(Ljava/lang/String;)Ljava/lang/Object;", "check_path_merged"), "getTrimPathEnd", "()F"), 1);
    // checked to unchecked on the render thread's animators, stepped as frames would step them:
    // the check fades out as the box's inner square fades in
    const avd = await vcall(res, "getDrawable", `(I${T})Landroid/graphics/drawable/Drawable;`, await id("btn_checkbox_checked_to_unchecked_mtrl_animation", "drawable", "android"), theme);
    const field = (o: unknown, cls: string, name: string) => (o as Record<string, any>)[declaredField(cls, name)];
    const A = "android/graphics/drawable/AnimatedVectorDrawable";
    const vector = field(field(avd, A, "mAnimatedVectorState"), `${A}$AnimatedVectorDrawableState`, "mVectorDrawable");
    const target = (name: string) => vcall(vector, "getTargetByName", "(Ljava/lang/String;)Ljava/lang/Object;", name);
    await vcall(avd, "start", "()V");
    // what a draw on an attached window's RecordingCanvas would record, which starts the animation
    const canvas = rt.make("android/graphics/RecordingCanvas");
    (canvas as Record<string, unknown>)[declaredField("android/graphics/RecordingCanvas", "mNode")] = windowRoot();
    await vcall(field(avd, A, "mAnimatorSet"), "onDraw", "(Landroid/graphics/Canvas;)V", canvas);
    same("running", await vcall(avd, "isRunning", "()Z"), 1);
    animateRenderThread(1000);
    same("check alpha at start", await vcall(await target("check_path_merged"), "getFillAlpha", "()F"), 1);
    animateRenderThread(1166);
    const scale = await vcall(await target("icon_null"), "getScaleX", "()F");
    if (!(scale < 0.2 && scale > 0.18)) throw new Error(`icon scale at 166 ms: ${scale}`);
    animateRenderThread(1600);
    same("check alpha at end", await vcall(await target("check_path_merged"), "getFillAlpha", "()F"), 0);
    same("box alpha at end", await vcall(await target("box_inner_merged"), "getFillAlpha", "()F"), 1);
    same("icon scale at end", Math.fround(await vcall(await target("icon_null"), "getScaleX", "()F")), Math.fround(0.2));
    same("stepping on", animateRenderThread(1616), false);
  });
  await exercise("AssetManager.list (the framework's assets under the app's)", async () => {
    const am = await vcall(res, "getAssets", "()Landroid/content/res/AssetManager;");
    const names: string[] = [...await vcall(am, "list", `(${S})[${S}`, "")];
    for (const dir of ["geoid_map", "images", "webkit"]) if (!names.includes(dir)) throw new Error(`list("") lacks ${dir}: ${names}`);
    same("images/", [...await vcall(am, "list", `(${S})[${S}`, "images")].join(","), "android-logo-mask.png,android-logo-shine.png,clock_font.png,progress_font.png");
  });
}
