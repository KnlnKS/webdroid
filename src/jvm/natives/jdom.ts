import { JObj, rt, driven, type Gen } from "../runtime";
import { readStreamFully } from "./jio";
import { vcall } from "./jlang";
import { readerText } from "../../android/xmlpull";

class JDomNode extends JObj { node!: Node; }
class JDomDocument extends JDomNode { declare node: Document; }
class JDomElement extends JDomNode { declare node: Element; }
class JDomAttr extends JDomNode { declare node: Attr; }
class JDomText extends JDomNode { declare node: Text; }
class JDomList extends JObj { nodes!: NodeList | HTMLCollection; }
class JDomAttributes extends JObj { attrs!: NamedNodeMap; }
const domTypes: Record<number, [string, new () => JDomNode]> = {
  1: ["webdroid/DOMElement", JDomElement],
  2: ["webdroid/DOMAttr", JDomAttr],
  3: ["webdroid/DOMText", JDomText],
  9: ["webdroid/DOMDocument", JDomDocument],
};
const nodeCache = new WeakMap<Node, JDomNode>();
function domNode(node: Node | null): JDomNode | null {
  if (!node) return null;
  const cached = nodeCache.get(node);
  if (cached) return cached;
  const [name, Type] = domTypes[node.nodeType] ?? ["webdroid/DOMNode", JDomNode];
  rt.link(name);
  const wrapped = new Type();
  wrapped.node = node;
  nodeCache.set(node, wrapped);
  return wrapped;
}
function domList(nodes: NodeList | HTMLCollection): JDomList {
  rt.link("webdroid/DOMNodeList");
  const wrapped = new JDomList();
  wrapped.nodes = nodes;
  return wrapped;
}
const nodeMethods = {
  "getNodeName()Ljava/lang/String;": function (this: JDomNode) { return this.node.nodeName; },
  "getNodeValue()Ljava/lang/String;": function (this: JDomNode) { return this.node.nodeValue; },
  "getNodeType()S": function (this: JDomNode) { return this.node.nodeType; },
  "getNamespaceURI()Ljava/lang/String;": function (this: JDomNode) { return this.node instanceof Element || this.node instanceof Attr ? this.node.namespaceURI : null; },
  "getLocalName()Ljava/lang/String;": function (this: JDomNode) { return this.node instanceof Element || this.node instanceof Attr ? this.node.localName : null; },
  "getPrefix()Ljava/lang/String;": function (this: JDomNode) { return this.node instanceof Element || this.node instanceof Attr ? this.node.prefix : null; },
  "getTextContent()Ljava/lang/String;": function (this: JDomNode) { return this.node.textContent; },
  "setTextContent(Ljava/lang/String;)V": function (this: JDomNode, text: string | null) { this.node.textContent = text; },
  "appendChild(Lorg/w3c/dom/Node;)Lorg/w3c/dom/Node;": function (this: JDomNode, child: JDomNode | null) {
    if (!child) rt.npe();
    return domNode(this.node.appendChild(child!.node));
  },
  "removeChild(Lorg/w3c/dom/Node;)Lorg/w3c/dom/Node;": function (this: JDomNode, child: JDomNode | null) {
    if (!child) rt.npe();
    return domNode(this.node.removeChild(child!.node));
  },
  "getParentNode()Lorg/w3c/dom/Node;": function (this: JDomNode) { return domNode(this.node.parentNode); },
  "getOwnerDocument()Lorg/w3c/dom/Document;": function (this: JDomNode) { return domNode(this.node.ownerDocument); },
  "lookupPrefix(Ljava/lang/String;)Ljava/lang/String;": function (this: JDomNode, namespace: string | null) { return this.node.lookupPrefix(namespace); },
  "lookupNamespaceURI(Ljava/lang/String;)Ljava/lang/String;": function (this: JDomNode, prefix: string | null) { return this.node.lookupNamespaceURI(prefix); },
  "getFirstChild()Lorg/w3c/dom/Node;": function (this: JDomNode) { return domNode(this.node.firstChild); },
  "getLastChild()Lorg/w3c/dom/Node;": function (this: JDomNode) { return domNode(this.node.lastChild); },
  "getPreviousSibling()Lorg/w3c/dom/Node;": function (this: JDomNode) { return domNode(this.node.previousSibling); },
  "getNextSibling()Lorg/w3c/dom/Node;": function (this: JDomNode) { return domNode(this.node.nextSibling); },
  "getChildNodes()Lorg/w3c/dom/NodeList;": function (this: JDomNode) { return domList(this.node.childNodes); },
  "hasChildNodes()Z": function (this: JDomNode) { return this.node.hasChildNodes() ? 1 : 0; },
  "getAttributes()Lorg/w3c/dom/NamedNodeMap;": function (this: JDomNode) {
    if (!(this.node instanceof Element)) return null;
    rt.link("webdroid/DOMAttributes");
    const attrs = new JDomAttributes(); attrs.attrs = this.node.attributes;
    return attrs;
  },
};
const documentMethods = {
  "getDocumentElement()Lorg/w3c/dom/Element;": function (this: JDomDocument) { return domNode(this.node.documentElement); },
  "getElementsByTagName(Ljava/lang/String;)Lorg/w3c/dom/NodeList;": function (this: JDomDocument, name: string) { return domList(this.node.getElementsByTagName(name)); },
  "createElement(Ljava/lang/String;)Lorg/w3c/dom/Element;": function (this: JDomDocument, name: string) { return domNode(this.node.createElement(name)); },
  "createElementNS(Ljava/lang/String;Ljava/lang/String;)Lorg/w3c/dom/Element;": function (this: JDomDocument, namespace: string | null, name: string) { return domNode(this.node.createElementNS(namespace, name)); },
  "createAttribute(Ljava/lang/String;)Lorg/w3c/dom/Attr;": function (this: JDomDocument, name: string) { return domNode(this.node.createAttribute(name)); },
  "createTextNode(Ljava/lang/String;)Lorg/w3c/dom/Text;": function (this: JDomDocument, text: string) { return domNode(this.node.createTextNode(text)); },
};
const elementMethods = {
  "getTagName()Ljava/lang/String;": function (this: JDomElement) { return this.node.tagName; },
  "getAttribute(Ljava/lang/String;)Ljava/lang/String;": function (this: JDomElement, name: string) { return this.node.getAttribute(name) ?? ""; },
  "getAttributeNS(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": function (this: JDomElement, ns: string | null, name: string) { return this.node.getAttributeNS(ns, name) ?? ""; },
  "hasAttribute(Ljava/lang/String;)Z": function (this: JDomElement, name: string) { return this.node.hasAttribute(name) ? 1 : 0; },
  "setAttribute(Ljava/lang/String;Ljava/lang/String;)V": function (this: JDomElement, name: string, value: string) { this.node.setAttribute(name, value); },
  "setAttributeNode(Lorg/w3c/dom/Attr;)Lorg/w3c/dom/Attr;": function (this: JDomElement, attr: JDomAttr | null) {
    if (!attr) rt.npe();
    return domNode(this.node.setAttributeNode(attr!.node));
  },
  "getElementsByTagName(Ljava/lang/String;)Lorg/w3c/dom/NodeList;": function (this: JDomElement, name: string) { return domList(this.node.getElementsByTagName(name)); },
};
const listMethods = {
  "getLength()I": function (this: JDomList) { return this.nodes.length; },
  "item(I)Lorg/w3c/dom/Node;": function (this: JDomList, i: number) { return domNode(this.nodes.item(i)); },
};
const attrMethods = {
  "getName()Ljava/lang/String;": function (this: JDomAttr) { return this.node.name; },
  "getValue()Ljava/lang/String;": function (this: JDomAttr) { return this.node.value; },
  "setValue(Ljava/lang/String;)V": function (this: JDomAttr, value: string) { this.node.value = value; },
};
const attributeMethods = {
  "getLength()I": function (this: JDomAttributes) { return this.attrs.length; },
  "item(I)Lorg/w3c/dom/Node;": function (this: JDomAttributes, i: number) { return domNode(this.attrs.item(i)); },
  "getNamedItem(Ljava/lang/String;)Lorg/w3c/dom/Node;": function (this: JDomAttributes, name: string) { return domNode(this.attrs.getNamedItem(name)); },
};
rt.register({ name: "org/w3c/dom/Node", ctor: class extends JObj {}, methods: nodeMethods });
rt.register({ name: "org/w3c/dom/Document", ctor: class extends JObj {}, ifaces: ["org/w3c/dom/Node"], methods: documentMethods });
rt.register({ name: "org/w3c/dom/Element", ctor: class extends JObj {}, ifaces: ["org/w3c/dom/Node"], methods: elementMethods });
rt.register({ name: "org/w3c/dom/NodeList", ctor: class extends JObj {}, methods: listMethods });
rt.register({ name: "org/w3c/dom/Attr", ctor: class extends JObj {}, ifaces: ["org/w3c/dom/Node"], methods: attrMethods });
rt.register({ name: "org/w3c/dom/Text", ctor: class extends JObj {}, ifaces: ["org/w3c/dom/Node"] });
rt.register({ name: "org/w3c/dom/NamedNodeMap", ctor: class extends JObj {}, methods: attributeMethods });
rt.register({ name: "webdroid/DOMNode", ctor: JDomNode, ifaces: ["org/w3c/dom/Node"], methods: nodeMethods });
rt.register({ name: "webdroid/DOMDocument", ctor: JDomDocument, ifaces: ["org/w3c/dom/Document"], methods: { ...nodeMethods, ...documentMethods } });
rt.register({ name: "webdroid/DOMElement", ctor: JDomElement, ifaces: ["org/w3c/dom/Element"], methods: { ...nodeMethods, ...elementMethods } });
rt.register({ name: "webdroid/DOMNodeList", ctor: JDomList, ifaces: ["org/w3c/dom/NodeList"], methods: listMethods });
rt.register({ name: "webdroid/DOMAttr", ctor: JDomAttr, ifaces: ["org/w3c/dom/Attr"], methods: { ...nodeMethods, ...attrMethods } });
rt.register({ name: "webdroid/DOMText", ctor: JDomText, ifaces: ["org/w3c/dom/Text"], methods: nodeMethods });
rt.register({ name: "webdroid/DOMAttributes", ctor: JDomAttributes, ifaces: ["org/w3c/dom/NamedNodeMap"], methods: attributeMethods });

class JDocumentBuilder extends JObj { namespaceAware = false; validating = false; }
function parseDocument(text: string): JDomNode {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) throw rt.mkThrowable("org/xml/sax/SAXParseException", "Invalid XML document");
  return domNode(doc)!;
}
rt.register({ name: "javax/xml/parsers/DocumentBuilder", ctor: JDocumentBuilder, methods: {
  "parse(Ljava/io/InputStream;)Lorg/w3c/dom/Document;": driven(function* (stream: unknown): Gen  {
    if (!stream) rt.npe();
    return parseDocument(new TextDecoder().decode((yield readStreamFully(stream))));
  }),
  "parse(Lorg/xml/sax/InputSource;)Lorg/w3c/dom/Document;": driven(function* (source: { chars?: unknown; bytes?: unknown; encoding?: string | null } | null): Gen  {
    if (!source) rt.npe();
    if (source!.chars) return parseDocument((yield readerText(source!.chars)));
    if (source!.bytes) return parseDocument(new TextDecoder(source!.encoding ?? "utf-8").decode((yield readStreamFully(source!.bytes))));
    throw rt.mkThrowable("org/xml/sax/SAXException", "InputSource requires a stream or reader");
  }),
  "newDocument()Lorg/w3c/dom/Document;": () => domNode(document.implementation.createDocument(null, "")),
  "isNamespaceAware()Z": function (this: JDocumentBuilder) { return this.namespaceAware ? 1 : 0; },
  "isValidating()Z": function (this: JDocumentBuilder) { return this.validating ? 1 : 0; },
} });
class JDocumentBuilderFactory extends JObj { namespaceAware = false; validating = false; }
function externalAccessAttribute(name: string, value?: unknown): string {
  if (name !== "http://javax.xml.XMLConstants/property/accessExternalDTD" && name !== "http://javax.xml.XMLConstants/property/accessExternalSchema")
    throw rt.mkThrowable("java/lang/IllegalArgumentException", `Unsupported XML parser attribute: ${name}`);
  if (value !== undefined && value !== "")
    throw rt.mkThrowable("java/lang/IllegalArgumentException", `External XML access is unavailable: ${name}`);
  return "";
}
rt.register({ name: "javax/xml/parsers/DocumentBuilderFactory", ctor: JDocumentBuilderFactory, methods: {
  "static newInstance()Ljavax/xml/parsers/DocumentBuilderFactory;": () => new JDocumentBuilderFactory(),
  "setAttribute(Ljava/lang/String;Ljava/lang/Object;)V": externalAccessAttribute,
  "getAttribute(Ljava/lang/String;)Ljava/lang/Object;": (name: string) => externalAccessAttribute(name),
  "setNamespaceAware(Z)V": function (this: JDocumentBuilderFactory, value: number) { this.namespaceAware = !!value; },
  "isNamespaceAware()Z": function (this: JDocumentBuilderFactory) { return this.namespaceAware ? 1 : 0; },
  "setValidating(Z)V": function (this: JDocumentBuilderFactory, value: number) { this.validating = !!value; },
  "isValidating()Z": function (this: JDocumentBuilderFactory) { return this.validating ? 1 : 0; },
  "newDocumentBuilder()Ljavax/xml/parsers/DocumentBuilder;": function (this: JDocumentBuilderFactory) {
    const builder = new JDocumentBuilder();
    builder.namespaceAware = this.namespaceAware;
    builder.validating = this.validating;
    return builder;
  },
} });

class JDomSource extends JObj { node: JDomNode | null = null; }
class JStreamResult extends JObj { writer: unknown = null; }
class JTransformer extends JObj { properties = new Map<string, string>(); }
class JTransformerFactory extends JObj {}
rt.markers("javax/xml/transform/Source", "javax/xml/transform/Result");
rt.register({ name: "javax/xml/transform/dom/DOMSource", ctor: JDomSource, ifaces: ["javax/xml/transform/Source"], methods: {
  "<init>()V": function () {},
  "<init>(Lorg/w3c/dom/Node;)V": function (this: JDomSource, node: JDomNode) { this.node = node; },
  "getNode()Lorg/w3c/dom/Node;": function (this: JDomSource) { return this.node; },
  "setNode(Lorg/w3c/dom/Node;)V": function (this: JDomSource, node: JDomNode) { this.node = node; },
} });
rt.register({ name: "javax/xml/transform/stream/StreamResult", ctor: JStreamResult, ifaces: ["javax/xml/transform/Result"], methods: {
  "<init>()V": function () {},
  "<init>(Ljava/io/Writer;)V": function (this: JStreamResult, writer: unknown) { this.writer = writer; },
  "getWriter()Ljava/io/Writer;": function (this: JStreamResult) { return this.writer; },
  "setWriter(Ljava/io/Writer;)V": function (this: JStreamResult, writer: unknown) { this.writer = writer; },
} });
rt.register({ name: "javax/xml/transform/TransformerFactory", ctor: JTransformerFactory, methods: {
  "static newInstance()Ljavax/xml/transform/TransformerFactory;": () => new JTransformerFactory(),
  "setAttribute(Ljava/lang/String;Ljava/lang/Object;)V": externalAccessAttribute,
  "getAttribute(Ljava/lang/String;)Ljava/lang/Object;": (name: string) => externalAccessAttribute(name),
  "newTransformer()Ljavax/xml/transform/Transformer;": () => { rt.link("javax/xml/transform/Transformer"); return new JTransformer(); },
} });
rt.register({ name: "javax/xml/transform/Transformer", ctor: JTransformer, methods: {
  "setOutputProperty(Ljava/lang/String;Ljava/lang/String;)V": function (this: JTransformer, key: string, value: string) {
    if (!["version", "encoding", "standalone", "omit-xml-declaration", "indent", "method"].includes(key))
      throw rt.mkThrowable("java/lang/IllegalArgumentException", `Unsupported XML output property: ${key}`);
    if (key === "method" && value !== "xml") throw rt.mkThrowable("java/lang/IllegalArgumentException", `Unsupported XML output method: ${value}`);
    this.properties.set(key, value);
  },
  "getOutputProperty(Ljava/lang/String;)Ljava/lang/String;": function (this: JTransformer, key: string) { return this.properties.get(key) ?? null; },
  "transform(Ljavax/xml/transform/Source;Ljavax/xml/transform/Result;)V": function (this: JTransformer, source: unknown, result: unknown) {
    if (!(source instanceof JDomSource) || !source.node || !(result instanceof JStreamResult) || !result.writer)
      throw rt.mkThrowable("javax/xml/transform/TransformerException", "Unsupported XML transform source or result");
    const xml = new XMLSerializer().serializeToString(source.node.node);
    const declaration = this.properties.get("omit-xml-declaration") === "yes" ? "" :
      `<?xml version="${this.properties.get("version") ?? "1.0"}" encoding="${this.properties.get("encoding") ?? "UTF-8"}"${this.properties.has("standalone") ? ` standalone="${this.properties.get("standalone")}"` : ""}?>`;
    return vcall(result.writer, "write", "(Ljava/lang/String;)V", declaration + xml);
  },
} });
