import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("URLConnection guesses names using Android fragment and directory rules", async () => {
  const guess = (name: string | null) => vcall(rt.link("java/net/URLConnection").ctor, "guessContentTypeFromName", "(Ljava/lang/String;)Ljava/lang/String;", name);
  expect(await guess("/assets/INDEX.HTML#part")).toBe("text/html");
  expect(await guess("/assets/")).toBe("text/html");
  expect(await guess("html")).toBe("text/html");
  expect(await guess("/html")).toBeNull();
  expect(await guess("page.html?query=1")).toBeNull();
  expect(await guess("unknown.extension")).toBeNull();
  const error = await guess(null).then(() => null, e => e);
  expect(rt.iof(error, "java/lang/NullPointerException")).toBeTruthy();
});
