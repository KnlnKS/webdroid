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
  const input = attachPointerInput(canvas as unknown as HTMLCanvasElement, () => ({ width: 200, height: 400, scrollUnit: 128, touchSlop: 16 }),
    async (action, pointers) => { sent.push([action, ...pointers.flatMap(p => [p.id, p.x, p.y])]); });
  const pointer = (type: string, pointerId: number, clientX: number, clientY: number, init: object = {}) =>
    source.dispatchEvent(Object.assign(new Event(type), { pointerId, clientX, clientY, pointerType: "touch", altKey: false, ...init }));
  return { sent, pointer, close: input.close };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

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
