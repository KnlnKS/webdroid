import { JObj, rt } from "../runtime";
import { readStreamFully } from "./jio";
import { readerText } from "../../android/xmlpull";

class JDomNode extends JObj { node!: Node; }
class JDomDocument extends JDomNode { declare node: Document; }
class JDomElement extends JDomNode { declare node: Element; }
class JDomAttr extends JDomNode { declare node: Attr; }
class JDomList extends JObj { nodes!: NodeList | HTMLCollection; }
class JDomAttributes extends JObj { attrs!: NamedNodeMap; }
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
};
const elementMethods = {
  "getTagName()Ljava/lang/String;": function (this: JDomElement) { return this.node.tagName; },
  "getAttribute(Ljava/lang/String;)Ljava/lang/String;": function (this: JDomElement, name: string) { return this.node.getAttribute(name) ?? ""; },
  "getAttributeNS(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": function (this: JDomElement, ns: string | null, name: string) { return this.node.getAttributeNS(ns, name) ?? ""; },
  "hasAttribute(Ljava/lang/String;)Z": function (this: JDomElement, name: string) { return this.node.hasAttribute(name) ? 1 : 0; },
  "getElementsByTagName(Ljava/lang/String;)Lorg/w3c/dom/NodeList;": function (this: JDomElement, name: string) { return domList(this.node.getElementsByTagName(name)); },
};
const listMethods = {
  "getLength()I": function (this: JDomList) { return this.nodes.length; },
  "item(I)Lorg/w3c/dom/Node;": function (this: JDomList, i: number) { return domNode(this.nodes.item(i)); },
};
const attrMethods = {
  "getName()Ljava/lang/String;": function (this: JDomAttr) { return this.node.name; },
  "getValue()Ljava/lang/String;": function (this: JDomAttr) { return this.node.value; },
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
  "isNamespaceAware()Z": function (this: JDocumentBuilder) { return this.namespaceAware ? 1 : 0; },
  "isValidating()Z": function (this: JDocumentBuilder) { return this.validating ? 1 : 0; },
} });
class JDocumentBuilderFactory extends JObj { namespaceAware = false; validating = false; }
rt.register({ name: "javax/xml/parsers/DocumentBuilderFactory", ctor: JDocumentBuilderFactory, methods: {
  "static newInstance()Ljavax/xml/parsers/DocumentBuilderFactory;": () => new JDocumentBuilderFactory(),
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
