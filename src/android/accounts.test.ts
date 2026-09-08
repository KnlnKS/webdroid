import { expect, test } from "bun:test";
import { newObj, vcall } from "../jvm/natives/jlang";
import "../natives";

test("Account equality and hash include the name and account type", async () => {
  const account = await newObj("android/accounts/Account", "(Ljava/lang/String;Ljava/lang/String;)V", "a", "b");
  expect(account.name).toBe("a");
  expect(account.type).toBe("b");
  for (const [name, type, equal] of [["a", "b", 1], ["a", "c", 0], ["c", "b", 0]]) {
    const other = await newObj("android/accounts/Account", "(Ljava/lang/String;Ljava/lang/String;)V", name, type);
    expect(await vcall(account, "equals", "(Ljava/lang/Object;)Z", other)).toBe(equal);
  }
  expect(await vcall(account, "equals", "(Ljava/lang/Object;)Z", null)).toBe(0);
  expect(await vcall(account, "hashCode", "()I")).toBe(19442);
  expect(await vcall(account, "toString", "()Ljava/lang/String;")).toBe("Account {name=a, type=b}");
});

test("Account rejects empty or null names and types", async () => {
  for (const [name, type] of [["", "type"], [null, "type"], ["name", ""], ["name", null]]) {
    await expect(newObj("android/accounts/Account", "(Ljava/lang/String;Ljava/lang/String;)V", name, type)).rejects.toThrow();
  }
});
