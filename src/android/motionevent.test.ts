import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { vcall } from "../jvm/natives/jlang";
import { JMotionEvent } from "./motionevent";
import { device } from "../shell/config";

const motion = () => rt.link("android/view/MotionEvent").ctor;

test("browser touch events resolve their modeled device and advertised motion ranges", async () => {
  motion();
  const event = new JMotionEvent();
  expect(rt.iof(event, "android/view/InputEvent")).toBe(1);
  const input = await vcall(event, "getDevice", "()Landroid/view/InputDevice;");
  expect(await vcall(input, "getId", "()I")).toBe(await vcall(event, "getDeviceId", "()I"));
  expect(await vcall(input, "getSources", "()I")).toBe(await vcall(event, "getSource", "()I"));
  const pressure = await vcall(input, "getMotionRange", "(I)Landroid/view/InputDevice$MotionRange;", 2);
  expect(await vcall(pressure, "getMin", "()F")).toBe(0);
  expect(await vcall(pressure, "getMax", "()F")).toBe(1);
  const x = await vcall(input, "getMotionRange", "(II)Landroid/view/InputDevice$MotionRange;", 0, 0x1002);
  expect(await vcall(x, "getMax", "()F")).toBe(device.width);
  expect(await vcall(input, "getMotionRange", "(II)Landroid/view/InputDevice$MotionRange;", 0, 0x2002)).toBeNull();
  expect(await vcall(input, "getMotionRange", "(I)Landroid/view/InputDevice$MotionRange;", 24)).toBeNull();
  const manager = new (rt.link("android/hardware/input/InputManager").ctor)();
  expect(await vcall(manager, "getInputDevice", "(I)Landroid/view/InputDevice;", 1)).toBe(input);
});

test("Java synthetic events retain source, device, pressure and precision through copies", async () => {
  const ctor = motion();
  const obtain = ctor[mangleMethod("obtain", "(JJIFFFFIFFII)Landroid/view/MotionEvent;")];
  const event = obtain(10n, 20n, 2, 30, 40, 0.25, 0.75, 4, 0.5, 0.125, 77, 8);
  expect(await vcall(event, "getDeviceId", "()I")).toBe(77);
  expect(await vcall(event, "getDevice", "()Landroid/view/InputDevice;")).toBeNull();
  expect(await vcall(event, "getSource", "()I")).toBe(2);
  expect(await vcall(event, "isFromSource", "(I)Z", 0x1002)).toBe(0);
  expect(await vcall(event, "getToolType", "(I)I", 0)).toBe(0);
  const copy = ctor[mangleMethod("obtain", "(Landroid/view/MotionEvent;)Landroid/view/MotionEvent;")](event);
  await vcall(copy, "offsetLocation", "(FF)V", 3, 4);
  expect(await vcall(copy, "getX", "()F")).toBe(33);
  expect(await vcall(event, "getX", "()F")).toBe(30);
  expect(await vcall(copy, "getRawX", "()F")).toBe(30);
  expect(await vcall(copy, "getPressure", "(I)F", 0)).toBe(0.25);
  expect(await vcall(copy, "getSize", "(I)F", 0)).toBe(0.75);
  expect(await vcall(copy, "getMetaState", "()I")).toBe(4);
  expect(await vcall(copy, "getEdgeFlags", "()I")).toBe(8);
  expect(copy.xPrecision).toBe(0.5);
  const simple = ctor[mangleMethod("obtain", "(JJIFFI)Landroid/view/MotionEvent;")](0n, 1n, 0, 4, 5, 8);
  expect(await vcall(simple, "getDeviceId", "()I")).toBe(0);
  expect(await vcall(simple, "getSize", "()F")).toBe(1);
});

test("Flutter's geometry getters and pointer snapshots read the same event axes", async () => {
  motion();
  const event = Object.assign(new JMotionEvent(), { x: 12, y: 34, pressure: 0.4, size: 0.5, toolMajor: 6, toolMinor: 3, orientation: 0.25 });
  for (const [axis, value] of [[0, 12], [1, 34], [2, 0.4], [3, 0.5], [6, 6], [7, 3], [8, 0.25], [24, 0], [25, 0]]) {
    expect(await vcall(event, "getAxisValue", "(II)F", axis, 0)).toBe(value);
  }
  expect(await vcall(event, "getToolMajor", "(I)F", 0)).toBe(6);
  expect(await vcall(event, "getToolMinor", "(I)F", 0)).toBe(3);
  const coords = new (rt.link("android/view/MotionEvent$PointerCoords").ctor)();
  await vcall(event, "getPointerCoords", "(ILandroid/view/MotionEvent$PointerCoords;)V", 0, coords);
  expect([coords.x, coords.y, coords.pressure, coords.size, coords.toolMajor, coords.toolMinor, coords.orientation]).toEqual([12, 34, 0.4, 0.5, 6, 3, 0.25]);
});
