import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { mkPfd } from "../src/android/os";
import { decodeProviderValue, encodeProviderValue } from "../src/android/provideripc";
import { providerOperations } from "../src/android/contentresolver";

rt.linkNatives();

test("provider file descriptors cross IPC as readable bytes", async () => {
  const encoded = await encodeProviderValue(mkPfd(new Uint8Array([4, 5, 6]), null));
  const descriptor = await decodeProviderValue(encoded);
  const input = await newObj("android/os/ParcelFileDescriptor$AutoCloseInputStream", "(Landroid/os/ParcelFileDescriptor;)V", descriptor);
  const bytes = new Int8Array(3);
  expect(await vcall(input, "read", "([B)I", bytes)).toBe(3);
  expect([...bytes]).toEqual([4, 5, 6]);
  expect(providerOperations.openFile).toBe("(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;");
});

test("writable provider descriptors forward flushed bytes", async () => {
  let written = new Uint8Array(0);
  const encoded = await encodeProviderValue(mkPfd(new Uint8Array(0), () => {}));
  const descriptor = await decodeProviderValue(encoded, (bytes) => { written = bytes.slice(); });
  const output = await newObj("android/os/ParcelFileDescriptor$AutoCloseOutputStream", "(Landroid/os/ParcelFileDescriptor;)V", descriptor);
  await vcall(output, "write", "([B)V", new Int8Array([7, 8]));
  await vcall(output, "close", "()V");
  expect([...written]).toEqual([7, 8]);
});
