import { expect, test } from "bun:test";
import { unzipSync } from "fflate";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
test("ZipOutputStream writes separate readable entries", async () => {
  const output = await newObj("java/io/ByteArrayOutputStream");
  const zip = await newObj("java/util/zip/ZipOutputStream", "(Ljava/io/OutputStream;)V", output);
  for (const [name, body] of [["first.txt", "alpha"], ["nested/second.txt", "beta"]]) {
    const entry = await newObj("java/util/zip/ZipEntry", "(Ljava/lang/String;)V", name);
    await vcall(zip, "putNextEntry", "(Ljava/util/zip/ZipEntry;)V", entry);
    const bytes = new TextEncoder().encode(body);
    await vcall(zip, "write", "([BII)V", new Int8Array(bytes.buffer), 0, bytes.length);
    await vcall(zip, "closeEntry", "()V");
  }
  await vcall(zip, "close", "()V");
  const bytes = await vcall(output, "toByteArray", "()[B") as Int8Array;
  const files = unzipSync(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  expect(new TextDecoder().decode(files["first.txt"])).toBe("alpha");
  expect(new TextDecoder().decode(files["nested/second.txt"])).toBe("beta");
});
