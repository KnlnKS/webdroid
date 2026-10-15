import { expect, test } from "bun:test";
import { attachPointerInput, drainPointers } from "./pointer-input";

// the DOM pieces the input reads, which node lacks
class Rect {
  constructor(readonly left = 0, readonly top = 0, readonly width = 0, readonly height = 0) {}
  get right() { return this.left + this.width; }
  get bottom() { return this.top + this.height; }
}
Object.assign(globalThis, { DOMRect: Rect, document: { body: { append() {} }, createElement: () => ({ style: { setProperty() {} }, remove() {} }) } });

/** a 100×200 canvas showing a 200×400 display; each dispatch as [action, id, x, y, id, x, y, ...] */
function attach() {
  const source = new EventTarget(), sent: number[][] = [];
  const canvas = Object.assign(source, { getBoundingClientRect: () => new Rect(0, 0, 100, 200) });
  const input = attachPointerInput(canvas as unknown as HTMLCanvasElement,
    () => ({ width: 200, height: 400, scrollUnit: 128, touchSlop: 16, minScalingSpan: 49 }),
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

test("Ctrl+wheel (a trackpad pinch) drives two fingers about the cursor and lifts them once the stream idles", async () => {
  const { sent, wheel, close } = attach();
  const frames = async (n: number) => { for (let i = 0; i < n; i++) { drainPointers(); await settle(); } };
  const pinch = { ctrlKey: true };
  // under the slop: each finger would travel 5 of 16
  wheel(50, 100, -10, pinch);
  await frames(1);
  expect(sent).toEqual([]);
  // to twice the span: the fingers go down 100 apart along the display's longer side, centred on
  // the cursor, and the first MOVE crosses the slop by a pixel
  wheel(50, 100, -100 * Math.log(2) + 10, pinch);
  await frames(12);
  const spread = sent.length;
  // pinching in hard stops at the minimum scaling span (49), a pixel over
  wheel(50, 100, 1000, pinch);
  await frames(12);
  await settle(130);
  await frames(1);
  close();
  const round = (e: number[]) => e.map(v => Math.round(v * 1e6) / 1e6);
  expect(sent.slice(0, 3).map(round)).toEqual([[0, 0, 100, 150], [5 | 1 << 8, 0, 100, 150, 1, 100, 250], [2, 0, 100, 133, 1, 100, 267]]);
  expect(sent.slice(-2).map(round)).toEqual([[6, 0, 100, 175, 1, 100, 225], [1, 1, 100, 225]]);
  // then MOVEs cover half the remaining ratio each frame, so the scale reaches the app as a stream
  const spans = (moves: number[][]) => moves.map(e => {
    expect(e[0]).toBe(2);
    expect((e[3] + e[6]) / 2).toBeCloseTo(200);
    return e[6] - e[3];
  });
  const out = spans(sent.slice(2, spread)), inward = spans(sent.slice(spread, -2));
  for (const [steps, target, sign] of [[out, 200, 1], [inward, 50, -1]] as const) {
    expect(steps.length).toBeGreaterThan(3);
    expect(steps.at(-1)).toBeCloseTo(target);
    steps.slice(1).forEach((span, i) => expect(Math.sign(span - steps[i])).toBe(sign));
  }
});

test("a wheel burst that gains or drops Ctrl lifts the gesture it was driving", async () => {
  const { sent, wheel, close } = attach();
  const frame = async () => { drainPointers(); await settle(); };
  wheel(50, 100, 20);
  await frame();
  // the UP goes out at once; the pinch presses once it has landed
  wheel(50, 100, -100, { ctrlKey: true });
  await frame();
  await frame();
  close();
  expect(sent.map(e => e.map(v => Math.round(v * 1e6) / 1e6))).toEqual([
    [0, 0, 100, 200],
    [2, 0, 100, 160],
    [1, 0, 100, 160],
    [0, 0, 100, 150],
    [5 | 1 << 8, 0, 100, 150, 1, 100, 250],
    [2, 0, 100, 133, 1, 100, 267],
  ]);
});
