import { expect, test } from "bun:test";
import { zipSync } from "fflate";
import { centralDir, zipTree } from "../src/jvm/natives/jzip";
import { mergeInstall } from "../src/shell/install";
import { BytesFile, readFully } from "../src/shell/lazyfile";

test("split assets keep first-wins precedence across resident and lazy entries", async () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const base = zipSync({ "assets/shared.txt": encode("base") });
  const lazy = zipSync({ "assets/shared.txt": encode("lazy"), "assets/unique.txt": encode("lazy unique") });
  const resident = zipSync({ "assets/unique.txt": encode("resident"), "assets/last.txt": encode("last") });
  const install = mergeInstall([
    { kind: "resident", source: new BytesFile(base), bytes: base, zip: zipTree(base), split: null, hasManifest: true },
    { kind: "lazy", source: new BytesFile(lazy), bytes: null, zip: null, entries: centralDir(lazy), split: "asset_pack", hasManifest: true },
    { kind: "resident", source: new BytesFile(resident), bytes: resident, zip: zipTree(resident), split: "feature", hasManifest: true },
  ]);

  expect(new TextDecoder().decode(install.zip["assets/shared.txt"])).toBe("base");
  expect(install.lazyEntries.has("assets/shared.txt")).toBe(false);
  expect(new TextDecoder().decode(await readFully(install.lazyEntries.get("assets/unique.txt")!))).toBe("lazy unique");
  expect(install.zip["assets/unique.txt"]).toBeUndefined();
  expect(new TextDecoder().decode(install.zip["assets/last.txt"])).toBe("last");
});
