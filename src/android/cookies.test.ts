import { expect, test } from "bun:test";
import "../natives";
import { JObj } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { JBool, newObj, vcall } from "../jvm/natives/jlang";
import { inMainJob, onMain } from "./mainloop";

test("empty cookie removal completes asynchronously with a boxed result", async () => {
  const manager = await newObj("android/webkit/CookieManager");
  for (const method of ["removeAllCookies", "removeSessionCookies"]) {
    let calls = 0, returned = false;
    const callback = Object.assign(new JObj(), { [mangleMethod("onReceiveValue", "(Ljava/lang/Object;)V")]: (value: unknown) => {
      expect(returned).toBe(true); expect(inMainJob()).toBe(true);
      expect(value).toBeInstanceOf(JBool); expect(value instanceof JBool && value.v).toBe(0); calls++;
    } });
    await onMain(async () => {
      await vcall(manager, method, "(Landroid/webkit/ValueCallback;)V", callback);
      returned = true;
    });
    await onMain(() => {});
    expect(calls).toBe(1);
    await vcall(manager, method, "(Landroid/webkit/ValueCallback;)V", null);
  }
});
