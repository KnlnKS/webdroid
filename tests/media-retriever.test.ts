import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vfs } from "../src/jvm/natives/jio";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("MediaMetadataRetriever reads video metadata and rejects nonmedia input", async () => {
  const retriever = await newObj("android/media/MediaMetadataRetriever", "()V");
  vfs.write("/sdcard/media-probe.mp4", new Uint8Array(await Bun.file("tests/fixtures/media.mp4").arrayBuffer()));
  await vcall(retriever, "setDataSource", "(Ljava/lang/String;)V", "/sdcard/media-probe.mp4");
  expect(await vcall(retriever, "extractMetadata", "(I)Ljava/lang/String;", 12)).toBe("video/mp4");
  expect(await vcall(retriever, "extractMetadata", "(I)Ljava/lang/String;", 18)).toBe("32");
  expect(await vcall(retriever, "extractMetadata", "(I)Ljava/lang/String;", 19)).toBe("32");
  await vcall(retriever, "release", "()V");
  vfs.write("/sdcard/media-probe.txt", new Uint8Array(0));
  await expect(vcallAsync(retriever, "setDataSource", "(Ljava/lang/String;)V", "/sdcard/media-probe.txt")).rejects.toMatchObject({ msg: "Invalid media source" });
});

test("MediaMetadataRetriever reads MP3 metadata", async () => {
  const retriever = await newObj("android/media/MediaMetadataRetriever", "()V");
  vfs.write("/sdcard/media-probe.mp3", new Uint8Array(await Bun.file("tests/fixtures/audio.mp3").arrayBuffer()));
  await vcall(retriever, "setDataSource", "(Ljava/lang/String;)V", "/sdcard/media-probe.mp3");
  expect(await vcall(retriever, "extractMetadata", "(I)Ljava/lang/String;", 12)).toBe("audio/mpeg");
  expect(await vcall(retriever, "extractMetadata", "(I)Ljava/lang/String;", 9)).toBe("52");
  expect(await vcall(retriever, "getEmbeddedPicture", "()[B")).toBeNull();
});
