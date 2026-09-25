import { JObj, rt } from "../runtime";
import { readStreamFully } from "./jio";
import { vcall } from "./jlang";
import { readerText } from "../../android/xmlpull";

class JDomNode extends JObj { node!: Node; }
class JDomDocument extends JDomNode { declare node: Document; }
class JDomElement extends JDomNode { declare node: Element; }
class JDomAttr extends JDomNode { declare node: Attr; }
class JDomList extends JObj { nodes!: NodeList | HTMLCollection; }
class JDomAttributes extends JObj { attrs!: NamedNodeMap; }
class JDomImplementation extends JObj { implementation = document.implementation; }
const nodeCache = new WeakMap<Node, JDomNode>();
function domNode(node: Node | null): JDomNode | null {
  if (!node) return null;
  const cached = nodeCache.get(node);
  if (cached) return cached;
  rt.link(node.nodeType === 9 ? "webdroid/DOMDocument" : node.nodeType === 1 ? "webdroid/DOMElement" : node.nodeType === 2 ? "webdroid/DOMAttr" : "webdroid/DOMNode");
  const wrapped = node.nodeType === 9 ? new JDomDocument() : node.nodeType === 1 ? new JDomElement() : node.nodeType === 2 ? new JDomAttr() : new JDomNode();
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
  "appendChild(Lorg/w3c/dom/Node;)Lorg/w3c/dom/Node;": function (this: JDomNode, child: JDomNode) { return domNode(this.node.appendChild(child.node)); },
  "getAttributes()Lorg/w3c/dom/NamedNodeMap;": function (this: JDomNode) {
    if (!(this.node instanceof Element)) return null;
    rt.link("webdroid/DOMAttributes");
    const attrs = new JDomAttributes(); attrs.attrs = this.node.attributes;
    return attrs;
  },
};
const documentMethods = {
  "getDocumentElement()Lorg/w3c/dom/Element;": function (this: JDomDocument) { return domNode(this.node.documentElement); },
  "getImplementation()Lorg/w3c/dom/DOMImplementation;": () => new JDomImplementation(),
  "getElementsByTagName(Ljava/lang/String;)Lorg/w3c/dom/NodeList;": function (this: JDomDocument, name: string) { return domList(this.node.getElementsByTagName(name)); },
  "createElement(Ljava/lang/String;)Lorg/w3c/dom/Element;": function (this: JDomDocument, name: string) { return domNode(this.node.createElement(name)); },
  "createAttribute(Ljava/lang/String;)Lorg/w3c/dom/Attr;": function (this: JDomDocument, name: string) { return domNode(this.node.createAttribute(name)); },
};
const elementMethods = {
  "getTagName()Ljava/lang/String;": function (this: JDomElement) { return this.node.tagName; },
  "getAttribute(Ljava/lang/String;)Ljava/lang/String;": function (this: JDomElement, name: string) { return this.node.getAttribute(name) ?? ""; },
  "getAttributeNS(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": function (this: JDomElement, ns: string | null, name: string) { return this.node.getAttributeNS(ns, name) ?? ""; },
  "hasAttribute(Ljava/lang/String;)Z": function (this: JDomElement, name: string) { return this.node.hasAttribute(name) ? 1 : 0; },
  "getElementsByTagName(Ljava/lang/String;)Lorg/w3c/dom/NodeList;": function (this: JDomElement, name: string) { return domList(this.node.getElementsByTagName(name)); },
  "setAttributeNode(Lorg/w3c/dom/Attr;)Lorg/w3c/dom/Attr;": function (this: JDomElement, attr: JDomAttr) { return domNode(this.node.setAttributeNode(attr.node)); },
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
rt.register({ name: "org/w3c/dom/NamedNodeMap", ctor: class extends JObj {}, methods: attributeMethods });
rt.register({ name: "org/w3c/dom/DOMImplementation", ctor: JDomImplementation, methods: {
  "createDocument(Ljava/lang/String;Ljava/lang/String;Lorg/w3c/dom/DocumentType;)Lorg/w3c/dom/Document;":
    function (this: JDomImplementation, namespace: string | null, name: string | null, type: JDomNode | null) {
      const doctype = type?.node;
      return domNode(this.implementation.createDocument(namespace, name ?? "", doctype instanceof DocumentType ? doctype : null));
    },
  "createDocumentType(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Lorg/w3c/dom/DocumentType;":
    function (this: JDomImplementation, name: string, publicId: string, systemId: string) {
      return domNode(this.implementation.createDocumentType(name, publicId, systemId));
    },
  "hasFeature(Ljava/lang/String;Ljava/lang/String;)Z": function (this: JDomImplementation, feature: string, version: string) {
    return this.implementation.hasFeature(feature, version) ? 1 : 0;
  },
} });
rt.register({ name: "org/w3c/dom/DocumentType", ctor: class extends JObj {}, ifaces: ["org/w3c/dom/Node"] });
rt.register({ name: "webdroid/DOMNode", ctor: JDomNode, ifaces: ["org/w3c/dom/Node"], methods: nodeMethods });
rt.register({ name: "webdroid/DOMDocument", ctor: JDomDocument, ifaces: ["org/w3c/dom/Document"], methods: { ...nodeMethods, ...documentMethods } });
rt.register({ name: "webdroid/DOMElement", ctor: JDomElement, ifaces: ["org/w3c/dom/Element"], methods: { ...nodeMethods, ...elementMethods } });
rt.register({ name: "webdroid/DOMNodeList", ctor: JDomList, ifaces: ["org/w3c/dom/NodeList"], methods: listMethods });
rt.register({ name: "webdroid/DOMAttr", ctor: JDomAttr, ifaces: ["org/w3c/dom/Attr"], methods: { ...nodeMethods, ...attrMethods } });
rt.register({ name: "webdroid/DOMAttributes", ctor: JDomAttributes, ifaces: ["org/w3c/dom/NamedNodeMap"], methods: attributeMethods });

class JDocumentBuilder extends JObj { namespaceAware = false; validating = false; }
function parseDocument(text: string): JDomNode {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) throw rt.mkThrowable("org/xml/sax/SAXParseException", "Invalid XML document");
  return domNode(doc)!;
}
rt.register({ name: "javax/xml/parsers/DocumentBuilder", ctor: JDocumentBuilder, methods: {
  "parse(Ljava/io/InputStream;)Lorg/w3c/dom/Document;": async (stream: unknown) => {
    if (!stream) rt.npe();
    return parseDocument(new TextDecoder().decode(await readStreamFully(stream)));
  },
  "parse(Lorg/xml/sax/InputSource;)Lorg/w3c/dom/Document;": async (source: { chars?: unknown; bytes?: unknown; encoding?: string | null } | null) => {
    if (!source) rt.npe();
    if (source!.chars) return parseDocument(await readerText(source!.chars));
    if (source!.bytes) return parseDocument(new TextDecoder(source!.encoding ?? "utf-8").decode(await readStreamFully(source!.bytes)));
    throw rt.mkThrowable("org/xml/sax/SAXException", "InputSource requires a stream or reader");
  },
  "newDocument()Lorg/w3c/dom/Document;": () => domNode(document.implementation.createDocument(null, "")),
  "getDOMImplementation()Lorg/w3c/dom/DOMImplementation;": () => new JDomImplementation(),
  "isNamespaceAware()Z": function (this: JDocumentBuilder) { return this.namespaceAware ? 1 : 0; },
  "isValidating()Z": function (this: JDocumentBuilder) { return this.validating ? 1 : 0; },
} });
class JDocumentBuilderFactory extends JObj { namespaceAware = false; validating = false; }
const externalAccess = new Set([
  "http://javax.xml.XMLConstants/property/accessExternalDTD",
  "http://javax.xml.XMLConstants/property/accessExternalSchema",
]);
rt.register({ name: "javax/xml/parsers/DocumentBuilderFactory", ctor: JDocumentBuilderFactory, methods: {
  "static newInstance()Ljavax/xml/parsers/DocumentBuilderFactory;": () => new JDocumentBuilderFactory(),
  // DOMParser cannot load external XML resources; these restrictions are already in force.
  "setAttribute(Ljava/lang/String;Ljava/lang/Object;)V": (name: string | null, value: unknown) => {
    if (name === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
    if (!externalAccess.has(name) || value !== "") throw rt.mkThrowable("java/lang/IllegalArgumentException", name);
  },
  "getAttribute(Ljava/lang/String;)Ljava/lang/Object;": (name: string | null) => {
    if (name === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
    if (!externalAccess.has(name)) throw rt.mkThrowable("java/lang/IllegalArgumentException", name);
    return "";
  },
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
const outputProperties = new Set(["version", "encoding", "standalone", "omit-xml-declaration", "indent", "method"]);

rt.register({ name: "javax/xml/transform/Source", ctor: class extends JObj {} });
rt.register({ name: "javax/xml/transform/Result", ctor: class extends JObj {} });
rt.register({ name: "javax/xml/transform/dom/DOMSource", ctor: JDomSource, ifaces: ["javax/xml/transform/Source"], methods: {
  "<init>(Lorg/w3c/dom/Node;)V": function (this: JDomSource, node: JDomNode | null) { this.node = node; },
  "getNode()Lorg/w3c/dom/Node;": function (this: JDomSource) { return this.node; },
} });
rt.register({ name: "javax/xml/transform/stream/StreamResult", ctor: JStreamResult, ifaces: ["javax/xml/transform/Result"], methods: {
  "<init>(Ljava/io/Writer;)V": function (this: JStreamResult, writer: unknown) { this.writer = writer; },
  "getWriter()Ljava/io/Writer;": function (this: JStreamResult) { return this.writer; },
} });
rt.register({ name: "javax/xml/transform/Transformer", ctor: JTransformer, methods: {
  "setOutputProperty(Ljava/lang/String;Ljava/lang/String;)V": function (this: JTransformer, name: string, value: string) {
    if (!outputProperties.has(name))
      throw rt.mkThrowable("java/lang/IllegalArgumentException", name);
    this.properties.set(name, value);
  },
  "transform(Ljavax/xml/transform/Source;Ljavax/xml/transform/Result;)V": async function (this: JTransformer, source: JDomSource, result: JStreamResult) {
    if (!source?.node || !result?.writer) throw rt.mkThrowable("javax/xml/transform/TransformerException", "Missing source or writer");
    const xml = new XMLSerializer().serializeToString(source.node.node);
    const version = this.properties.get("version") ?? "1.0";
    const encoding = this.properties.get("encoding") ?? "UTF-8";
    const standalone = this.properties.get("standalone") ?? "no";
    const declaration = this.properties.get("omit-xml-declaration") === "yes" ? "" : `<?xml version="${version}" encoding="${encoding}" standalone="${standalone}"?>`;
    await vcall(result.writer, "write", "(Ljava/lang/String;)V", declaration + xml);
  },
} });
rt.register({ name: "javax/xml/transform/TransformerFactory", ctor: JTransformerFactory, methods: {
  "static newInstance()Ljavax/xml/transform/TransformerFactory;": () => new JTransformerFactory(),
  "setAttribute(Ljava/lang/String;Ljava/lang/Object;)V": (name: string, value: unknown) => {
    if (!externalAccess.has(name) || value !== "") throw rt.mkThrowable("java/lang/IllegalArgumentException", name);
  },
  "newTransformer()Ljavax/xml/transform/Transformer;": () => new JTransformer(),
} });
