declare global {
  var __e2eDrawnText: { frame: number; texts: string[] };
}

/** Diagnostic only: observe text submitted to the presented framebuffer, including Compose. */
export function observeDrawnText(): void {
  if (globalThis.__e2eDrawnText) return;
  globalThis.__e2eDrawnText = { frame: 0, texts: [] };
  const pending = new WeakMap<OffscreenCanvas, Set<string>>();
  const fill = OffscreenCanvasRenderingContext2D.prototype.fillText;
  OffscreenCanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
    const point = this.getTransform().transformPoint({ x, y });
    if (this.globalAlpha > 0 && point.x >= 0 && point.x < this.canvas.width && point.y >= 0 && point.y < this.canvas.height) {
      let texts = pending.get(this.canvas);
      if (!texts) pending.set(this.canvas, texts = new Set());
      if (texts.size < 1000) texts.add(text);
    }
    if (maxWidth === undefined) fill.call(this, text, x, y);
    else fill.call(this, text, x, y, maxWidth);
  };
  const transfer = OffscreenCanvas.prototype.transferToImageBitmap;
  OffscreenCanvas.prototype.transferToImageBitmap = function () {
    const bitmap = transfer.call(this);
    const screen = document.getElementById("screen");
    if (screen instanceof HTMLCanvasElement && this.width === screen.width && this.height === screen.height) {
      globalThis.__e2eDrawnText = { frame: globalThis.__e2eDrawnText.frame + 1, texts: [...(pending.get(this) ?? [])] };
    }
    pending.delete(this);
    return bitmap;
  };
}
