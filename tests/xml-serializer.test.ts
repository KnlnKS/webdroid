import { expect, test } from "bun:test";
import "../src/natives";
import { newXmlSerializer } from "../src/android/xmlpull";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { rt } from "../src/jvm/runtime";

rt.linkNatives();

test("XmlSerializer escapes content and writes each flush once", async () => {
  const out = await newObj("java/io/ByteArrayOutputStream", "()V");
  const xml = newXmlSerializer();
  await vcall(xml, "setOutput", "(Ljava/io/OutputStream;Ljava/lang/String;)V", out, "UTF-8");
  await vcall(xml, "startDocument", "(Ljava/lang/String;Ljava/lang/Boolean;)V", "UTF-8", null);
  await vcall(xml, "startTag", "(Ljava/lang/String;Ljava/lang/String;)Lorg/xmlpull/v1/XmlSerializer;", "", "root");
  await vcall(xml, "attribute", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Lorg/xmlpull/v1/XmlSerializer;", "", "title", 'a&"b');
  await vcall(xml, "flush", "()V");
  await vcall(xml, "text", "(Ljava/lang/String;)Lorg/xmlpull/v1/XmlSerializer;", "<x>&");
  await vcall(xml, "endTag", "(Ljava/lang/String;Ljava/lang/String;)Lorg/xmlpull/v1/XmlSerializer;", "", "root");
  await vcall(xml, "endDocument", "()V");
  const bytes = await vcall(out, "toByteArray", "()[B") as Int8Array;
  expect(new TextDecoder().decode(bytes)).toBe('<?xml version="1.0" encoding="UTF-8"?><root title="a&amp;&quot;b">&lt;x&gt;&amp;</root>');
});
