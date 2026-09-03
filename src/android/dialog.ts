// android.app.Dialog / AlertDialog rendered as overlays (scrim + centered card).

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { vcall } from "../jvm/natives/jlang";
import { JView, JFrameLP, JLinearLP, attachView, requestLayout, AID, measureView, layoutView, makeSpec, MS_EXACTLY, MS_AT_MOST, specSize, findById, guardCall, dispatchAttached, dispatchDetached } from "./view";
import { JFrameLayout, JLinearLayout, JTextView, themeAccent } from "./widget";
import { JCanvas, tfMedium , JRect } from "./graphics";
import { JDrawable, loadDrawableRV } from "./drawable";
import { addOverlay, removeOverlay } from "./popup";
import { reportUncaught } from "./os";
import { rvString, rvInt, rvFloat, rvDimen, themeOf, JTheme } from "./res";
import { TV } from "./axml";
import { device } from "../shell/config";
import { inflateLayout, getInflater } from "./inflate";
import { csText } from "./text";
import type { JWindow } from "./app";

const M_drawableDraw = mangleMethod("draw", "(Landroid/graphics/Canvas;)V");
const M_getPadding = mangleMethod("getPadding", "(Landroid/graphics/Rect;)Z");

/**
 * The dialog's theme: the host theme with the dialog style layered on top — the explicit
 * one passed to Dialog(Context, int) if there is one, else the host theme's own dialogTheme.
 * Without this every dialog inherited the activity's window background (and we painted a
 * hardcoded white card instead).
 */
/** Dialog(Context, theme): the window theme layers the explicit style (else the context theme's
 *  dialogTheme) over the CONTEXT's theme — a ContextThemeWrapper's own, not the application's. */
function dialogTheme(ctx: any, themeId: number): JTheme | null {
  const base: JTheme | null = themeOf(ctx);
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
  root.cardRadius = rvDimen(root.jres, root.theme.lookup(AID("dialogCornerRadius")), 0);
  // PhoneWindow: backgroundDimEnabled defaults to windowIsFloating (attrs.xml), so an
  // edge-to-edge sheet theme that only unfloats its window loses the platform dim and
  // draws its own scrim; backgroundDimAmount says how much.
  const en = root.theme.lookup(AID("backgroundDimEnabled"));
  const floating = root.theme.lookup(AID("windowIsFloating"));
  const dimOn = en ? !!rvInt(root.jres, en, 0) : !!rvInt(root.jres, floating, 1);
  root.themeDim = dimOn ? rvFloat(root.jres, root.theme.lookup(AID("backgroundDimAmount")), 0.6) : 0;
}

/** the dialog window: scrim, then the window frame sized/placed by the window's layout params */
class DialogRoot extends JFrameLayout {
  /**
   * Padding of an app-supplied window background, left/top/right/bottom. Material's alert
   * dialog hands the window an InsetDrawable — the card it paints is inset from the window —
   * so the content has to sit inside that inset or it spills outside the card. AOSP takes a
   * decor's padding from its background for exactly this reason.
   */
  bgPad: [number, number, number, number] = [0, 0, 0, 0];
  async readBgPadding() {
    const win = this.dialog?.win;
    const bg = win?.bgSet ? win.bg : null;
    if (!bg) { this.bgPad = [0, 0, 0, 0]; return; }
    const r = new JRect();
    await guardCall((bg as unknown as Record<string, unknown>)[M_getPadding], bg, r);
    this.bgPad = [r.left, r.top, r.right, r.bottom];
  }
  dialog: JDialog | null = null;
  /** the window's android.R.id.content FrameLayout — appcompat finds it by id, reparents its
   *  children into a sub-decor and swaps the ids, exactly as it does to an activity window */
  content!: JFrameLayout;
  setContent(v: JView | null) {
    this.content.children.length = 0;
    if (v) attachView(this.content, v);
  }
  cardTop = 0; cardLeft = 0; cardW = 0; cardH = 0;
  /** the dialog window's own background, from its theme — not a hardcoded white card */
  cardBg: JDrawable | null = null;
  themeDim = 0.6;
  /** the theme's dialogCornerRadius: the frame's shape, and so the shadow's */
  cardRadius = 0;
}
const GRAV_TOP = 0x30, GRAV_BOTTOM = 0x50, GRAV_VMASK = 0x70;
rt.register({
  name: "webdroid/DialogRoot", ctor: DialogRoot, sup: "android/widget/FrameLayout",
  methods: {
    "onMeasure(II)V": async function (this: DialogRoot, wSpec: number, hSpec: number) {
      this.measuredW = specSize(wSpec);
      this.measuredH = specSize(hSpec);
      await this.readBgPadding();
      const c = this.children[0];
      if (c && c.visibility !== 8) {
        // WindowManager.LayoutParams: MATCH_PARENT fills the window, WRAP_CONTENT sizes to the content
        // within the platform dialog's margins and minimum width, a pixel size is exact.
        const win = this.dialog?.win;
        const lw = win?.layoutW ?? -2, lh = win?.layoutH ?? -2;
        const maxW = lw === -1 ? this.measuredW : Math.min(this.measuredW - device.dp(48), device.dp(320));
        const availH = lh === -1 ? this.measuredH : this.measuredH - device.dp(100);
        const wantW = lw === -1 || c.lp?.width === -1;
        await measureView(c, makeSpec(lw > 0 ? lw : maxW, wantW || lw > 0 ? MS_EXACTLY : (MS_AT_MOST | 0)),
          makeSpec(lh > 0 ? lh : availH, lh > 0 ? MS_EXACTLY : (MS_AT_MOST | 0)));
        this.cardW = lw === -1 || lw > 0 || wantW ? c.measuredW : Math.max(device.dp(280), c.measuredW);
        if (this.cardW !== c.measuredW) await measureView(c, makeSpec(this.cardW, MS_EXACTLY), makeSpec(availH, MS_AT_MOST | 0));
        this.cardH = c.measuredH + this.bgPad[1] + this.bgPad[3];
        this.cardW += this.bgPad[0] + this.bgPad[2];
        this.cardLeft = (this.measuredW - this.cardW) >> 1;
        const vg = (win?.gravity ?? 0) & GRAV_VMASK;
        this.cardTop = vg === GRAV_TOP ? 0 : vg === GRAV_BOTTOM ? this.measuredH - this.cardH : (this.measuredH - this.cardH) >> 1;
      }
    },
    "onLayout(ZIIII)V": async function (this: DialogRoot) {
      const c = this.children[0];
      if (c && c.visibility !== 8) {
        const [l, t, r, b] = this.bgPad;
        await layoutView(c, this.cardLeft + l, this.cardTop + t, this.cardLeft + this.cardW - r, this.cardTop + this.cardH - b);
      }
    },
    "onDraw(Landroid/graphics/Canvas;)V": async function (this: DialogRoot, cv: JCanvas) {
      const ctx = cv.ctx;
      const win = this.dialog?.win;
      const dim = win && !Number.isNaN(win.dimAmount) ? win.dimAmount : this.themeDim;
      if (dim > 0) {
        ctx.fillStyle = `rgba(0,0,0,${dim})`;
        ctx.fillRect(0, 0, this.width(), this.height());
      }
      // An explicit Window.setBackgroundDrawable replaces the theme's frame (Compose sets it
      // transparent and draws its own surface); only the platform frame casts a shadow.
      const bg = win?.bgSet ? win.bg : this.cardBg;
      const r = win?.bgSet ? 0 : this.cardRadius;
      if (!win?.bgSet) {
        // the frame's elevation shadow, cast from its own shape: an almost-transparent fill
        // paints the shadow without tinting the card, whose colour is the theme's to pick
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.45)";
        ctx.shadowBlur = device.dp(20);
        ctx.shadowOffsetY = device.dp(6);
        ctx.globalAlpha = 0.01;
        ctx.fillStyle = "#000";
        ctx.beginPath();
        ctx.roundRect(this.cardLeft, this.cardTop, this.cardW, this.cardH, r);
        ctx.fill();
        ctx.restore();
      }
      if (bg) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(this.cardLeft, this.cardTop, this.cardW, this.cardH, r);
        ctx.clip();
        const b = bg.bounds;
        b.left = this.cardLeft; b.top = this.cardTop;
        b.right = this.cardLeft + this.cardW; b.bottom = this.cardTop + this.cardH;
        await guardCall((bg as any)[M_drawableDraw], bg, cv);
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
  win: JWindow | null = null;
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
    if (this.root) {
      removeOverlay(this.root);
      await dispatchDetached(this.root);
      try { await vcall(this, "onStop", "()V"); } catch (e) { reportUncaught(e); }
    }
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
      const r = this.root = new DialogRoot();
      r.dialog = this;
      r.ctx = this.jctx;
      r.jres = this.jctx?.$host?.res ?? null;
      r.theme = dialogTheme(this.jctx, this.themeId);
      const c = r.content = new JFrameLayout();
      c.ctx = r.ctx; c.jres = r.jres; c.theme = r.theme;
      c.idNum = 0x01020002;
      const lp = new JFrameLP(); lp.width = -1; lp.height = -2; c.lp = lp;
      attachView(r, c);
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
    root.setContent(null);
    await inflateLayout(this.jctx, layoutId, root.content, true);
    requestLayout();
  },
  "setContentView(Landroid/view/View;)V": function (this: JDialog, v: JView) {
    const root = this.ensureRoot();
    if (!v.lp) {
      const lp = new JFrameLP();
      lp.width = -2; lp.height = -2;
      v.lp = lp;
    }
    root.setContent(v);
    requestLayout();
  },
  "setContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": function (this: JDialog, v: JView, lp: any) {
    v.lp = lp;
    (dialogMethods["setContentView(Landroid/view/View;)V"] as any).call(this, v);
  },
  "addContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": function (this: JDialog, v: JView, lp: any) {
    v.lp = lp;
    attachView(this.ensureRoot().content, v);
    requestLayout();
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
    try { await vcall(this, "onStart", "()V"); } catch (e) { reportUncaught(e); }
    // WindowManager.addView: the dialog's view tree attaches to its window here, which is what
    // lets a ComposeView in it find its ViewTree owners and actually compose its content.
    await dispatchAttached(root);
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
  // one Window per dialog, its callback the dialog itself (AOSP's ctor does w.setCallback(this)):
  // appcompat wraps that callback and rejects a null one
  "getWindow()Landroid/view/Window;": function (this: JDialog) {
    if (!this.win) {
      this.win = new (rt.link("android/view/Window").ctor as new () => JWindow)();
      this.win.callbackObj = this;
      this.win.dialog = this;
    }
    this.win.decor = this.ensureRoot();
    return this.win;
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
  // Window.Callback, as Dialog's defaults
  "onContentChanged()V": function () {},
  "onAttachedToWindow()V": function () {},
  "onDetachedFromWindow()V": function () {},
  "onWindowAttributesChanged(Landroid/view/WindowManager$LayoutParams;)V": function () {},
  "onWindowFocusChanged(Z)V": function () {},
  "onPanelClosed(ILandroid/view/Menu;)V": function () {},
  "onSearchRequested()Z": () => 0,
  "onSearchRequested(Landroid/view/SearchEvent;)Z": () => 0,
  "onCreatePanelView(I)Landroid/view/View;": () => null,
  "onCreatePanelMenu(ILandroid/view/Menu;)Z": () => 0,
  "onPreparePanel(ILandroid/view/View;Landroid/view/Menu;)Z": () => 1,
  "onMenuOpened(ILandroid/view/Menu;)Z": () => 1,
  "onMenuItemSelected(ILandroid/view/MenuItem;)Z": () => 0,
  "onActionModeStarted(Landroid/view/ActionMode;)V": function () {},
  "onActionModeFinished(Landroid/view/ActionMode;)V": function () {},
  "onWindowStartingActionMode(Landroid/view/ActionMode$Callback;)Landroid/view/ActionMode;": () => null,
  "onWindowStartingActionMode(Landroid/view/ActionMode$Callback;I)Landroid/view/ActionMode;": () => null,
  "dispatchKeyEvent(Landroid/view/KeyEvent;)Z": () => 0,
  "dispatchKeyShortcutEvent(Landroid/view/KeyEvent;)Z": () => 0,
  "dispatchTrackballEvent(Landroid/view/MotionEvent;)Z": () => 0,
  "dispatchGenericMotionEvent(Landroid/view/MotionEvent;)Z": () => 0,
  "dispatchPopulateAccessibilityEvent(Landroid/view/accessibility/AccessibilityEvent;)Z": () => 0,
  "onKeyDown(ILandroid/view/KeyEvent;)Z": () => 0,
  "onKeyUp(ILandroid/view/KeyEvent;)Z": () => 0,
  "onSaveInstanceState()Landroid/os/Bundle;": () => new (rt.link("android/os/Bundle").ctor)(),
  "onRestoreInstanceState(Landroid/os/Bundle;)V": function () {},
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
    t.paintT.textSize = device.dp(20);
    t.paintT.tf = tfMedium;
    t.colors.defColor = -13421773;
    t.padL = t.padR = device.dp(24); t.padT = device.dp(22); t.padB = device.dp(4);
    t.lp = lpFill();
    attachView(col, t);
  }
  if (d.message) {
    const t = new JTextView();
    t.ctx = d.jctx; t.jres = col.jres; t.theme = col.theme;
    t.text = d.message;
    t.paintT.textSize = device.dp(16);
    t.colors.defColor = -10066330;
    t.padL = t.padR = device.dp(24); t.padT = device.dp(d.titleStr ? 8 : 22); t.padB = device.dp(10);
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
      t.paintT.textSize = device.dp(16);
      t.colors.defColor = -13421773;
      t.padL = t.padR = device.dp(24); t.padT = t.padB = device.dp(14);
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
    row.padL = row.padR = device.dp(12); row.padT = row.padB = device.dp(4);
    row.lp = lpFill();
    const mkBtn = (text: string, which: number, l: unknown) => {
      const b = new JTextView();
      b.ctx = d.jctx; b.jres = col.jres; b.theme = col.theme;
      b.text = text.toUpperCase();
      b.paintT.textSize = device.dp(15);
      b.paintT.tf = tfMedium;
      b.colors.defColor = accent;
      b.padL = b.padR = device.dp(16); b.padT = b.padB = device.dp(12);
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
  col.lp = new JFrameLP();
  (col.lp as JFrameLP).width = -1;
  (col.lp as JFrameLP).height = -2;
  d.ensureRoot().setContent(col);
}
const alertMethods: NativeSpec["methods"] = {
  ...dialogMethods,
  "show()V": async function (this: JAlertDialog) {
    if (!this.built && !this.root?.content.children.length) {
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
