import { expect, test } from "vite-plus/test";
import { attachPointerInput, drainPointers } from "./pointer-input.ts";

// the DOM pieces the input reads, which node lacks
class Rect {
  readonly left; readonly top; readonly width; readonly height;
  constructor(left = 0, top = 0, width = 0, height = 0) { this.left = left; this.top = top; this.width = width; this.height = height; }
  get right() { return this.left + this.width; }
  get bottom() { return this.top + this.height; }
}
Object.assign(globalThis, { DOMRect: Rect, document: { body: { append() {} }, createElement: () => ({ style: { setProperty() {} }, remove() {} }) } });

/** a 100×200 canvas showing a 200×400 display; each dispatch as [action, id, x, y, id, x, y, ...] */
function attach() {
  const source = new EventTarget(), sent: number[][] = [];
  const canvas = Object.assign(source, { getBoundingClientRect: () => new Rect(0, 0, 100, 200) });
  const input = attachPointerInput(canvas as unknown as HTMLCanvasElement,
    () => ({ width: 200, height: 400, scrollUnit: 128, touchSlop: 16, edgeSlop: 10, minScalingSpan: 49 }),
    async (action, pointers) => { sent.push([action, ...pointers.flatMap(p => [p.id, p.x, p.y])]); });
  const pointer = (type: string, pointerId: number, clientX: number, clientY: number, init: object = {}) =>
    source.dispatchEvent(Object.assign(new Event(type), { pointerId, clientX, clientY, pointerType: "touch", altKey: false, ...init }));
  const wheel = (clientX: number, clientY: number, deltaY: number, init: object = {}) =>
    source.dispatchEvent(Object.assign(new Event("wheel", { cancelable: true }), { clientX, clientY, deltaX: 0, deltaY, deltaMode: 0, ctrlKey: false, ...init }));
  return { sent, pointer, wheel, close: input.close };
}
const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

test("browser pointers become one gesture's ids, with POINTER_DOWN/UP indices and one MOVE per frame", async () => {
  const { sent, pointer, close } = attach();
  pointer("pointerdown", 7, 10, 20);
  pointer("pointerdown", 9, 50, 60);
  await settle();
  pointer("pointermove", 7, 15, 20);
  pointer("pointermove", 9, 45, 60);
  drainPointers();
  await settle();
  pointer("pointerup", 7, 15, 20);
  // the lowest free id, which sorts ahead of the pointer still down
  pointer("pointerdown", 4, 30, 30);
  pointer("pointerup", 9, 45, 60);
  pointer("pointerup", 4, 30, 30);
  await settle();
  close();
  expect(sent).toEqual([
    [0, 0, 20, 40],
    [5 | 1 << 8, 0, 20, 40, 1, 100, 120],
    [2, 0, 30, 40, 1, 90, 120],
    [6, 0, 30, 40, 1, 90, 120],
    [5, 0, 60, 60, 1, 90, 120],
    [6 | 1 << 8, 0, 60, 60, 1, 90, 120],
    [1, 0, 60, 60],
  ]);
});

test("an Alt-held mouse press mirrors a second finger through the display's centre", async () => {
  const { sent, pointer, close } = attach();
  const mouse = { pointerType: "mouse", altKey: true };
  pointer("pointerdown", 1, 10, 20, mouse);
  pointer("pointermove", 1, 20, 40, mouse);
  await settle();
  pointer("pointerup", 1, 20, 40, mouse);
  await settle();
  close();
  expect(sent).toEqual([
    [0, 0, 20, 40],
    [5 | 1 << 8, 0, 20, 40, 1, 180, 360],
    [2, 0, 40, 80, 1, 160, 320],
    [6, 0, 40, 80, 1, 160, 320],
    [1, 1, 160, 320],
  ]);
});

test("Ctrl+wheel (a trackpad pinch) drives two level fingers about the cursor and lifts them once the stream idles", async () => {
  const { sent, wheel, close } = attach();
  const frames = async (n: number) => { for (let i = 0; i < n; i++) { drainPointers(); await settle(); } };
  const pinch = { ctrlKey: true };
  // under the slop: each finger would travel 5 of 16
  wheel(10, 100, 10, pinch);
  await frames(1);
  expect(sent).toEqual([]);
  // a squeeze: the fingers go down two minimum scaling spans (49) apart, a pixel over, on the
  // cursor's row, slid right so the first stays out of the edge slop, and stop one span apart
  wheel(10, 100, 1000, pinch);
  await frames(4);
  // spreading carries them past the display's edge
  wheel(10, 100, -100 * Math.log(4), pinch);
  await frames(6);
  await settle(130);
  await frames(1);
  close();
  expect(sent.map(e => e.map(v => Math.round(v * 1e6) / 1e6))).toEqual([
    [0, 0, 10, 200],
    [5 | 1 << 8, 0, 10, 200, 1, 110, 200],
    // a MOVE carries a finger as far as it has come from where it went down, or half the way left if
    // that is less, but at least the touch slop and a pixel (16 + 1)
    [2, 0, 27, 200, 1, 93, 200],
    [2, 0, 35, 200, 1, 85, 200],
    [2, 0, 10, 200, 1, 110, 200],
    [2, 0, -7, 200, 1, 127, 200],
    [2, 0, -24, 200, 1, 144, 200],
    [2, 0, -40, 200, 1, 160, 200],
    [6, 0, -40, 200, 1, 160, 200],
    [1, 1, 160, 200],
  ]);
});

test("a wheel burst that gains or drops Ctrl lifts the gesture it was driving", async () => {
  const { sent, wheel, close } = attach();
  const frame = async () => { drainPointers(); await settle(); };
  wheel(50, 100, 20);
  await frame();
  // the UP goes out at once; the pinch presses once it has landed, a spread one span apart
  wheel(50, 100, -100, { ctrlKey: true });
  await frame();
  await frame();
  close();
  expect(sent.map(e => e.map(v => Math.round(v * 1e6) / 1e6))).toEqual([
    [0, 0, 100, 200],
    [2, 0, 100, 160],
    [1, 0, 100, 160],
    [0, 0, 75, 200],
    [5 | 1 << 8, 0, 75, 200, 1, 125, 200],
    [2, 0, 58, 200, 1, 142, 200],
  ]);
});
