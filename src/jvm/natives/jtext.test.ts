import { expect, test } from "bun:test";
import "../../natives";
import { rt, JObj } from "../runtime";
import { newObj, vcall } from "./jlang";

test("number formatting reads BigDecimal and overridden Java Number values", async () => {
  const format = await newObj("java/text/DecimalFormat", "(Ljava/lang/String;)V", "0.###");
  const number = await newObj("java/math/BigDecimal", "(Ljava/lang/String;)V", "4.061");
  expect(await vcall(format, "format", "(Ljava/lang/Object;)Ljava/lang/String;", number)).toBe("4.061");
  rt.register({ name: "test/AsyncNumber", ctor: class extends JObj {}, sup: "java/lang/Number", methods: {
    "doubleValue()D": async () => { await Promise.resolve(); return 56.522; },
  } });
  expect(await vcall(format, "format", "(Ljava/lang/Object;)Ljava/lang/String;", await newObj("test/AsyncNumber"))).toBe("56.522");
  await expect(vcall(format, "format", "(Ljava/lang/Object;)Ljava/lang/String;", "4.061")).rejects.toMatchObject({ msg: "Cannot format given Object as a Number" });
});
