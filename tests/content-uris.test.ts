import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
const scall = (cls: string, name: string, desc: string, ...args: unknown[]) =>
  (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...args);

test("ContentUris appends and parses signed long IDs", async () => {
  const base = scall("android/net/Uri", "parse", "(Ljava/lang/String;)Landroid/net/Uri;", "content://media/items?sort=new");
  const appended = await scall("android/content/ContentUris", "withAppendedId", "(Landroid/net/Uri;J)Landroid/net/Uri;", base, -42n);
  expect(await vcall(appended, "toString", "()Ljava/lang/String;")).toBe("content://media/items/-42?sort=new");
  expect(await scall("android/content/ContentUris", "parseId", "(Landroid/net/Uri;)J", appended)).toBe(-42n);
});

test("ContentUris rejects a path without a decimal long ID", async () => {
  const uri = scall("android/net/Uri", "parse", "(Ljava/lang/String;)Landroid/net/Uri;", "content://media/items/not-an-id");
  await expect(Promise.resolve().then(() => scall("android/content/ContentUris", "parseId", "(Landroid/net/Uri;)J", uri)))
    .rejects.toMatchObject({ constructor: { $i: { name: "java/lang/NumberFormatException" } } });
});
