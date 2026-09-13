import { expect, test } from "bun:test";
import "../src/natives";
import { JContext } from "../src/android/context";
import { vfs } from "../src/jvm/natives/jio";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("Context.databaseList returns private database directory entries", async () => {
  const context = rt.make("android/content/Context") as JContext;
  context.$host = { pkg: "database-list-test" } as JContext["$host"];
  const dir = "/data/data/database-list-test/databases";
  const paths = [`${dir}/main.db`, `${dir}/main.db-wal`];
  for (const path of paths) vfs.write(path, new Uint8Array(0));
  try {
    const names = await vcall(context, "databaseList", "()[Ljava/lang/String;") as string[];
    expect([...names].sort()).toEqual(["main.db", "main.db-wal"]);
  } finally {
    for (const path of paths) vfs.delete(path);
  }
});

test("Debug.MemoryInfo exposes legacy dirty-page fields", () => {
  const info = rt.link("android/os/Debug$MemoryInfo");
  for (const name of ["dalvikSharedDirty", "dalvikPrivateDirty", "nativeSharedDirty",
    "nativePrivateDirty", "otherSharedDirty", "otherPrivateDirty"]) {
    expect(info.fieldTable.get(name)).toBe(name);
    expect((new info.ctor() as unknown as Record<string, number>)[name]).toBe(0);
  }
});
