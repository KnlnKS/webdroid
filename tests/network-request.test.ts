import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("NetworkRequest builder includes other UID networks fluently", async () => {
  const builder = await newObj("android/net/NetworkRequest$Builder", "()V");
  expect(await vcall(builder, "setIncludeOtherUidNetworks", "(Z)Landroid/net/NetworkRequest$Builder;", 1)).toBe(builder);
  const request = await vcall(builder, "build", "()Landroid/net/NetworkRequest;");
  expect(request).not.toBeNull();
});

test("NetworkRequest exposes the builder's network specifier", async () => {
  const builder = await newObj("android/net/NetworkRequest$Builder", "()V");
  const specifier = rt.make("android/net/NetworkSpecifier");
  expect(await vcall(builder, "setNetworkSpecifier", "(Landroid/net/NetworkSpecifier;)Landroid/net/NetworkRequest$Builder;", specifier)).toBe(builder);
  const request = await vcall(builder, "build", "()Landroid/net/NetworkRequest;");
  expect(await vcall(request, "getNetworkSpecifier", "()Landroid/net/NetworkSpecifier;")).toBe(specifier);

  const empty = await newObj("android/net/NetworkRequest$Builder", "()V");
  const emptyRequest = await vcall(empty, "build", "()Landroid/net/NetworkRequest;");
  expect(await vcall(emptyRequest, "getNetworkSpecifier", "()Landroid/net/NetworkSpecifier;")).toBeNull();
});
