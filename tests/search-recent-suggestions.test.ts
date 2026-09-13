import { expect, test } from "bun:test";
import "../src/natives";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { rt } from "../src/jvm/runtime";

rt.linkNatives();

test("SearchRecentSuggestions inserts queries through ContentValues", async () => {
  let inserted: unknown = null;
  let uri = "";
  const resolver = {
    [mangleMethod("insert", "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;")]:
      (target: { uri: string }, values: unknown) => { uri = target.uri; inserted = values; return null; },
  };
  const context = {
    [mangleMethod("getContentResolver", "()Landroid/content/ContentResolver;")]: () => resolver,
  };
  const recent = await newObj("android/provider/SearchRecentSuggestions", "(Landroid/content/Context;Ljava/lang/String;I)V", context, "history", 1);

  await vcall(recent, "saveRecentQuery", "(Ljava/lang/String;Ljava/lang/String;)V", "android", null);

  expect(uri).toBe("content://history/suggestions");
  expect(await vcall(inserted, "getAsString", "(Ljava/lang/String;)Ljava/lang/String;", "display1")).toBe("android");
  expect(await vcall(inserted, "getAsString", "(Ljava/lang/String;)Ljava/lang/String;", "query")).toBe("android");
  expect(await vcall(inserted, "getAsLong", "(Ljava/lang/String;)Ljava/lang/Long;", "date")).not.toBeNull();
});
