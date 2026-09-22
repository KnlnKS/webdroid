import { JObj, noops, rt } from "../jvm/runtime";
import { defineException, JThrowable, vcall } from "../jvm/natives/jlang";
import { readStreamFully } from "../jvm/natives/jio";
import { newXmlPullParser, readerText } from "./xmlpull";

const S = "Ljava/lang/String;", NS = "http://xml.org/sax/features/namespaces";
rt.markers("org/xml/sax/XMLReader", "org/xml/sax/ContentHandler", "org/xml/sax/Attributes",
  "org/xml/sax/ErrorHandler", "org/xml/sax/EntityResolver", "org/xml/sax/DTDHandler");
class JSaxException extends JThrowable { exception: JThrowable | null = null; }
function saxMessage(this: JSaxException) {
  return this.msg ?? (this.exception ? vcall(this.exception, "getMessage", "()Ljava/lang/String;") : null);
}
rt.register({ name: "org/xml/sax/SAXException", sup: "java/lang/Exception", ctor: JSaxException, methods: {
  "<init>()V": function () {},
  "<init>(Ljava/lang/String;)V": function (this: JSaxException, message: string | null) { this.msg = message; },
  "<init>(Ljava/lang/Exception;)V": function (this: JSaxException, error: JThrowable | null) { this.exception = error; },
  "<init>(Ljava/lang/String;Ljava/lang/Exception;)V": function (this: JSaxException, message: string | null, error: JThrowable | null) {
    this.msg = message; this.exception = error;
  },
  "getException()Ljava/lang/Exception;": function (this: JSaxException) { return this.exception; },
  "getMessage()Ljava/lang/String;": saxMessage,
  "getLocalizedMessage()Ljava/lang/String;": function () { return vcall(this, "getMessage", "()Ljava/lang/String;"); },
  "toString()Ljava/lang/String;": async function (this: JSaxException) {
    if (this.exception) return vcall(this.exception, "toString", "()Ljava/lang/String;");
    const name = await vcall(await vcall(this, "getClass", "()Ljava/lang/Class;"), "getName", "()Ljava/lang/String;");
    const message = await vcall(this, "getLocalizedMessage", "()Ljava/lang/String;");
    return name + (message === null ? "" : ": " + message);
  },
} });
defineException("org/xml/sax/SAXParseException", "org/xml/sax/SAXException");
defineException("org/xml/sax/SAXNotRecognizedException", "org/xml/sax/SAXException");

class JInputSource extends JObj { bytes: unknown = null; chars: unknown = null; encoding: string | null = null; systemId: string | null = null; }
rt.register({ name: "org/xml/sax/InputSource", ctor: JInputSource, methods: {
  "<init>()V": function () {},
  "<init>(Ljava/io/InputStream;)V": function (this: JInputSource, stream: unknown) { this.bytes = stream; },
  "<init>(Ljava/io/Reader;)V": function (this: JInputSource, reader: unknown) { this.chars = reader; },
  [`<init>(${S})V`]: function (this: JInputSource, id: string) { this.systemId = id; },
  "getByteStream()Ljava/io/InputStream;": function (this: JInputSource) { return this.bytes; },
  "setByteStream(Ljava/io/InputStream;)V": function (this: JInputSource, stream: unknown) { this.bytes = stream; },
  "setCharacterStream(Ljava/io/Reader;)V": function (this: JInputSource, reader: unknown) { this.chars = reader; },
  [`setEncoding(${S})V`]: function (this: JInputSource, encoding: string) { this.encoding = encoding; },
  [`setSystemId(${S})V`]: function (this: JInputSource, id: string) { this.systemId = id; },
} });
class JAttributes extends JObj { attrs: Attr[] = []; namespaces = true; }
const attrIndex = (a: JAttributes, uri: string, local: string) => a.attrs.findIndex(v => (v.namespaceURI ?? "") === uri && v.localName === local);
rt.register({ name: "webdroid/SaxAttributes", ctor: JAttributes, ifaces: ["org/xml/sax/Attributes"], methods: {
  "getLength()I": function (this: JAttributes) { return this.attrs.length; },
  [`getURI(I)${S}`]: function (this: JAttributes, i: number) { return this.attrs[i] ? this.namespaces ? this.attrs[i].namespaceURI ?? "" : "" : null; },
  [`getLocalName(I)${S}`]: function (this: JAttributes, i: number) { return this.attrs[i] ? this.namespaces ? this.attrs[i].localName : "" : null; },
  [`getQName(I)${S}`]: function (this: JAttributes, i: number) { return this.attrs[i]?.name ?? null; },
  [`getType(I)${S}`]: function (this: JAttributes, i: number) { return this.attrs[i] ? "CDATA" : null; },
  [`getValue(I)${S}`]: function (this: JAttributes, i: number) { return this.attrs[i]?.value ?? null; },
  [`getValue(${S})${S}`]: function (this: JAttributes, name: string) { return this.attrs.find(a => a.name === name)?.value ?? null; },
  [`getValue(${S}${S})${S}`]: function (this: JAttributes, uri: string, local: string) { return this.attrs[attrIndex(this, uri, local)]?.value ?? null; },
  [`getIndex(${S})I`]: function (this: JAttributes, name: string) { return this.attrs.findIndex(a => a.name === name); },
  [`getIndex(${S}${S})I`]: function (this: JAttributes, uri: string, local: string) { return attrIndex(this, uri, local); },
} });
class JXmlReader extends JObj { handler: unknown = null; errorHandler: unknown = null; namespaces = true; }
async function parse(this: JXmlReader, source: JInputSource): Promise<void> {
  if (!source) throw rt.mkThrowable("java/lang/NullPointerException", "source");
  const input = source.chars ?? source.bytes;
  if (!input) throw rt.mkThrowable("org/xml/sax/SAXException", "InputSource requires a stream or reader");
  const parser = newXmlPullParser(); parser.nsAware = this.namespaces;
  try {
    const text = source.chars ? await readerText(source.chars) : new TextDecoder(source.encoding ?? "utf-8").decode(await readStreamFully(source.bytes));
    try { parser.load(text); }
    catch (error) {
      const exception = rt.mkThrowable("org/xml/sax/SAXParseException", error instanceof JThrowable ? error.msg : String(error));
      if (this.errorHandler) await vcall(this.errorHandler, "fatalError", "(Lorg/xml/sax/SAXParseException;)V", exception);
      throw exception;
    }
    if (!this.handler) return;
    await vcall(this.handler, "startDocument", "()V");
    for (const event of parser.events) {
      const qname = parser.nsAware && event.prefix ? event.prefix + ":" + event.name : event.name;
      if (event.t === 2) {
        for (const binding of event.bindings ?? []) await vcall(this.handler, "startPrefixMapping", `(${S}${S})V`, binding.name === "xmlns" ? "" : binding.localName, binding.value);
        rt.link("webdroid/SaxAttributes");
        const attrs = new JAttributes(); attrs.attrs = event.attrs; attrs.namespaces = this.namespaces;
        await vcall(this.handler, "startElement", `(${S}${S}${S}Lorg/xml/sax/Attributes;)V`, event.ns, this.namespaces ? event.name : "", qname, attrs);
      } else if (event.t === 3) {
        await vcall(this.handler, "endElement", `(${S}${S}${S})V`, event.ns, this.namespaces ? event.name : "", qname);
        for (const binding of event.bindings ?? []) await vcall(this.handler, "endPrefixMapping", `(${S})V`, binding.name === "xmlns" ? "" : binding.localName);
      }
      else if (event.t === 4) {
        const chars = new Uint16Array(event.text.length);
        for (let i = 0; i < chars.length; i++) chars[i] = event.text.charCodeAt(i);
        await vcall(this.handler, "characters", "([CII)V", chars, 0, chars.length);
      }
    }
    await vcall(this.handler, "endDocument", "()V");
  } finally { await vcall(input, "close", "()V"); }
}
rt.register({ name: "webdroid/SaxReader", ctor: JXmlReader, ifaces: ["org/xml/sax/XMLReader"], methods: {
  "setContentHandler(Lorg/xml/sax/ContentHandler;)V": function (this: JXmlReader, handler: unknown) { this.handler = handler; },
  "getContentHandler()Lorg/xml/sax/ContentHandler;": function (this: JXmlReader) { return this.handler; },
  "setErrorHandler(Lorg/xml/sax/ErrorHandler;)V": function (this: JXmlReader, handler: unknown) { this.errorHandler = handler; },
  [`setFeature(${S}Z)V`]: function (this: JXmlReader, name: string, value: number) {
    if (name !== NS) throw rt.mkThrowable("org/xml/sax/SAXNotRecognizedException", name);
    this.namespaces = !!value;
  },
  [`getFeature(${S})Z`]: function (this: JXmlReader, name: string) {
    if (name !== NS) throw rt.mkThrowable("org/xml/sax/SAXNotRecognizedException", name);
    return +this.namespaces;
  },
  "parse(Lorg/xml/sax/InputSource;)V": parse,
} });
class JSaxParser extends JObj { reader = new JXmlReader(); }
rt.register({ name: "javax/xml/parsers/SAXParser", ctor: JSaxParser, methods: {
  "getXMLReader()Lorg/xml/sax/XMLReader;": function (this: JSaxParser) { return this.reader; },
  "isNamespaceAware()Z": function (this: JSaxParser) { return +this.reader.namespaces; },
  "isValidating()Z": () => 0,
} });
class JSaxFactory extends JObj { namespaces: boolean | null = null; }
rt.register({ name: "javax/xml/parsers/SAXParserFactory", ctor: JSaxFactory, methods: {
  "static newInstance()Ljavax/xml/parsers/SAXParserFactory;": () => new JSaxFactory(),
  "setNamespaceAware(Z)V": function (this: JSaxFactory, value: number) { this.namespaces = !!value; },
  "isNamespaceAware()Z": function (this: JSaxFactory) { return +!!this.namespaces; },
  "setValidating(Z)V": function () {},
  "setFeature(Ljava/lang/String;Z)V": function (this: JSaxFactory, name: string, value: number) {
    if (name !== NS) throw rt.mkThrowable("org/xml/sax/SAXNotRecognizedException", name);
    this.namespaces = !!value;
  },
  "newSAXParser()Ljavax/xml/parsers/SAXParser;": function (this: JSaxFactory) {
    rt.link("webdroid/SaxReader"); rt.link("javax/xml/parsers/SAXParser");
    const parser = new JSaxParser(); parser.reader.namespaces = this.namespaces ?? true; return parser;
  },
} });
rt.register({ name: "org/xml/sax/helpers/DefaultHandler", ctor: class extends JObj {},
  ifaces: ["org/xml/sax/ContentHandler", "org/xml/sax/ErrorHandler", "org/xml/sax/EntityResolver", "org/xml/sax/DTDHandler"], methods: {
    ...noops("<init>()V", "startDocument()V", "endDocument()V", "characters([CII)V", "ignorableWhitespace([CII)V",
      `startElement(${S}${S}${S}Lorg/xml/sax/Attributes;)V`, `endElement(${S}${S}${S})V`,
      `processingInstruction(${S}${S})V`, "setDocumentLocator(Lorg/xml/sax/Locator;)V", `skippedEntity(${S})V`,
      `notationDecl(${S}${S}${S})V`, `unparsedEntityDecl(${S}${S}${S}${S})V`,
      `startPrefixMapping(${S}${S})V`, `endPrefixMapping(${S})V`, "warning(Lorg/xml/sax/SAXParseException;)V", "error(Lorg/xml/sax/SAXParseException;)V"),
    "fatalError(Lorg/xml/sax/SAXParseException;)V": (error: unknown) => { throw error; },
  },
});
