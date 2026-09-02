// android.app.Dialog / AlertDialog rendered as overlays (scrim + centered card).

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { vcall } from "../jvm/natives/jlang";
import { JView, JFrameLP, JLinearLP, attachView, requestLayout, AID, measureView, layoutView, makeSpec, MS_EXACTLY, MS_AT_MOST, specSize, findById, guardCall } from "./view";
import { JFrameLayout, JLinearLayout, JTextView, themeAccent } from "./widget";
import { JCanvas, tfMedium } from "./graphics";
import { JDrawable, loadDrawableRV } from "./drawable";
import { addOverlay, removeOverlay } from "./popup";
import { reportUncaught } from "./os";
import { rvString, JTheme } from "./res";
import { TV } from "./axml";
import { inflateLayout, getInflater } from "./inflate";
import { csText } from "./text";

const M_drawableDraw = mangleMethod("draw", "(Landroid/graphics/Canvas;)V");

/**
 * The dialog's theme: the host theme with the dialog style layered on top — the explicit
 * one passed to Dialog(Context, int) if there is one, else the host theme's own dialogTheme.
 * Without this every dialog inherited the activity's window background (and we painted a
 * hardcoded white card instead).
 */
function dialogTheme(host: any, themeId: number): JTheme | null {
  const base: JTheme | null = host?.theme ?? null;
  if (!base) return null;
  let styleId = themeId;
  if (!styleId) {
    const rv = base.lookup(AID("dialogTheme"));
    styleId = rv && rv.t === TV.REFERENCE ? rv.d : 0;
  }
  if (!styleId) return base;
  const t = new JTheme();
  t.res = base.res;
  t.styles = [...base.styles, styleId];
  return t;
}

async function loadCardBg(root: DialogRoot): Promise<void> {
  if (root.cardBg || !root.theme || !root.jres) return;
  const rv = root.theme.lookup(AID("windowBackground"));
  if (rv) root.cardBg = await loadDrawableRV(root.jres, rv, root.theme);
}

/** scrim + rounded card container drawn natively */
class DialogRoot extends JFrameLayout {
  dialog: JDialog | null = null;
  cardTop = 0; cardLeft = 0; cardW = 0; cardH = 0;
  /** the dialog window's own background, from its theme — not a hardcoded white card */
  cardBg: JDrawable | null = null;
}
rt.register({
  name: "webdroid/DialogRoot", ctor: DialogRoot, sup: "android/widget/FrameLayout",
  methods: {
    "onMeasure(II)V": async function (this: DialogRoot, wSpec: number, hSpec: number) {
      this.measuredW = specSize(wSpec);
      this.measuredH = specSize(hSpec);
      const c = this.children[0];
      if (c && c.visibility !== 8) {
        const maxW = Math.min(this.measuredW - 96, 640);
        const availH = this.measuredH - 200;
        await measureView(c, makeSpec(maxW, c.lp?.width === -1 ? MS_EXACTLY : (MS_AT_MOST | 0)), makeSpec(availH, MS_AT_MOST | 0));
        this.cardW = Math.max(560, c.measuredW);
        if (c.lp?.width === -1) this.cardW = maxW;
        await measureView(c, makeSpec(this.cardW, MS_EXACTLY), makeSpec(availH, MS_AT_MOST | 0));
        this.cardH = c.measuredH;
        this.cardLeft = (this.measuredW - this.cardW) >> 1;
        this.cardTop = (this.measuredH - this.cardH) >> 1;
      }
    },
    "onLayout(ZIIII)V": async function (this: DialogRoot) {
      const c = this.children[0];
      if (c && c.visibility !== 8) {
        await layoutView(c, this.cardLeft, this.cardTop, this.cardLeft + this.cardW, this.cardTop + this.cardH);
      }
    },
    "onDraw(Landroid/graphics/Canvas;)V": async function (this: DialogRoot, cv: JCanvas) {
      const ctx = cv.ctx;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, this.width(), this.height());
      // card shadow + bg
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.45)";
      ctx.shadowBlur = 40;
      ctx.shadowOffsetY = 12;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.roundRect(this.cardLeft, this.cardTop, this.cardW, this.cardH, 6);
      ctx.fill();
      ctx.restore();
      // The window background comes from the dialog's theme; the white fill above only
      // exists so the drop shadow has a shape to cast from.
      if (this.cardBg) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(this.cardLeft, this.cardTop, this.cardW, this.cardH, 6);
        ctx.clip();
        const b = this.cardBg.bounds;
        b.left = this.cardLeft; b.top = this.cardTop;
        b.right = this.cardLeft + this.cardW; b.bottom = this.cardTop + this.cardH;
        await guardCall((this.cardBg as any)[M_drawableDraw], this.cardBg, cv);
        ctx.restore();
      }
    },
    "onTouchEvent(Landroid/view/MotionEvent;)Z": async function (this: DialogRoot, ev: any) {
      if ((ev.action & 0xff) === 1 &&
        (ev.x < this.cardLeft || ev.x > this.cardLeft + this.cardW || ev.y < this.cardTop || ev.y > this.cardTop + this.cardH)) {
        if (this.dialog?.cancelable) await this.dialog?.cancel();
      }
      return 1;
    },
  },
});

class JDialog extends JObj {
  jctx: any = null;
  root: DialogRoot | null = null;
  content: JView | null = null;
  titleStr: string | null = null;
  themeId = 0;
  showing = false;
  cancelable = true;
  cancelL: unknown = null;
  dismissL: unknown = null;
  showL: unknown = null;
  async dismissImpl() {
    if (!this.showing) return;
    this.showing = false;
    if (this.root) removeOverlay(this.root);
    if (this.dismissL) {
      try { await vcall(this.dismissL, "onDismiss", "(Landroid/content/DialogInterface;)V", this); } catch (e) { reportUncaught(e); }
    }
  }
  async cancel() {
    if (this.cancelL) {
      try { await vcall(this.cancelL, "onCancel", "(Landroid/content/DialogInterface;)V", this); } catch (e) { reportUncaught(e); }
    }
    await this.dismissImpl();
  }
  ensureRoot(): DialogRoot {
    if (!this.root) {
      this.root = new DialogRoot();
      this.root.dialog = this;
      this.root.ctx = this.jctx;
      this.root.jres = this.jctx?.$host?.res ?? null;
      this.root.theme = dialogTheme(this.jctx?.$host, this.themeId);
    }
    return this.root;
  }
}
/** A title/message/button text arrives as a resource id or any CharSequence (a Spanned from
 *  Html.fromHtml, an app class); everything resolves to one string here. */
async function str(host: any, v: unknown): Promise<string> {
  if (typeof v === "number") return host ? rvString(host.res, host.res.resolveRefs({ t: TV.REFERENCE, d: v })) ?? "" : "";
  return csText(v);
}
async function setDialogTitle(this: JDialog, t: unknown) { this.titleStr = await str(this.jctx?.$host, t); }
function setButton(d: JAlertDialog, which: number, text: string, l: unknown) {
  if (which === -1) { d.posText = text; d.posL = l; }
  else if (which === -2) { d.negText = text; d.negL = l; }
  else { d.neutText = text; d.neutL = l; }
}
const dialogMethods: NonNullable<NativeSpec["methods"]> = {
  "getOnBackInvokedDispatcher()Landroid/window/OnBackInvokedDispatcher;": () => {
    const i = rt.link("android/window/OnBackInvokedDispatcher");
    return new i.ctor();
  },
  "<init>(Landroid/content/Context;)V": function (this: JDialog, c: unknown) { this.jctx = c; },
  "<init>(Landroid/content/Context;I)V": function (this: JDialog, c: unknown, themeId: number) {
    this.jctx = c;
    this.themeId = themeId | 0;
  },
  "<init>(Landroid/content/Context;ZLandroid/content/DialogInterface$OnCancelListener;)V": function (this: JDialog, c: unknown, canc: number, l: unknown) {
    this.jctx = c;
    this.cancelable = !!canc;
    this.cancelL = l;
  },
  "getContext()Landroid/content/Context;": function (this: JDialog) { return this.jctx; },
  "setContentView(I)V": async function (this: JDialog, layoutId: number) {
    const root = this.ensureRoot();
    root.children.length = 0;
    await inflateLayout(this.jctx, layoutId, root, true);
    requestLayout();
  },
  "setContentView(Landroid/view/View;)V": function (this: JDialog, v: JView) {
    const root = this.ensureRoot();
    root.children.length = 0;
    if (!v.lp) {
      const lp = new JFrameLP();
      lp.width = -2; lp.height = -2;
      v.lp = lp;
    }
    attachView(root, v);
    requestLayout();
  },
  "setContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": function (this: JDialog, v: JView, lp: any) {
    v.lp = lp;
    (dialogMethods["setContentView(Landroid/view/View;)V"] as any).call(this, v);
  },
  "show()V": async function (this: JDialog) {
    if (this.showing) return;
    this.showing = true;
    const root = this.ensureRoot();
    await loadCardBg(root);
    addOverlay(root, 0, 0, false, () => vcall(this, "onBackPressed", "()V"));
    const M_onCreate = mangleMethod("onCreate", "(Landroid/os/Bundle;)V");
    const f = (this as any)[M_onCreate];
    if (f && !(this as any).$created) {
      (this as any).$created = true;
      try {
        const r = f.call(this, null);
        if (r instanceof Promise) await r;
      } catch (e) { reportUncaught(e); }
    }
    if (this.showL) {
      try { await vcall(this.showL, "onShow", "(Landroid/content/DialogInterface;)V", this); } catch (e) { reportUncaught(e); }
    }
    requestLayout();
  },
  "onCreate(Landroid/os/Bundle;)V": function () {},
  "onStart()V": function () {},
  "onStop()V": function () {},
  "hide()V": function (this: JDialog) { if (this.root) this.root.visibility = 4; },
  "dismiss()V": function (this: JDialog) { return this.dismissImpl(); },
  "cancel()V": function (this: JDialog) { return this.cancel(); },
  "isShowing()Z": function (this: JDialog) { return this.showing ? 1 : 0; },
  "setTitle(Ljava/lang/CharSequence;)V": setDialogTitle,
  "setTitle(I)V": setDialogTitle,
  "setCancelable(Z)V": function (this: JDialog, c: number) { this.cancelable = !!c; },
  "setCanceledOnTouchOutside(Z)V": function (this: JDialog, c: number) { this.cancelable = !!c; },
  "setOnCancelListener(Landroid/content/DialogInterface$OnCancelListener;)V": function (this: JDialog, l: unknown) { this.cancelL = l; },
  "setOnDismissListener(Landroid/content/DialogInterface$OnDismissListener;)V": function (this: JDialog, l: unknown) { this.dismissL = l; },
  "setOnShowListener(Landroid/content/DialogInterface$OnShowListener;)V": function (this: JDialog, l: unknown) { this.showL = l; },
  "setOnKeyListener(Landroid/content/DialogInterface$OnKeyListener;)V": () => {},
  "findViewById(I)Landroid/view/View;": async function (this: JDialog, id: number) {
    return this.root ? findById(this.root, id) : null;
  },
  "getWindow()Landroid/view/Window;": async function (this: JDialog) {
    const info = rt.link("android/view/Window");
    const w = new info.ctor();
    w.decor = this.root;
    return w;
  },
  "requestWindowFeature(I)Z": () => 1,
  "getLayoutInflater()Landroid/view/LayoutInflater;": async function (this: JDialog) {
    return getInflater(this.jctx);
  },
  "getOwnerActivity()Landroid/app/Activity;": function (this: JDialog) { return this.jctx; },
  "setOwnerActivity(Landroid/app/Activity;)V": () => {},
  "getCurrentFocus()Landroid/view/View;": () => null,
  "dispatchTouchEvent(Landroid/view/MotionEvent;)Z": () => 0,
  "onBackPressed()V": function (this: JDialog) { if (this.cancelable) return this.cancel(); },
  "create()V": function () {},
};
rt.register({
  name: "android/app/Dialog", ctor: JDialog,
  ifaces: ["android/content/DialogInterface", "android/view/Window$Callback"],
  methods: dialogMethods,
});
rt.register({ name: "android/content/DialogInterface", ctor: class extends JObj {},
  statics: { BUTTON_POSITIVE: -1, BUTTON_NEGATIVE: -2, BUTTON_NEUTRAL: -3 } });
// pure callback interfaces — apps implement these; dispatch is by mangled name (see vcall)
for (const n of ["OnClickListener", "OnCancelListener", "OnDismissListener", "OnKeyListener"]) {
  rt.register({ name: "android/content/DialogInterface$" + n, ctor: class extends JObj {} });
}

// ── AlertDialog: builds its own material-style content
export class JAlertDialog extends JDialog {
  message: string | null = null;
  posText: string | null = null; posL: unknown = null;
  negText: string | null = null; negL: unknown = null;
  neutText: string | null = null; neutL: unknown = null;
  items: string[] | null = null;
  itemsL: unknown = null;
  customView: JView | null = null;
  built = false;
}
async function buildAlertContent(d: JAlertDialog) {
  const col = new JLinearLayout();
  col.orientation = 1;
  col.ctx = d.jctx;
  col.jres = d.jctx?.$host?.res ?? null;
  col.theme = d.jctx?.$host?.theme ?? null;
  // AOSP's alert layout weights the message and custom panels so an overflowing body shrinks
  // and the button bar keeps its height
  const lpFill = (weight = 0) => {
    const lp = new JLinearLP();
    lp.width = -1; lp.height = -2; lp.weight = weight;
    return lp;
  };
  const accent = themeAccent(col);
  if (d.titleStr) {
    const t = new JTextView();
    t.ctx = d.jctx; t.jres = col.jres; t.theme = col.theme;
    t.text = d.titleStr;
    t.paintT.textSize = 40;
    t.paintT.tf = tfMedium;
    t.colors.defColor = -13421773;
    t.padL = 48; t.padR = 48; t.padT = 44; t.padB = 8;
    t.lp = lpFill();
    attachView(col, t);
  }
  if (d.message) {
    const t = new JTextView();
    t.ctx = d.jctx; t.jres = col.jres; t.theme = col.theme;
    t.text = d.message;
    t.paintT.textSize = 32;
    t.colors.defColor = -10066330;
    t.padL = 48; t.padR = 48; t.padT = d.titleStr ? 16 : 44; t.padB = 20;
    t.lp = lpFill(1);
    attachView(col, t);
  }
  if (d.customView) {
    d.customView.lp = lpFill(1);
    attachView(col, d.customView);
  }
  if (d.items) {
    for (let i = 0; i < d.items.length; i++) {
      const t = new JTextView();
      t.ctx = d.jctx; t.jres = col.jres; t.theme = col.theme;
      t.text = d.items[i];
      t.paintT.textSize = 32;
      t.colors.defColor = -13421773;
      t.padL = 48; t.padR = 48; t.padT = 28; t.padB = 28;
      t.clickable = true;
      t.lp = lpFill();
      const idx = i;
      (t as any).clickL = {
        [mangleMethod("onClick", "(Landroid/view/View;)V")]: async () => {
          // AOSP: the listener runs first; the DISMISS message is queued behind it
          if (d.itemsL) await vcall(d.itemsL, "onClick", "(Landroid/content/DialogInterface;I)V", d, idx);
          await d.dismissImpl();
        },
      };
      attachView(col, t);
    }
  }
  if (d.posText || d.negText || d.neutText) {
    const row = new JLinearLayout();
    row.orientation = 0;
    row.gravity = 5 | 16;
    row.ctx = d.jctx; row.jres = col.jres; row.theme = col.theme;
    row.padL = 24; row.padR = 24; row.padT = 8; row.padB = 8;
    row.lp = lpFill();
    const mkBtn = (text: string, which: number, l: unknown) => {
      const b = new JTextView();
      b.ctx = d.jctx; b.jres = col.jres; b.theme = col.theme;
      b.text = text.toUpperCase();
      b.paintT.textSize = 30;
      b.paintT.tf = tfMedium;
      b.colors.defColor = accent;
      b.padL = 32; b.padR = 32; b.padT = 24; b.padB = 24;
      b.clickable = true;
      const lp = new JLinearLP();
      lp.width = -2; lp.height = -2;
      b.lp = lp;
      (b as any).clickL = {
        [mangleMethod("onClick", "(Landroid/view/View;)V")]: async () => {
          if (l) await vcall(l, "onClick", "(Landroid/content/DialogInterface;I)V", d, which);
          await d.dismissImpl();
        },
      };
      attachView(row, b);
    };
    if (d.neutText) mkBtn(d.neutText, -3, d.neutL);
    if (d.negText) mkBtn(d.negText, -2, d.negL);
    if (d.posText) mkBtn(d.posText, -1, d.posL);
    attachView(col, row);
  }
  const root = d.ensureRoot();
  root.children.length = 0;
  col.lp = new JFrameLP();
  (col.lp as JFrameLP).width = -1;
  (col.lp as JFrameLP).height = -2;
  attachView(root, col);
}
const alertMethods: NativeSpec["methods"] = {
  ...dialogMethods,
  "show()V": async function (this: JAlertDialog) {
    if (!this.built && !this.root?.children.length) {
      this.built = true;
      await buildAlertContent(this);
    }
    await (dialogMethods["show()V"] as any).call(this);
  },
  "setMessage(Ljava/lang/CharSequence;)V": async function (this: JAlertDialog, m: unknown) { this.message = await str(this.jctx?.$host, m); },
  "setView(Landroid/view/View;)V": function (this: JAlertDialog, v: JView) { this.customView = v; },
  "setButton(ILjava/lang/CharSequence;Landroid/content/DialogInterface$OnClickListener;)V":
    async function (this: JAlertDialog, which: number, t: unknown, l: unknown) { setButton(this, which, await str(this.jctx?.$host, t), l); },
  "getButton(I)Landroid/widget/Button;": () => null,
  "getListView()Landroid/widget/ListView;": () => null,
};
rt.register({ name: "android/app/AlertDialog", ctor: JAlertDialog, sup: "android/app/Dialog", methods: alertMethods });

class JAlertBuilder extends JObj {
  d = new JAlertDialog();
}
async function builderTitle(this: JAlertBuilder, t: unknown) { this.d.titleStr = await str(this.d.jctx?.$host, t); return this; }
async function builderMessage(this: JAlertBuilder, m: unknown) { this.d.message = await str(this.d.jctx?.$host, m); return this; }
const builderMethods: NativeSpec["methods"] = {
  "<init>(Landroid/content/Context;)V": function (this: JAlertBuilder, c: unknown) { this.d.jctx = c; },
  "<init>(Landroid/content/Context;I)V": function (this: JAlertBuilder, c: unknown) { this.d.jctx = c; },
  "setTitle(Ljava/lang/CharSequence;)Landroid/app/AlertDialog$Builder;": builderTitle,
  "setTitle(I)Landroid/app/AlertDialog$Builder;": builderTitle,
  "setMessage(Ljava/lang/CharSequence;)Landroid/app/AlertDialog$Builder;": builderMessage,
  "setMessage(I)Landroid/app/AlertDialog$Builder;": builderMessage,
  "setView(Landroid/view/View;)Landroid/app/AlertDialog$Builder;": function (this: JAlertBuilder, v: JView) {
    this.d.customView = v;
    return this;
  },
  "setView(I)Landroid/app/AlertDialog$Builder;": async function (this: JAlertBuilder, id: number) {
    this.d.customView = await inflateLayout(this.d.jctx, id, null, false) as JView | null;
    return this;
  },
  "setCancelable(Z)Landroid/app/AlertDialog$Builder;": function (this: JAlertBuilder, c: number) {
    this.d.cancelable = !!c;
    return this;
  },
  "setOnCancelListener(Landroid/content/DialogInterface$OnCancelListener;)Landroid/app/AlertDialog$Builder;":
    function (this: JAlertBuilder, l: unknown) { this.d.cancelL = l; return this; },
  "setOnDismissListener(Landroid/content/DialogInterface$OnDismissListener;)Landroid/app/AlertDialog$Builder;":
    function (this: JAlertBuilder, l: unknown) { this.d.dismissL = l; return this; },
  "setIcon(I)Landroid/app/AlertDialog$Builder;": function (this: JAlertBuilder) { return this; },
  "create()Landroid/app/AlertDialog;": function (this: JAlertBuilder) { return this.d; },
  "show()Landroid/app/AlertDialog;": async function (this: JAlertBuilder) {
    await (alertMethods["show()V"] as any).call(this.d);
    return this.d;
  },
};
for (const [name, which] of [["Positive", -1], ["Negative", -2], ["Neutral", -3]] as const) {
  const set = async function (this: JAlertBuilder, t: unknown, l: unknown) {
    setButton(this.d, which, await str(this.d.jctx?.$host, t), l);
    return this;
  };
  builderMethods[`set${name}Button(Ljava/lang/CharSequence;Landroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;`] = set;
  builderMethods[`set${name}Button(ILandroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;`] = set;
}
builderMethods["setItems([Ljava/lang/CharSequence;Landroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;"] =
  async function (this: JAlertBuilder, items: unknown[], l: unknown) {
    this.d.items = await Promise.all((items ?? []).map((i) => csText(i)));
    this.d.itemsL = l;
    return this;
  };
builderMethods["setAdapter(Landroid/widget/ListAdapter;Landroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;"] =
  async function (this: JAlertBuilder, adapter: unknown, l: unknown) {
    const n = await vcall(adapter, "getCount", "()I");
    const items: string[] = [];
    for (let i = 0; i < n; i++) {
      items.push(await csText(await vcall(adapter, "getItem", "(I)Ljava/lang/Object;", i)));
    }
    this.d.items = items;
    this.d.itemsL = l;
    return this;
  };
rt.register({ name: "android/app/AlertDialog$Builder", ctor: JAlertBuilder, methods: builderMethods });
rt.register({ name: "android/app/ProgressDialog", ctor: class extends JAlertDialog {}, sup: "android/app/AlertDialog",
  methods: {
    "getOnBackInvokedDispatcher()Landroid/window/OnBackInvokedDispatcher;": () => {
      const i = rt.link("android/window/OnBackInvokedDispatcher");
      return new i.ctor();
    },
    ...alertMethods,
    "setIndeterminate(Z)V": () => {},
    "setProgressStyle(I)V": () => {},
    "static show(Landroid/content/Context;Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Landroid/app/ProgressDialog;":
      async (c: any, t: unknown, m: unknown) => {
        const d = new (rt.link("android/app/ProgressDialog").ctor)();
        d.jctx = c;
        d.titleStr = await str(c?.$host, t);
        d.message = await str(c?.$host, m);
        await (alertMethods["show()V"] as any).call(d);
        return d;
      },
  } });
