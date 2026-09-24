import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("SAX factory passes namespace-prefixes through to its reader", async () => {
  const factory = rt.make("javax/xml/parsers/SAXParserFactory");
  const feature = "http://xml.org/sax/features/namespace-prefixes";
  await vcall(factory, "setFeature", "(Ljava/lang/String;Z)V", feature, 1);
  expect(await vcall(factory, "getFeature", "(Ljava/lang/String;)Z", feature)).toBe(1);
  const parser = await vcall(factory, "newSAXParser", "()Ljavax/xml/parsers/SAXParser;");
  const reader = await vcall(parser, "getXMLReader", "()Lorg/xml/sax/XMLReader;");
  expect(await vcall(reader, "getFeature", "(Ljava/lang/String;)Z", feature)).toBe(1);
});
