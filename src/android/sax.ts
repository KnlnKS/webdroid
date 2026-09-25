import { JObj, noops, rt } from "../jvm/runtime";
import { defineException, JThrowable, vcall, vcallOn, curThread } from "../jvm/natives/jlang";
import { readStreamFully } from "../jvm/natives/jio";
import { newXmlPullParser, readerText } from "./xmlpull";

const S = "Ljava/lang/String;", NS = "http://xml.org/sax/features/namespaces", NS_PREFIX = "http://xml.org/sax/features/namespace-prefixes";
rt.markers("org/xml/sax/XMLReader", "org/xml/sax/ContentHandler", "org/xml/sax/Attributes",
  "org/xml/sax/ErrorHandler", "org/xml/sax/EntityResolver", "org/xml/sax/DTDHandler",
  "org/xml/sax/Locator", "org/xml/sax/ext/LexicalHandler");
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
defineException("org/xml/sax/SAXNotSupportedException", "org/xml/sax/SAXException");

class JInputSource extends JObj { bytes: unknown = null; chars: unknown = null; encoding: string | null = null; systemId: string | null = null; publicId: string | null = null; }
rt.register({ name: "org/xml/sax/InputSource", ctor: JInputSource, methods: {
  "<init>()V": function () {},
  "<init>(Ljava/io/InputStream;)V": function (this: JInputSource, stream: unknown) { this.bytes = stream; },
  "<init>(Ljava/io/Reader;)V": function (this: JInputSource, reader: unknown) { this.chars = reader; },
  [`<init>(${S})V`]: function (this: JInputSource, id: string) { this.systemId = id; },
  "getByteStream()Ljava/io/InputStream;": function (this: JInputSource) { return this.bytes; },
  "setByteStream(Ljava/io/InputStream;)V": function (this: JInputSource, stream: unknown) { this.bytes = stream; },
  "getCharacterStream()Ljava/io/Reader;": function (this: JInputSource) { return this.chars; },
  "setCharacterStream(Ljava/io/Reader;)V": function (this: JInputSource, reader: unknown) { this.chars = reader; },
  [`getEncoding()${S}`]: function (this: JInputSource) { return this.encoding; },
  [`setEncoding(${S})V`]: function (this: JInputSource, encoding: string) { this.encoding = encoding; },
  [`getSystemId()${S}`]: function (this: JInputSource) { return this.systemId; },
  [`setSystemId(${S})V`]: function (this: JInputSource, id: string) { this.systemId = id; },
  [`getPublicId()${S}`]: function (this: JInputSource) { return this.publicId; },
  [`setPublicId(${S})V`]: function (this: JInputSource, id: string) { this.publicId = id; },
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
class JXmlReader extends JObj { handler: unknown = null; errorHandler: unknown = null; namespaces = true; namespacePrefixes = false; }
async function parse(this: JXmlReader, source: JInputSource | string): Promise<void> {
  if (source == null) throw rt.mkThrowable("java/lang/NullPointerException", "source");
  if (this.namespaces && this.namespacePrefixes)
    throw rt.mkThrowable("org/xml/sax/SAXNotSupportedException", "namespace-prefixes with namespaces");
  const thread = curThread, input = typeof source === "string" ? null : source.chars ?? source.bytes;
  if (typeof source !== "string" && !input) throw rt.mkThrowable("org/xml/sax/SAXException", "InputSource requires a stream or reader");
  const parser = newXmlPullParser(); parser.nsAware = this.namespaces;
  try {
    const text = typeof source === "string" ? source : source.chars ? await readerText(source.chars) : new TextDecoder(source.encoding ?? "utf-8").decode(await readStreamFully(source.bytes));
    try { parser.load(text); }
    catch (error) {
      const exception = rt.mkThrowable("org/xml/sax/SAXParseException", error instanceof JThrowable ? error.msg : String(error));
      if (this.errorHandler) await vcallOn(thread, this.errorHandler, "fatalError", "(Lorg/xml/sax/SAXParseException;)V", exception);
      throw exception;
    }
    if (!this.handler) return;
    await vcallOn(thread, this.handler, "startDocument", "()V");
    for (const event of parser.events) {
      const qname = parser.nsAware && event.prefix ? event.prefix + ":" + event.name : event.name;
      if (event.t === 2) {
        for (const binding of event.bindings ?? []) await vcallOn(thread, this.handler, "startPrefixMapping", `(${S}${S})V`, binding.name === "xmlns" ? "" : binding.localName, binding.value);
        rt.link("webdroid/SaxAttributes");
        const attrs = new JAttributes(); attrs.attrs = event.attrs; attrs.namespaces = this.namespaces;
        await vcallOn(thread, this.handler, "startElement", `(${S}${S}${S}Lorg/xml/sax/Attributes;)V`, event.ns, this.namespaces ? event.name : "", qname, attrs);
      } else if (event.t === 3) {
        await vcallOn(thread, this.handler, "endElement", `(${S}${S}${S})V`, event.ns, this.namespaces ? event.name : "", qname);
        for (const binding of event.bindings ?? []) await vcallOn(thread, this.handler, "endPrefixMapping", `(${S})V`, binding.name === "xmlns" ? "" : binding.localName);
      }
      else if (event.t === 4) {
        const chars = new Uint16Array(event.text.length);
        for (let i = 0; i < chars.length; i++) chars[i] = event.text.charCodeAt(i);
        await vcallOn(thread, this.handler, "characters", "([CII)V", chars, 0, chars.length);
      }
    }
    await vcallOn(thread, this.handler, "endDocument", "()V");
  } finally { if (input) await vcallOn(thread, input, "close", "()V"); }
}
export function parseSax(text: string, handler: unknown): Promise<void> {
  const reader = new JXmlReader(); reader.handler = handler; return parse.call(reader, text);
}
rt.register({ name: "webdroid/SaxReader", ctor: JXmlReader, ifaces: ["org/xml/sax/XMLReader"], methods: {
  "setContentHandler(Lorg/xml/sax/ContentHandler;)V": function (this: JXmlReader, handler: unknown) { this.handler = handler; },
  "getContentHandler()Lorg/xml/sax/ContentHandler;": function (this: JXmlReader) { return this.handler; },
  "setErrorHandler(Lorg/xml/sax/ErrorHandler;)V": function (this: JXmlReader, handler: unknown) { this.errorHandler = handler; },
  [`setFeature(${S}Z)V`]: function (this: JXmlReader, name: string, value: number) {
    if (name === NS) this.namespaces = !!value;
    else if (name === NS_PREFIX) this.namespacePrefixes = !!value;
    else throw rt.mkThrowable("org/xml/sax/SAXNotRecognizedException", name);
  },
  [`getFeature(${S})Z`]: function (this: JXmlReader, name: string) {
    if (name === NS) return +this.namespaces;
    if (name === NS_PREFIX) return +this.namespacePrefixes;
    throw rt.mkThrowable("org/xml/sax/SAXNotRecognizedException", name);
  },
  "parse(Lorg/xml/sax/InputSource;)V": parse,
} });
class JSaxParser extends JObj { reader = new JXmlReader(); }
function parseWithHandler(this: JSaxParser, source: JInputSource, handler: unknown) {
  if (!source) throw rt.mkThrowable("java/lang/IllegalArgumentException", "InputSource is null");
  this.reader.handler = handler;
  this.reader.errorHandler = handler;
  return parse.call(this.reader, source);
}
rt.register({ name: "javax/xml/parsers/SAXParser", ctor: JSaxParser, methods: {
  "getXMLReader()Lorg/xml/sax/XMLReader;": function (this: JSaxParser) { return this.reader; },
  "isNamespaceAware()Z": function (this: JSaxParser) { return +this.reader.namespaces; },
  "isValidating()Z": () => 0,
  "parse(Lorg/xml/sax/InputSource;Lorg/xml/sax/helpers/DefaultHandler;)V": parseWithHandler,
  "parse(Ljava/io/InputStream;Lorg/xml/sax/helpers/DefaultHandler;)V": function (this: JSaxParser, stream: unknown, handler: unknown) {
    if (!stream) throw rt.mkThrowable("java/lang/IllegalArgumentException", "InputStream is null");
    const source = new JInputSource(); source.bytes = stream;
    return parseWithHandler.call(this, source, handler);
  },
} });
class JSaxFactory extends JObj { namespaces: boolean | null = null; namespacePrefixes = false; }
rt.register({ name: "javax/xml/parsers/SAXParserFactory", ctor: JSaxFactory, methods: {
  "static newInstance()Ljavax/xml/parsers/SAXParserFactory;": () => new JSaxFactory(),
  "setNamespaceAware(Z)V": function (this: JSaxFactory, value: number) { this.namespaces = !!value; },
  "isNamespaceAware()Z": function (this: JSaxFactory) { return +!!this.namespaces; },
  "setValidating(Z)V": function () {},
  "setFeature(Ljava/lang/String;Z)V": function (this: JSaxFactory, name: string, value: number) {
    if (name === NS) this.namespaces = !!value;
    else if (name === NS_PREFIX) this.namespacePrefixes = !!value;
    else throw rt.mkThrowable("org/xml/sax/SAXNotRecognizedException", name);
  },
  "getFeature(Ljava/lang/String;)Z": function (this: JSaxFactory, name: string) {
    if (name === NS) return +(this.namespaces ?? true);
    if (name === NS_PREFIX) return +this.namespacePrefixes;
    throw rt.mkThrowable("org/xml/sax/SAXNotRecognizedException", name);
  },
  "newSAXParser()Ljavax/xml/parsers/SAXParser;": function (this: JSaxFactory) {
    rt.link("webdroid/SaxReader"); rt.link("javax/xml/parsers/SAXParser");
    const parser = new JSaxParser(); parser.reader.namespaces = this.namespaces ?? true;
    parser.reader.namespacePrefixes = this.namespacePrefixes; return parser;
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
