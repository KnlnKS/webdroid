import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { mkFile } from "../src/jvm/natives/jio";

rt.linkNatives();

test("File natural ordering sorts paths case-sensitively and collapses equal paths", async () => {
  const files = await newObj("java/util/TreeSet");
  for (const path of ["/cache/z", "/cache/a", "/cache/Z", "/cache/a"])
    await vcall(files, "add", "(Ljava/lang/Object;)Z", mkFile(path));
  const iterator = await vcall(files, "iterator", "()Ljava/util/Iterator;");
  const paths: string[] = [];
  while (await vcall(iterator, "hasNext", "()Z"))
    paths.push(await vcall(await vcall(iterator, "next", "()Ljava/lang/Object;"), "getPath", "()Ljava/lang/String;"));
  expect(paths).toEqual(["/cache/Z", "/cache/a", "/cache/z"]);
  expect(await vcall(mkFile("/cache/a"), "compareTo", "(Ljava/io/File;)I", mkFile("/cache/z"))).toBe(-25);
  for (const [other, exception] of [[null, "NullPointerException"], ["/cache/a", "ClassCastException"]]) {
    const error = await vcallAsync(mkFile("/cache/a"), "compareTo", "(Ljava/lang/Object;)I", other).then(() => null, e => e);
    expect(rt.iof(error, `java/lang/${exception}`)).toBeTruthy();
  }
});
