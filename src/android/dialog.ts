import { AID, resString } from "./res";
// android.app.Dialog / AlertDialog rendered as overlays (scrim + centered card).

import { rt, JObj, type NativeSpec, callSelf, stubs, noops, driven, type Gen } from "../jvm/runtime";
import { mangleMethod, jmethod } from "../jvm/abi";
import { newObj, vcall } from "../jvm/natives/jlang";
import {
  JView, JFrameLP, JLinearLP, attachView, addUnattachedView, setWindowContent, type JLayoutParams, requestLayout, measureView, layoutView, makeSpec, MS_EXACTLY, MS_AT_MOST,
  specSize, findById, guardCall, dispatchAttached, dispatchDetached
} from "./view";
import { JFrameLayout, JLinearLayout } from "./layouts";
import { JTextView, JButton } from "./textview";
import { themeAccent } from "./widget";
import { JCanvas, tfMedium , JRect } from "./graphics";
import { JDrawable, loadDrawableRV } from "./drawable";
import { addOverlay, removeOverlay } from "./popup";
import { reportUncaught } from "./os";
import { rvInt, rvDimen, askTheme, themeOf } from "./res";
import { TV } from "./axml";
import { device } from "../shell/config";
import { inflateLayout, getInflater } from "./inflate";
import { csText } from "./text";
import { applyWindowTheme, windowDim, type JWindow } from "./window";
import { complexToFraction } from "./util";
import { JMotionEvent } from "./motionevent";

const M_drawableDraw = mangleMethod("draw", "(Landroid/graphics/Canvas;)V");
const M_setBounds = mangleMethod("setBounds", "(IIII)V");
const M_onCreate = mangleMethod("onCreate", "(Landroid/os/Bundle;)V");
const M_getPadding = mangleMethod("getPadding", "(Landroid/graphics/Rect;)Z");

export async function initDialog(this: JDialog, ctx: unknown, themeId = 0) {
  const base = await askTheme(ctx);
  if (!themeId) {
    const rv = base?.lookup(AID("dialogTheme"));
    themeId = rv?.t === TV.REFERENCE ? rv.d : 0;
  }
  this.jctx = await newObj("android/view/ContextThemeWrapper", "(Landroid/content/Context;I)V", ctx, themeId);
}

async function loadCardBg(root: DialogRoot): Promise<void> {
  if (root.cardBg || !root.theme || !root.jres) return;
  const rv = root.theme.lookup(AID("windowBackground"));
  if (rv) root.cardBg = await loadDrawableRV(root.jres, rv, root.theme);
  root.cardRadius = rvDimen(root.jres, root.theme.lookup(AID("dialogCornerRadius")), 0);
}

/** The dialog's decor; the shell owns its placement and dimming behind the window. */
class DialogRoot extends JFrameLayout {
  /**
   * Padding of the window background, left/top/right/bottom. Material's alert
   * dialog hands the window an InsetDrawable — the card it paints is inset from the window —
   * so the content has to sit inside that inset or it spills outside the card. AOSP takes a
   * decor's padding from its background for exactly this reason.
   */
  bgPad: [number, number, number, number] = [0, 0, 0, 0];
  readBgPadding(): unknown { return rt.drive(this.readBgPadding$()); }
  *readBgPadding$(): Gen {
    const win = this.dialog?.win;
    const bg = win?.bgSet ? win.bg : this.cardBg;
    if (!bg) { this.bgPad = [0, 0, 0, 0]; return; }
    const r = new JRect();
    yield guardCall(bg, M_getPadding, r);
    this.bgPad = [r.left, r.top, r.right, r.bottom];
  }
  dialog: JDialog | null = null;
  /** the window's android.R.id.content FrameLayout — appcompat finds it by id, reparents its
   *  children into a sub-decor and swaps the ids, exactly as it does to an activity window */
  content!: JFrameLayout;
  /** the dialog window's own background, from its theme — not a hardcoded white card */
  cardBg: JDrawable | null = null;
  /** the theme's dialogCornerRadius: the frame's shape, and so the shadow's */
  cardRadius = 0;
}
rt.register({
  name: "webdroid/DialogRoot", ctor: DialogRoot, sup: "android/widget/FrameLayout",
  methods: {
    "onMeasure(II)V": driven(function* (this: DialogRoot, wSpec: number, hSpec: number): Gen {
      yield this.readBgPadding();
      const maxW = specSize(wSpec), maxH = specSize(hSpec);
      this.measuredW = this.measuredH = 0;
      const c = this.children[0];
      if (c && c.visibility !== 8) {
        const win = this.dialog?.win;
        const lw = win?.layoutW ?? -2, lh = win?.layoutH ?? -2;
        const padW = this.bgPad[0] + this.bgPad[2], padH = this.bgPad[1] + this.bgPad[3];
        const widthLimit = lw >= 0 ? lw : maxW, heightLimit = lh >= 0 ? lh : maxH;
        const hSpec = makeSpec(Math.max(0, heightLimit - padH), lh === -2 ? MS_AT_MOST : MS_EXACTLY);
        const preferred = lw === -2 && this.jres
          ? rvDimen(this.jres, this.jres.value(this.jres.idFor("dimen", "config_prefDialogWidth", "android")), 0) : 0;
        // ViewRootImpl tries the platform dialog width before allowing a wrapping window to expand.
        const widths = preferred > 0 && preferred < widthLimit ? [preferred, (preferred + widthLimit) >> 1, widthLimit] : [widthLimit];
        for (const width of widths) {
          yield measureView(c, makeSpec(Math.max(0, width - padW), lw === -2 ? MS_AT_MOST : MS_EXACTLY), hSpec);
          if (!(c.measuredState & 0x01000000)) break;
        }
        let width = c.measuredW + padW;
        if (lw === -2 && this.theme && this.jres) {
          const min = this.theme.lookup(AID(device.orientation === 1 ? "windowMinWidthMinor" : "windowMinWidthMajor"));
          const minW = min?.t === TV.FRACTION ? complexToFraction(min.d, maxW, maxW) : rvDimen(this.jres, min, 0);
          width = Math.min(maxW, Math.max(width, Math.round(minW)));
          if (width !== c.measuredW + padW) yield measureView(c, makeSpec(Math.max(0, width - padW), MS_EXACTLY), hSpec);
        }
        this.measuredW = lw === -2 ? width : widthLimit;
        this.measuredH = lh === -2 ? c.measuredH + padH : heightLimit;
      }
    }),
    "onLayout(ZIIII)V": driven(function* (this: DialogRoot): Gen {
      const c = this.children[0];
      if (c && c.visibility !== 8) {
        const [l, t] = this.bgPad;
        yield layoutView(c, l, t, l + c.measuredW, t + c.measuredH);
      }
    }),
    "onDraw(Landroid/graphics/Canvas;)V": driven(function* (this: DialogRoot, cv: JCanvas): Gen {
      const ctx = cv.ctx;
      const win = this.dialog?.win;
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
        ctx.roundRect(0, 0, this.width(), this.height(), r);
        ctx.fill();
        ctx.restore();
      }
      if (bg) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(0, 0, this.width(), this.height(), r);
        ctx.clip();
        yield guardCall(bg, M_setBounds, 0, 0, this.width(), this.height());
        yield guardCall(bg, M_drawableDraw, cv);
        ctx.restore();
      }
    }),
    "onTouchEvent(Landroid/view/MotionEvent;)Z": driven(function* (this: DialogRoot, ev: JMotionEvent): Gen {
      if (this.dialog) yield dialogTouch(this.dialog, ev);
      return 1;
    }),
  },
});

class JDialog extends JObj {
  jctx: any = null;
  root: DialogRoot | null = null;
  win: JWindow | null = null;
  content: JView | null = null;
  titleStr: string | null = null;
  ownerActivity: unknown = null;
  showing = false;
  cancelable = true;
  canceledOnTouchOutside = true;
  cancelL: unknown = null;
  dismissL: unknown = null;
  showL: unknown = null;
  dismissImpl(): unknown { return rt.drive(this.dismissImpl$()); }
  *dismissImpl$(): Gen {
    if (!this.showing) return;
    this.showing = false;
    if (this.root) {
      removeOverlay(this.root);
      yield dispatchDetached(this.root);
      try { yield vcall(this, "onStop", "()V"); } catch (e) { reportUncaught(e); }
    }
    if (this.dismissL) {
      try { yield vcall(this.dismissL, "onDismiss", "(Landroid/content/DialogInterface;)V", this); } catch (e) { reportUncaught(e); }
    }
  }
  cancel(): unknown { return rt.drive(this.cancel$()); }
  *cancel$(): Gen {
    if (this.cancelL) {
      try { yield vcall(this.cancelL, "onCancel", "(Landroid/content/DialogInterface;)V", this); } catch (e) { reportUncaught(e); }
    }
    yield this.dismissImpl();
  }
  ensureRoot(): DialogRoot {
    if (!this.root) {
      const r = this.root = new DialogRoot();
      r.dialog = this;
      r.ctx = this.jctx;
      r.jres = this.jctx?.$host?.res ?? null;
      r.theme = themeOf(this.jctx);
      const c = r.content = new JFrameLayout();
      c.ctx = r.ctx; c.jres = r.jres; c.theme = r.theme;
      c.idNum = 0x01020002;
      const lp = new JFrameLP(); lp.width = -1; lp.height = -2; c.lp = lp;
      addUnattachedView(r, c);
    }
    return this.root;
  }
}
async function dialogTouch(dialog: JDialog, event: JMotionEvent): Promise<number> {
  const root = dialog.root, action = event.action & 0xff;
  if (!dialog.cancelable || !dialog.showing || !dialog.canceledOnTouchOutside || !root) return 0;
  if (action !== 4 && (action !== 1 || event.x >= 0 && event.x < root.width() && event.y >= 0 && event.y < root.height())) return 0;
  await dialog.cancel();
  return 1;
}
/** A title/message/button text arrives as a resource id or any CharSequence (a Spanned from
 *  Html.fromHtml, an app class); everything resolves to one string here. */
async function str(host: any, v: unknown): Promise<string> {
  if (typeof v === "number") return host ? resString(host.res, v) : "";
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
  "<init>(Landroid/content/Context;)V": initDialog,
  "<init>(Landroid/content/Context;I)V": initDialog,
  "<init>(Landroid/content/Context;ZLandroid/content/DialogInterface$OnCancelListener;)V": driven(function* (this: JDialog, c: unknown, canc: number, l: unknown): Gen {
    yield initDialog.call(this, c);
    this.cancelable = !!canc;
    this.cancelL = l;
  }),
  "getContext()Landroid/content/Context;": function (this: JDialog) { return this.jctx; },
  "setContentView(I)V": driven(function* (this: JDialog, layoutId: number): Gen {
    const root = this.ensureRoot();
    yield vcall(root.content, "removeAllViews", "()V");
    yield inflateLayout(this.jctx, layoutId, root.content, true);
    requestLayout(root.content);
  }),
  "setContentView(Landroid/view/View;)V": function (this: JDialog, v: JView) { return setWindowContent(this.ensureRoot().content, v, null); },
  "setContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": function (this: JDialog, v: JView, lp: JLayoutParams) {
    return setWindowContent(this.ensureRoot().content, v, lp);
  },
  "addContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": function (this: JDialog, v: JView, lp: JLayoutParams) {
    return vcall(this.ensureRoot().content, "addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", v, lp);
  },
  "show()V": driven(function* (this: JDialog): Gen {
    // AOSP: showing again after hide() only makes the decor visible again
    if (this.showing) { if (this.root && this.root.visibility === 4) { this.root.visibility = 0; requestLayout(this.root); } return; }
    this.showing = true;
    const root = this.ensureRoot();
    yield loadCardBg(root);
    const win: JWindow = yield vcall(this, "getWindow", "()Landroid/view/Window;");
    const overlay = addOverlay(root, 0, 0, false, () => vcall(this, "onBackPressed", "()V"), () => this.cancel());
    overlay.dim = () => windowDim(win);
    overlay.modal = true;
    const f = jmethod(this, M_onCreate);
    if (f && !(this as any).$created) {
      (this as any).$created = true;
      try {
        const r = f.call(this, null);
        if (r instanceof Promise) yield r;
      } catch (e) { reportUncaught(e); }
    }
    try { yield vcall(this, "onStart", "()V"); } catch (e) { reportUncaught(e); }
    // WindowManager.addView: the dialog's view tree attaches to its window here, which is what
    // lets a ComposeView in it find its ViewTree owners and actually compose its content.
    yield dispatchAttached(root);
    if (this.showL) {
      try { yield vcall(this.showL, "onShow", "(Landroid/content/DialogInterface;)V", this); } catch (e) { reportUncaught(e); }
    }
    requestLayout(root);
  }),
  "hide()V": function (this: JDialog) { if (this.root) return vcall(this.root, "setVisibility", "(I)V", 4); },
  "dismiss()V": function (this: JDialog) { return this.dismissImpl(); },
  "cancel()V": function (this: JDialog) { return this.cancel(); },
  "isShowing()Z": function (this: JDialog) { return this.showing ? 1 : 0; },
  "setTitle(Ljava/lang/CharSequence;)V": setDialogTitle,
  "setTitle(I)V": setDialogTitle,
  "setCancelable(Z)V": function (this: JDialog, c: number) { this.cancelable = !!c; },
  // AOSP: an outside-touch cancel implies a cancelable dialog, but withdrawing it leaves Back alone
  "setCanceledOnTouchOutside(Z)V": function (this: JDialog, c: number) { if (c) this.cancelable = true; this.canceledOnTouchOutside = !!c; },
  "setOnCancelListener(Landroid/content/DialogInterface$OnCancelListener;)V": function (this: JDialog, l: unknown) { this.cancelL = l; },
  "setOnDismissListener(Landroid/content/DialogInterface$OnDismissListener;)V": function (this: JDialog, l: unknown) { this.dismissL = l; },
  "setOnShowListener(Landroid/content/DialogInterface$OnShowListener;)V": function (this: JDialog, l: unknown) { this.showL = l; },
  "findViewById(I)Landroid/view/View;": function (this: JDialog, id: number) {
    return this.root ? findById(this.root, id) : null;
  },
  // one Window per dialog, its callback the dialog itself (AOSP's ctor does w.setCallback(this)):
  // appcompat wraps that callback and rejects a null one
  "getWindow()Landroid/view/Window;": function (this: JDialog) {
    const root = this.ensureRoot();
    if (!this.win) {
      this.win = new (rt.link("android/view/Window").ctor as new () => JWindow)();
      this.win.callbackObj = this;
      this.win.dialog = this;
      if (root.theme) applyWindowTheme(this.win, root.theme);
      if (root.jres && root.theme && !rvInt(root.jres, root.theme.lookup(AID("windowIsFloating")), 0)) {
        this.win.flags |= 0x10100; // PhoneWindow: LAYOUT_IN_SCREEN | LAYOUT_INSET_DECOR.
        this.win.fitInsetsSides = this.win.fitInsetsTypes = 0;
        this.win.layoutW = this.win.layoutH = -1;
      }
    }
    this.win.decor = root;
    this.win.decor.windowOwner = this.win;
    return this.win;
  },
  "getLayoutInflater()Landroid/view/LayoutInflater;": function (this: JDialog) {
    return getInflater(this.jctx);
  },
  "getOwnerActivity()Landroid/app/Activity;": function (this: JDialog) { return this.ownerActivity; },
  "setOwnerActivity(Landroid/app/Activity;)V": function (this: JDialog, activity: unknown) { this.ownerActivity = activity; },
  "onBackPressed()V": function (this: JDialog) { if (this.cancelable) return this.cancel(); },
  "onTouchEvent(Landroid/view/MotionEvent;)Z": function (this: JDialog, event: JMotionEvent) { return dialogTouch(this, event); },

  // Window.Callback, as Dialog's defaults
  "onContentChanged()V": function () {},
  "onSaveInstanceState()Landroid/os/Bundle;": () => rt.make("android/os/Bundle"),
  ...noops("onCreate(Landroid/os/Bundle;)V", "onStart()V", "onStop()V",
    "setOnKeyListener(Landroid/content/DialogInterface$OnKeyListener;)V",
    "create()V", "onAttachedToWindow()V", "onDetachedFromWindow()V",
    "onWindowAttributesChanged(Landroid/view/WindowManager$LayoutParams;)V", "onWindowFocusChanged(Z)V",
    "onPanelClosed(ILandroid/view/Menu;)V", "onActionModeStarted(Landroid/view/ActionMode;)V",
    "onActionModeFinished(Landroid/view/ActionMode;)V", "onRestoreInstanceState(Landroid/os/Bundle;)V"),
  ...stubs(1, "requestWindowFeature(I)Z", "onPreparePanel(ILandroid/view/View;Landroid/view/Menu;)Z",
    "onMenuOpened(ILandroid/view/Menu;)Z"),
  ...stubs(null, "getCurrentFocus()Landroid/view/View;", "onCreatePanelView(I)Landroid/view/View;",
    "onWindowStartingActionMode(Landroid/view/ActionMode$Callback;)Landroid/view/ActionMode;",
    "onWindowStartingActionMode(Landroid/view/ActionMode$Callback;I)Landroid/view/ActionMode;"),
  ...stubs(0, "dispatchTouchEvent(Landroid/view/MotionEvent;)Z", "onSearchRequested()Z",
    "onSearchRequested(Landroid/view/SearchEvent;)Z", "onCreatePanelMenu(ILandroid/view/Menu;)Z",
    "onMenuItemSelected(ILandroid/view/MenuItem;)Z", "dispatchKeyEvent(Landroid/view/KeyEvent;)Z",
    "dispatchKeyShortcutEvent(Landroid/view/KeyEvent;)Z", "dispatchTrackballEvent(Landroid/view/MotionEvent;)Z",
    "dispatchGenericMotionEvent(Landroid/view/MotionEvent;)Z",
    "dispatchPopulateAccessibilityEvent(Landroid/view/accessibility/AccessibilityEvent;)Z",
    "onKeyDown(ILandroid/view/KeyEvent;)Z", "onKeyUp(ILandroid/view/KeyEvent;)Z"),
};
rt.register({
  name: "android/app/Dialog", ctor: JDialog,
  ifaces: ["android/content/DialogInterface", "android/view/Window$Callback"],
  methods: dialogMethods,
});
rt.register({ name: "android/content/DialogInterface", ctor: class extends JObj {},
  statics: { BUTTON_POSITIVE: -1, BUTTON_NEGATIVE: -2, BUTTON_NEUTRAL: -3 } });
// pure callback interfaces — apps implement these; dispatch is by mangled name (see vcall)
for (const n of ["OnClickListener", "OnCancelListener", "OnDismissListener", "OnKeyListener", "OnShowListener", "OnMultiChoiceClickListener"]) {
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
  buttons = new Map<number, JButton>();
  built = false;
}
async function buildAlertContent(d: JAlertDialog) {
  const col = new JLinearLayout();
  col.orientation = 1;
  col.ctx = d.jctx;
  col.jres = d.jctx?.$host?.res ?? null;
  col.theme = themeOf(d.jctx);
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
    addUnattachedView(col, t);
  }
  if (d.message) {
    const t = new JTextView();
    t.ctx = d.jctx; t.jres = col.jres; t.theme = col.theme;
    t.text = d.message;
    t.paintT.textSize = device.dp(16);
    t.colors.defColor = -10066330;
    t.padL = t.padR = device.dp(24); t.padT = device.dp(d.titleStr ? 8 : 22); t.padB = device.dp(10);
    t.lp = lpFill(1);
    addUnattachedView(col, t);
  }
  if (d.customView) {
    d.customView.lp = lpFill(1);
    await attachView(col, d.customView);
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
        [mangleMethod("onClick", "(Landroid/view/View;)V")]: driven(function* (): Gen {
          // AOSP: the listener runs first; the DISMISS message is queued behind it
          if (d.itemsL) yield vcall(d.itemsL, "onClick", "(Landroid/content/DialogInterface;I)V", d, idx);
          yield d.dismissImpl();
        }),
      };
      addUnattachedView(col, t);
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
      const b = new JButton();
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
        [mangleMethod("onClick", "(Landroid/view/View;)V")]: driven(function* (): Gen {
          if (l) yield vcall(l, "onClick", "(Landroid/content/DialogInterface;I)V", d, which);
          yield d.dismissImpl();
        }),
      };
      d.buttons.set(which, b);
      addUnattachedView(row, b);
    };
    if (d.neutText) mkBtn(d.neutText, -3, d.neutL);
    if (d.negText) mkBtn(d.negText, -2, d.negL);
    if (d.posText) mkBtn(d.posText, -1, d.posL);
    addUnattachedView(col, row);
  }
  const lp = new JFrameLP();
  lp.width = -1; lp.height = -2;
  await setWindowContent(d.ensureRoot().content, col, lp);
}
const alertMethods: NativeSpec["methods"] = {
  ...dialogMethods,
  "show()V": driven(function* (this: JAlertDialog): Gen {
    if (!this.built && !this.root?.content.children.length) {
      this.built = true;
      yield buildAlertContent(this);
    }
    yield callSelf(dialogMethods, "show()V", this);
  }),
  "setMessage(Ljava/lang/CharSequence;)V": driven(function* (this: JAlertDialog, m: unknown): Gen { this.message = yield str(this.jctx?.$host, m); }),
  "setView(Landroid/view/View;)V": function (this: JAlertDialog, v: JView) { this.customView = v; },
  "setButton(ILjava/lang/CharSequence;Landroid/content/DialogInterface$OnClickListener;)V":
    driven(function* (this: JAlertDialog, which: number, t: unknown, l: unknown): Gen { setButton(this, which, yield str(this.jctx?.$host, t), l); }),
  "getButton(I)Landroid/widget/Button;": function (this: JAlertDialog, which: number) { return this.buttons.get(which) ?? null; },
  "getListView()Landroid/widget/ListView;": () => null,
};
rt.register({ name: "android/app/AlertDialog", ctor: JAlertDialog, sup: "android/app/Dialog", methods: alertMethods });

class JAlertBuilder extends JObj {
  d = new JAlertDialog();
}
async function builderTitle(this: JAlertBuilder, t: unknown) { this.d.titleStr = await str(this.d.jctx?.$host, t); return this; }
async function builderMessage(this: JAlertBuilder, m: unknown) { this.d.message = await str(this.d.jctx?.$host, m); return this; }
const builderMethods: NativeSpec["methods"] = {
  "<init>(Landroid/content/Context;)V": function (this: JAlertBuilder, c: unknown) { return initDialog.call(this.d, c); },
  "<init>(Landroid/content/Context;I)V": function (this: JAlertBuilder, c: unknown, themeId: number) { return initDialog.call(this.d, c, themeId); },
  "setTitle(Ljava/lang/CharSequence;)Landroid/app/AlertDialog$Builder;": builderTitle,
  "setTitle(I)Landroid/app/AlertDialog$Builder;": builderTitle,
  "setMessage(Ljava/lang/CharSequence;)Landroid/app/AlertDialog$Builder;": builderMessage,
  "setMessage(I)Landroid/app/AlertDialog$Builder;": builderMessage,
  "setView(Landroid/view/View;)Landroid/app/AlertDialog$Builder;": function (this: JAlertBuilder, v: JView) {
    this.d.customView = v;
    return this;
  },
  "setView(I)Landroid/app/AlertDialog$Builder;": driven(function* (this: JAlertBuilder, id: number): Gen {
    this.d.customView = (yield inflateLayout(this.d.jctx, id, null, false)) as JView | null;
    return this;
  }),
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
  "show()Landroid/app/AlertDialog;": driven(function* (this: JAlertBuilder): Gen {
    yield callSelf(alertMethods, "show()V", this.d);
    return this.d;
  }),
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
  driven(function* (this: JAlertBuilder, items: unknown[], l: unknown): Gen {
    this.d.items = yield Promise.all((items ?? []).map((i) => csText(i)));
    this.d.itemsL = l;
    return this;
  });
builderMethods["setAdapter(Landroid/widget/ListAdapter;Landroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;"] =
  driven(function* (this: JAlertBuilder, adapter: unknown, l: unknown): Gen {
    const n = yield vcall(adapter, "getCount", "()I");
    const items: string[] = [];
    for (let i = 0; i < n; i++) {
      items.push(yield csText(yield vcall(adapter, "getItem", "(I)Ljava/lang/Object;", i)));
    }
    this.d.items = items;
    this.d.itemsL = l;
    return this;
  });
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
      driven(function* (c: any, t: unknown, m: unknown): Gen {
        const d = rt.make("android/app/ProgressDialog");
        yield initDialog.call(d, c);
        d.titleStr = yield str(c?.$host, t);
        d.message = yield str(c?.$host, m);
        yield callSelf(alertMethods, "show()V", d);
        return d;
      }),
  } });
