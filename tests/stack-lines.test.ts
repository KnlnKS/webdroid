import { expect, test } from "bun:test";
import "../src/natives";
import { vcall } from "../src/jvm/natives/jentry";
import { rt } from "../src/jvm/runtime";
import { scall, loadLibcore } from "./java";

rt.linkNatives();
await loadLibcore();

test("a trace names each frame's source file and line from the DEX's debug info", async () => {
  let thrown: unknown;
  const empty = await scall("java/util/Collections", "emptyList", "()Ljava/util/List;");
  try { await vcall(empty, "get", "(I)Ljava/lang/Object;", 0); } catch (e) { thrown = e; }
  const trace = await vcall(thrown, "getStackTrace", "()[Ljava/lang/StackTraceElement;") as unknown[];
  expect(await vcall(trace[0], "toString", "()Ljava/lang/String;")).toBe("java.util.Collections$EmptyList.get(Collections.java:4888)");
});
