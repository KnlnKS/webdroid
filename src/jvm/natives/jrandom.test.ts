import { expect, test } from "bun:test";
import { rt } from "../runtime";
import { newObj, vcall } from "./jlang";
import "./jrandom";

test("Random.nextBytes matches Java across partial words and preserves generator state", async () => {
  const random = await newObj("java/util/Random", "(J)V", 0n);
  const expected = [[], [96], [56, 81, -39], [122, -53, -109, 61], [-66, 112, 57, -101, -10],
    [58, -16, 29, 79, -73, 112, -23, -116, 3, 37, -12, 29, 62, -70, -8, -104]];
  for (const values of expected) {
    const bytes = new Int8Array(values.length);
    await vcall(random, "nextBytes", "([B)V", bytes);
    expect([...bytes]).toEqual(values);
  }
  expect(await vcall(random, "nextInt", "()I")).toBe(-938301587);
});

test("Random.nextBytes dispatches an overridden nextInt", async () => {
  const parent = rt.link("java/util/Random");
  rt.register({ name: "test/ByteRandom", sup: parent.name, ctor: class extends parent.ctor {},
    methods: { "nextInt()I": async () => 0x807f0201 } });
  const random = await newObj("test/ByteRandom", null);
  const bytes = new Int8Array(5);
  await vcall(random, "nextBytes", "([B)V", bytes);
  expect([...bytes]).toEqual([1, 2, 127, -128, 1]);
});
