// org.xmlpull.v1 over text XML: the browser parses, and the parser replays the tree as the pull
// events the API defines. The binary-resource parser in resnative.ts is a separate object.
import { rt, JObj, stubs } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { readStreamFully } from "../jvm/natives/jio";
import { charsToString } from "../jvm/abi";

interface Ev { bindings?: Attr[]; t: number; name: string; ns: string; prefix: string | null; attrs: Attr[]; text: string; depth: number; empty: boolean }
const START_DOCUMENT = 0, END_DOCUMENT = 1, START_TAG = 2, END_TAG = 3, TEXT = 4;
const ev = (t: number, depth: number, p: Partial<Ev> = {}): Ev => ({ t, name: "", ns: "", prefix: null, attrs: [], text: "", depth, empty: false, ...p });

class JXmlPull extends JObj {
  events: Ev[] = [ev(START_DOCUMENT, 0)];
  i = 0;
  nsAware = false;
  get cur(): Ev { return this.events[this.i]; }
  load(text: string) {
    const doc = new DOMParser().parseFromString(text, "text/xml");
    const err = doc.querySelector("parsererror");
    if (err) throw rt.mkThrowable("org/xmlpull/v1/XmlPullParserException", err.textContent ?? "malformed XML");
    const out: Ev[] = [ev(START_DOCUMENT, 0)];
    const walk = (n: Node, depth: number) => {
      if (n.nodeType === 1) {
        const e = n as Element;
        const all = [...e.attributes];
        const bindings = this.nsAware ? all.filter(a => a.name === "xmlns" || a.prefix === "xmlns") : [];
        const attrs = this.nsAware ? all.filter(a => a.name !== "xmlns" && a.prefix !== "xmlns") : all;
        const start = ev(START_TAG, depth + 1, { name: this.nsAware ? e.localName : e.tagName, ns: this.nsAware ? e.namespaceURI ?? "" : "", prefix: e.prefix, attrs, bindings, empty: !e.childNodes.length });
        out.push(start);
        for (const c of e.childNodes) walk(c, depth + 1);
        out.push(ev(END_TAG, depth + 1, { name: start.name, ns: start.ns, prefix: start.prefix, bindings }));
      } else if (n.nodeType === 3 || n.nodeType === 4) {
        const last = out[out.length - 1];
        if (last.t === TEXT) last.text += n.nodeValue ?? "";   // adjacent text and CDATA are one TEXT event
        else out.push(ev(TEXT, depth, { text: n.nodeValue ?? "" }));
      }
    };
    for (const c of doc.childNodes) walk(c, 0);
    out.push(ev(END_DOCUMENT, 0));
    this.events = out;
    this.i = 0;
  }
}
const attrOf = (p: JXmlPull, i: number) => p.cur.attrs[i] ?? (() => { throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", String(i)); })();
const notFound = (p: JXmlPull) => rt.mkThrowable("org/xmlpull/v1/XmlPullParserException", "expected START_TAG, got " + p.cur.t);
export async function readerText(r: unknown): Promise<string> {
  const buf = new Uint16Array(8192);
  let s = "";
  for (;;) {
    const n = await vcall(r, "read", "([CII)I", buf, 0, buf.length) as number;
    if (n <= 0) return s;
    s += String.fromCharCode(...buf.subarray(0, n));
  }
}
const S = "Ljava/lang/String;";
rt.register({
  name: "org/xmlpull/v1/XmlPullParser", ctor: class extends JObj {},
  statics: { START_DOCUMENT, END_DOCUMENT, START_TAG, END_TAG, TEXT, CDSECT: 5, ENTITY_REF: 6, IGNORABLE_WHITESPACE: 7, PROCESSING_INSTRUCTION: 8, COMMENT: 9, DOCDECL: 10,
    NO_NAMESPACE: "", FEATURE_PROCESS_NAMESPACES: "http://xmlpull.org/v1/doc/features.html#process-namespaces" },
});
rt.register({
  name: "webdroid/XmlPullParser", ctor: JXmlPull, ifaces: ["org/xmlpull/v1/XmlPullParser"],
  methods: {
    [`setInput(Ljava/io/InputStream;${S})V`]: async function (this: JXmlPull, s: unknown, enc: string | null) {
      this.load(new TextDecoder(enc ?? "utf-8").decode(await readStreamFully(s)));
    },
    "setInput(Ljava/io/Reader;)V": async function (this: JXmlPull, r: unknown) { this.load(await readerText(r)); },
    [`setFeature(${S}Z)V`]: function (this: JXmlPull, f: string, on: number) { if (f.endsWith("process-namespaces")) this.nsAware = !!on; },
    [`getFeature(${S})Z`]: function (this: JXmlPull, f: string) { return f.endsWith("process-namespaces") && this.nsAware ? 1 : 0; },
    [`setProperty(${S}Ljava/lang/Object;)V`]: () => {},
    [`getProperty(${S})Ljava/lang/Object;`]: () => null,
    [`defineEntityReplacementText(${S}${S})V`]: () => {},
    "getEventType()I": function (this: JXmlPull) { return this.cur.t; },
    "next()I": function (this: JXmlPull) { if (this.i < this.events.length - 1) this.i++; return this.cur.t; },
    "nextToken()I": function (this: JXmlPull) { if (this.i < this.events.length - 1) this.i++; return this.cur.t; },
    "nextTag()I": function (this: JXmlPull) {
      if (this.i < this.events.length - 1) this.i++;
      if (this.cur.t === TEXT && /^\s*$/.test(this.cur.text) && this.i < this.events.length - 1) this.i++;
      const t: number = this.cur.t;
      if (t !== START_TAG && t !== END_TAG) throw rt.mkThrowable("org/xmlpull/v1/XmlPullParserException", "expected START_TAG or END_TAG");
      return t;
    },
    [`nextText()${S}`]: function (this: JXmlPull) {
      const at = (): number => this.cur.t;
      if (at() !== START_TAG) throw notFound(this);
      this.i++;
      let text = "";
      if (at() === TEXT) { text = this.cur.text; this.i++; }
      if (at() !== END_TAG) throw rt.mkThrowable("org/xmlpull/v1/XmlPullParserException", "expected END_TAG");
      return text;
    },
    [`require(I${S}${S})V`]: function (this: JXmlPull, t: number, ns: string | null, name: string | null) {
      const c = this.cur;
      if (t !== c.t || (ns !== null && ns !== c.ns) || (name !== null && name !== c.name)) throw rt.mkThrowable("org/xmlpull/v1/XmlPullParserException", "expected " + t + " " + name);
    },
    [`getName()${S}`]: function (this: JXmlPull) { return this.cur.t === START_TAG || this.cur.t === END_TAG ? this.cur.name : null; },
    [`getNamespace()${S}`]: function (this: JXmlPull) { return this.cur.ns; },
    [`getNamespace(${S})${S}`]: () => null,
    [`getPrefix()${S}`]: function (this: JXmlPull) { return this.cur.prefix; },
    [`getText()${S}`]: function (this: JXmlPull) { return this.cur.t === TEXT ? this.cur.text : null; },
    "getTextCharacters([I)[C": function (this: JXmlPull, holder: Int32Array) {
      const s = this.cur.t === TEXT ? this.cur.text : "";
      holder[0] = 0; holder[1] = s.length;
      return Uint16Array.from(s, (c) => c.charCodeAt(0));
    },
    "isWhitespace()Z": function (this: JXmlPull) { return this.cur.t === TEXT && /^\s*$/.test(this.cur.text) ? 1 : 0; },
    "isEmptyElementTag()Z": function (this: JXmlPull) { return this.cur.t === START_TAG && this.cur.empty ? 1 : 0; },
    "getDepth()I": function (this: JXmlPull) { return this.cur.depth; },
    "getAttributeCount()I": function (this: JXmlPull) { return this.cur.t === START_TAG ? this.cur.attrs.length : -1; },
    [`getAttributeName(I)${S}`]: function (this: JXmlPull, i: number) { const a = attrOf(this, i); return this.nsAware ? a.localName : a.name; },
    [`getAttributeValue(I)${S}`]: function (this: JXmlPull, i: number) { return attrOf(this, i).value; },
    [`getAttributeNamespace(I)${S}`]: function (this: JXmlPull, i: number) { return this.nsAware ? attrOf(this, i).namespaceURI ?? "" : ""; },
    [`getAttributePrefix(I)${S}`]: function (this: JXmlPull, i: number) { return attrOf(this, i).prefix; },
    [`getAttributeType(I)${S}`]: () => "CDATA",
    "isAttributeDefault(I)Z": () => 0,
    [`getAttributeValue(${S}${S})${S}`]: function (this: JXmlPull, ns: string | null, name: string) {
      const a = this.cur.attrs.find((x) => (this.nsAware ? x.localName : x.name) === name && (ns === null || ns === "" || x.namespaceURI === ns));
      return a ? a.value : null;
    },
    ...stubs(0, "getNamespaceCount(I)I"),
    ...stubs(-1, "getLineNumber()I", "getColumnNumber()I"),
    [`getPositionDescription()${S}`]: function (this: JXmlPull) { return `event ${this.i}`; },
    [`getInputEncoding()${S}`]: () => "UTF-8",
  },
});
const newParser = () => rt.make("webdroid/XmlPullParser") as JXmlPull;
class JXmlPullFactory extends JObj { nsAware = false; }
rt.register({
  name: "org/xmlpull/v1/XmlPullParserFactory", ctor: JXmlPullFactory,
  methods: {
    "static newInstance()Lorg/xmlpull/v1/XmlPullParserFactory;": () => new JXmlPullFactory(),
    [`static newInstance(${S}Ljava/lang/Class;)Lorg/xmlpull/v1/XmlPullParserFactory;`]: () => new JXmlPullFactory(),
    "newPullParser()Lorg/xmlpull/v1/XmlPullParser;": function (this: JXmlPullFactory) { const p = newParser(); p.nsAware = this.nsAware; return p; },
    "setNamespaceAware(Z)V": function (this: JXmlPullFactory, on: number) { this.nsAware = !!on; },
    "isNamespaceAware()Z": function (this: JXmlPullFactory) { return this.nsAware ? 1 : 0; },
    "setValidating(Z)V": () => {},
    "isValidating()Z": () => 0,
    [`setFeature(${S}Z)V`]: function (this: JXmlPullFactory, f: string, on: number) { if (f.endsWith("process-namespaces")) this.nsAware = !!on; },
    [`getFeature(${S})Z`]: function (this: JXmlPullFactory, f: string) { return f.endsWith("process-namespaces") && this.nsAware ? 1 : 0; },
  },
});
export const newXmlPullParser = newParser;

rt.markers("org/xmlpull/v1/XmlSerializer");
const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlAttr = (s: string) => xmlText(s).replace(/"/g, "&quot;").replace(/\r/g, "&#13;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
class JXmlSerializer extends JObj {
  output: unknown = null;
  writer = false;
  chunks: string[] = [];
  stack: { name: string; ns: string; qualified: string }[] = [];
  prefixes = new Map<string, string>();
  declarations = new Map<string, string>();
  openTag = false;
  nextPrefix = 0;
  reset(output: unknown, writer: boolean) {
    this.output = output; this.writer = writer; this.chunks = []; this.stack = [];
    this.prefixes.clear(); this.declarations.clear(); this.openTag = false; this.nextPrefix = 0;
  }
  append(s: string) { this.chunks.push(s); }
  finishTag() { if (this.openTag) { this.append(">"); this.openTag = false; } }
  prefix(ns: string, attribute = false): string {
    if (!ns) return "";
    let prefix = this.prefixes.get(ns);
    if (prefix === undefined || (attribute && !prefix)) {
      prefix = "n" + this.nextPrefix++;
      this.prefixes.set(ns, prefix);
      this.declarations.set(prefix, ns);
    }
    return prefix;
  }
  declare() {
    for (const [prefix, ns] of this.declarations) this.append(` xmlns${prefix ? ":" + prefix : ""}="${xmlAttr(ns)}"`);
    this.declarations.clear();
  }
}
const serializer = () => rt.make("webdroid/XmlSerializer") as JXmlSerializer;
rt.register({ name: "webdroid/XmlSerializer", ctor: JXmlSerializer, ifaces: ["org/xmlpull/v1/XmlSerializer"], methods: {
  "setOutput(Ljava/io/OutputStream;Ljava/lang/String;)V": function (this: JXmlSerializer, output: unknown, encoding: string | null) {
    if (encoding && !/^utf-?8$/i.test(encoding)) throw rt.mkThrowable("java/io/UnsupportedEncodingException", encoding);
    this.reset(output, false);
  },
  "setOutput(Ljava/io/Writer;)V": function (this: JXmlSerializer, output: unknown) {
    this.reset(output, true);
  },
  "startDocument(Ljava/lang/String;Ljava/lang/Boolean;)V": function (this: JXmlSerializer, encoding: string | null, standalone: { v?: number } | null) {
    this.append(`<?xml version="1.0" encoding="${encoding ?? "UTF-8"}"${standalone == null ? "" : ` standalone="${standalone.v ? "yes" : "no"}"`}?>`);
  },
  "endDocument()V": async function (this: JXmlSerializer) {
    while (this.stack.length) {
      const top = this.stack.at(-1)!;
      await vcall(this, "endTag", "(Ljava/lang/String;Ljava/lang/String;)Lorg/xmlpull/v1/XmlSerializer;", top.ns, top.name);
    }
    await vcall(this, "flush", "()V");
  },
  "setPrefix(Ljava/lang/String;Ljava/lang/String;)V": function (this: JXmlSerializer, prefix: string, ns: string) {
    this.prefixes.set(ns ?? "", prefix ?? "");
    this.declarations.set(prefix ?? "", ns ?? "");
    if (this.openTag) this.declare();
  },
  "getPrefix(Ljava/lang/String;Z)Ljava/lang/String;": function (this: JXmlSerializer, ns: string, generate: number) {
    return this.prefixes.get(ns) ?? (generate ? this.prefix(ns) : null);
  },
  "getDepth()I": function (this: JXmlSerializer) { return this.stack.length; },
  "getName()Ljava/lang/String;": function (this: JXmlSerializer) { return this.stack.at(-1)?.name ?? null; },
  "getNamespace()Ljava/lang/String;": function (this: JXmlSerializer) { return this.stack.at(-1)?.ns ?? null; },
  "startTag(Ljava/lang/String;Ljava/lang/String;)Lorg/xmlpull/v1/XmlSerializer;": function (this: JXmlSerializer, ns: string | null, name: string) {
    this.finishTag();
    const space = ns ?? "", prefix = this.prefix(space), qualified = prefix ? prefix + ":" + name : name;
    this.append("<" + qualified); this.declare(); this.openTag = true;
    this.stack.push({ name, ns: space, qualified });
    return this;
  },
  "attribute(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Lorg/xmlpull/v1/XmlSerializer;": function (this: JXmlSerializer, ns: string | null, name: string, value: string) {
    if (!this.openTag) throw rt.mkThrowable("java/lang/IllegalStateException", "attribute outside start tag");
    const prefix = this.prefix(ns ?? "", true);
    this.declare(); this.append(` ${prefix ? prefix + ":" : ""}${name}="${xmlAttr(value)}"`);
    return this;
  },
  "endTag(Ljava/lang/String;Ljava/lang/String;)Lorg/xmlpull/v1/XmlSerializer;": function (this: JXmlSerializer, ns: string | null, name: string) {
    const top = this.stack.at(-1);
    if (!top || top.name !== name || top.ns !== (ns ?? "")) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Mismatched XML end tag");
    this.stack.pop();
    if (this.openTag) { this.append(" />"); this.openTag = false; }
    else this.append("</" + top.qualified + ">");
    return this;
  },
  "text(Ljava/lang/String;)Lorg/xmlpull/v1/XmlSerializer;": function (this: JXmlSerializer, value: string) {
    this.finishTag(); this.append(xmlText(value)); return this;
  },
  "text([CII)Lorg/xmlpull/v1/XmlSerializer;": function (this: JXmlSerializer, chars: Uint16Array, off: number, len: number) {
    this.finishTag(); this.append(xmlText(charsToString(chars, off, len))); return this;
  },
  "cdsect(Ljava/lang/String;)V": function (this: JXmlSerializer, value: string) {
    this.finishTag(); this.append("<![CDATA[" + value.replace(/]]>/g, "]]]]><![CDATA[>") + "]]>");
  },
  "entityRef(Ljava/lang/String;)V": function (this: JXmlSerializer, value: string) { this.finishTag(); this.append("&" + value + ";"); },
  "comment(Ljava/lang/String;)V": function (this: JXmlSerializer, value: string) { this.finishTag(); this.append("<!--" + value + "-->"); },
  "processingInstruction(Ljava/lang/String;)V": function (this: JXmlSerializer, value: string) { this.finishTag(); this.append("<?" + value + "?>"); },
  "docdecl(Ljava/lang/String;)V": function (this: JXmlSerializer, value: string) { this.finishTag(); this.append("<!DOCTYPE " + value + ">"); },
  "ignorableWhitespace(Ljava/lang/String;)V": function (this: JXmlSerializer, value: string) { this.finishTag(); this.append(value); },
  "flush()V": async function (this: JXmlSerializer) {
    if (this.output == null) throw rt.mkThrowable("java/lang/IllegalStateException", "XML output not set");
    const data = this.chunks.join(""); this.chunks = [];
    if (data) {
      if (this.writer) await vcall(this.output, "write", "(Ljava/lang/String;)V", data);
      else await vcall(this.output, "write", "([B)V", new Int8Array(new TextEncoder().encode(data)));
    }
    await vcall(this.output, "flush", "()V");
  },
} });
export const newXmlSerializer = serializer;
