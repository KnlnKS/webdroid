// libcore's SAX parser (org.apache.harmony.xml.ExpatParser) over expat's JNI boundary: a
// tokenizer that makes the callbacks org_apache_harmony_xml_ExpatParser.cpp makes, in its order,
// with its names. Input is consumed a whole token at a time as it arrives; a partial token waits
// for the next append. External entities are not fetched, as expat does not by default.

import { rt, driven, ranged, type Gen } from "../runtime.ts";
import { vcall } from "./jentry.ts";
import { charsToString } from "../abi.ts";
import { handle, ownedHandle, deref, release } from "../../android/handles.ts";

interface Name { uri: string; local: string; qName: string }
interface Attribute extends Name { value: string }
interface Context {
  namespaces: boolean;
  decoder: TextDecoder | null;
  encoding: string;
  buffer: string;
  line: number;
  column: number;
  /** the element names open, and the prefixes each declared */
  open: { qName: string; declared: string[] }[];
  scopes: Map<string, string>[];
  entities: Map<string, string>;
  rootSeen: boolean;
  rootClosed: boolean;
}

const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: "\"" };
const expatError = (message: string) => rt.mkThrowable("org/apache/harmony/xml/ExpatException", message);
const chars = (s: string) => Uint16Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

/** advance the position past `text`, as expat's line and column count it */
function consume(c: Context, text: string): void {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") { c.line++; c.column = 0; } else c.column++;
  }
  c.buffer = c.buffer.slice(text.length);
}
function expand(c: Context, text: string, attribute: boolean): string {
  if (attribute) text = text.replace(/[\t\n\r]/g, " ");
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_:][\w.:-]*);/g, (_, ref: string) => {
    if (ref[0] === "#") return String.fromCodePoint(ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10));
    const value = PREDEFINED[ref] ?? c.entities.get(ref);
    if (value === undefined) throw expatError("undefined entity");
    return value;
  });
}
function resolve(c: Context, qName: string, attribute: boolean): Name {
  if (!c.namespaces) return { uri: "", local: qName, qName };
  const colon = qName.indexOf(":"), prefix = colon < 0 ? "" : qName.slice(0, colon), local = colon < 0 ? qName : qName.slice(colon + 1);
  if (!prefix && attribute) return { uri: "", local, qName };
  let uri: string | undefined;
  for (let i = c.scopes.length - 1; i >= 0 && uri === undefined; i--) uri = c.scopes[i].get(prefix);
  if (uri === undefined && prefix) throw expatError("unbound prefix");
  return { uri: uri ?? "", local, qName };
}

const PARSER_NAME = "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V";
/** where the markup at the head of the buffer ends, or -1 when it is not complete yet */
function markupEnd(buffer: string): number {
  if (buffer.startsWith("<!--")) { const e = buffer.indexOf("-->", 4); return e < 0 ? -1 : e + 3; }
  if (buffer.startsWith("<![CDATA[")) { const e = buffer.indexOf("]]>", 9); return e < 0 ? -1 : e + 3; }
  if (buffer.startsWith("<?")) { const e = buffer.indexOf("?>", 2); return e < 0 ? -1 : e + 2; }
  if (buffer.startsWith("<!DOCTYPE")) {
    // the internal subset may itself hold '>' inside brackets
    let depth = 0;
    for (let i = 9; i < buffer.length; i++) {
      const ch = buffer[i];
      if (ch === "[") depth++;
      else if (ch === "]") depth--;
      else if (ch === ">" && depth <= 0) return i + 1;
      else if (ch === "\"" || ch === "'") { const e = buffer.indexOf(ch, i + 1); if (e < 0) return -1; i = e; }
    }
    return -1;
  }
  for (let i = 1, quote = ""; i < buffer.length; i++) {
    const ch = buffer[i];
    if (quote) { if (ch === quote) quote = ""; }
    else if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === ">") return i + 1;
    else if (ch === "<") throw expatError("not well-formed (invalid token)");
  }
  return -1;
}

/** endElement for the element just popped, then the end of each prefix it declared */
function* endElement(parser: unknown, c: Context, name: Name, declared: string[]): Gen<void> {
  yield vcall(parser, "endElement", PARSER_NAME, name.uri, name.local, name.qName);
  c.scopes.pop();
  for (const prefix of declared.reverse()) yield vcall(parser, "endNamespace", "(Ljava/lang/String;)V", prefix);
  if (!c.open.length) c.rootClosed = true;
}
const ATTRIBUTE = /\s*([^\s=]+)\s*=\s*(["'])([\s\S]*?)\2/g;

const parse = driven(function* (parser: unknown, c: Context, final: boolean): Gen<void> {
  if (final && c.decoder) c.buffer += c.decoder.decode();
  for (;;) {
    const b = c.buffer;
    if (!b) break;
    if (b[0] !== "<") {
      const lt = b.indexOf("<");
      if (lt < 0 && !final) break;
      const raw = lt < 0 ? b : b.slice(0, lt);
      if (c.open.length) {
        const text = expand(c, raw, false);
        if (text) yield vcall(parser, "text", "([CI)V", chars(text), text.length);
      } else if (raw.trim()) throw expatError(c.rootClosed ? "junk after document element" : "syntax error");
      consume(c, raw);
      continue;
    }
    const end = markupEnd(b);
    if (end < 0) { if (final) throw expatError("unclosed token"); break; }
    const token = b.slice(0, end);
    if (token.startsWith("<!--")) {
      const body = token.slice(4, -3);
      yield vcall(parser, "comment", "([CI)V", chars(body), body.length);
    } else if (token.startsWith("<![CDATA[")) {
      if (!c.open.length) throw expatError("syntax error");
      const body = token.slice(9, -3);
      yield vcall(parser, "startCdata", "()V");
      if (body) yield vcall(parser, "text", "([CI)V", chars(body), body.length);
      yield vcall(parser, "endCdata", "()V");
    } else if (token.startsWith("<?")) {
      const body = token.slice(2, -2), m = /^([^\s?]+)\s*([\s\S]*)$/.exec(body);
      if (!m) throw expatError("not well-formed (invalid token)");
      if (m[1] !== "xml") yield vcall(parser, "processingInstruction", "(Ljava/lang/String;Ljava/lang/String;)V", m[1], m[2]);
    } else if (token.startsWith("<!DOCTYPE")) {
      const m = /^<!DOCTYPE\s+([^\s[>]+)(?:\s+(?:PUBLIC\s+(["'])(.*?)\2\s+(["'])(.*?)\4|SYSTEM\s+(["'])(.*?)\6))?\s*(?:\[([\s\S]*)\])?\s*>$/.exec(token);
      if (!m) throw expatError("syntax error");
      yield vcall(parser, "startDtd", PARSER_NAME, m[1], m[3] ?? null, m[5] ?? m[7] ?? null);
      for (const e of (m[8] ?? "").matchAll(/<!ENTITY\s+([^\s%]+)\s+(["'])([\s\S]*?)\2\s*>/g)) if (!c.entities.has(e[1])) c.entities.set(e[1], e[3]);
      yield vcall(parser, "endDtd", "()V");
    } else if (token.startsWith("</")) {
      const qName = token.slice(2, -1).trim(), top = c.open.pop();
      if (!top || top.qName !== qName) throw expatError("mismatched tag");
      yield* endElement(parser, c, resolve(c, qName, false), top.declared);
    } else {
      if (c.rootClosed) throw expatError("junk after document element");
      const empty = token.endsWith("/>"), inner = token.slice(1, empty ? -2 : -1);
      const m = /^([^\s/>]+)([\s\S]*)$/.exec(inner);
      if (!m) throw expatError("not well-formed (invalid token)");
      const raw: [string, string][] = [];
      let rest = m[2];
      for (const a of rest.matchAll(ATTRIBUTE)) raw.push([a[1], expand(c, a[3], true)]);
      rest = rest.replace(ATTRIBUTE, "");
      if (rest.trim()) throw expatError("not well-formed (invalid token)");
      if (new Set(raw.map(([n]) => n)).size !== raw.length) throw expatError("duplicate attribute");
      const scope = new Map<string, string>(), declared: string[] = [];
      if (c.namespaces) for (const [n, v] of raw) {
        if (n === "xmlns" || n.startsWith("xmlns:")) {
          const prefix = n === "xmlns" ? "" : n.slice(6);
          scope.set(prefix, v); declared.push(prefix);
          yield vcall(parser, "startNamespace", "(Ljava/lang/String;Ljava/lang/String;)V", prefix, v);
        }
      }
      c.scopes.push(scope);
      const attributes = raw.filter(([n]) => !c.namespaces || !(n === "xmlns" || n.startsWith("xmlns:")))
        .map(([n, v]): Attribute => ({ ...resolve(c, n, true), value: v }));
      const name = resolve(c, m[1], false);
      c.rootSeen = true;
      c.open.push({ qName: m[1], declared });
      const pointer = handle(attributes);
      try { yield vcall(parser, "startElement", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;JI)V", name.uri, name.local, name.qName, pointer, attributes.length); }
      finally { release(pointer); }
      if (empty) {
        c.open.pop();
        yield* endElement(parser, c, name, declared);
      }
    }
    consume(c, token);
  }
  if (final) {
    if (c.buffer.trim() || !c.rootSeen || c.open.length) throw expatError(c.open.length || !c.rootSeen ? "no element found" : "junk after document element");
  }
});

function context(pointer: bigint): Context {
  const c = deref<Context | undefined>(pointer);
  if (!c) throw rt.mkThrowable("java/lang/IllegalStateException", "released parser");
  return c;
}
function newContext(encoding: string | null, namespaces: boolean): Context {
  return { namespaces, decoder: null, encoding: (encoding ?? "UTF-8").toLowerCase(), buffer: "", line: 1, column: 0, open: [],
    scopes: [new Map([["xml", "http://www.w3.org/XML/1998/namespace"]])], entities: new Map(), rootSeen: false, rootClosed: false };
}
const append = (parser: unknown, pointer: bigint, text: string, final: boolean) => {
  const c = context(pointer);
  c.buffer += text;
  return parse(parser, c, final);
};

const at = (pointer: bigint) => deref<Attribute[] | undefined>(pointer) ?? [];
const parserNatives: Record<string, (...args: never[]) => unknown> = {
  "staticInitialize(Ljava/lang/String;)V": () => {},
  "initialize(Ljava/lang/String;Z)J": (encoding: string | null, namespaces: number) => ownedHandle(newContext(encoding, !!namespaces)),
  "createEntityParser(JLjava/lang/String;)J": (pointer: bigint) => {
    const c = context(pointer), entity = newContext(c.encoding, c.namespaces);
    entity.scopes = c.scopes.map((s) => new Map(s));
    return ownedHandle(entity);
  },
  "appendString(JLjava/lang/String;Z)V": function (this: unknown, pointer: bigint, xml: string, final: number) { return append(this, pointer, xml, !!final); },
  "appendChars(J[CII)V": function (this: unknown, pointer: bigint, text: Uint16Array, offset: number, length: number) {
    return append(this, pointer, charsToString(text, offset, length), false);
  },
  "appendBytes(J[BII)V": ranged(function (this: unknown, pointer: bigint, bytes: Int8Array, offset: number, length: number) {
    const c = context(pointer), view = new Uint8Array(bytes.buffer, bytes.byteOffset + offset, length);
    // expat's own detection: a byte order mark names UTF-16, else the declared or default encoding
    c.decoder ??= new TextDecoder(view[0] === 0xfe && view[1] === 0xff ? "utf-16be" : view[0] === 0xff && view[1] === 0xfe ? "utf-16le" : c.encoding);
    return append(this, pointer, c.decoder.decode(view, { stream: true }), false);
  }, [1, 2, 3]),
  "line(J)I": (pointer: bigint) => context(pointer).line,
  "column(J)I": (pointer: bigint) => context(pointer).column,
  "cloneAttributes(JI)J": (pointer: bigint, count: number) => ownedHandle(at(pointer).slice(0, count)),
  "release(J)V": release,
  "releaseParser(J)V": release,
};
rt.registerJnis("org/apache/harmony/xml/ExpatParser", parserNatives);

const attributeNatives: Record<string, (...args: never[]) => unknown> = {
  "getURI(JJI)Ljava/lang/String;": (_c: bigint, pointer: bigint, i: number) => at(pointer)[i]?.uri ?? null,
  "getLocalName(JJI)Ljava/lang/String;": (_c: bigint, pointer: bigint, i: number) => at(pointer)[i]?.local ?? null,
  "getQName(JJI)Ljava/lang/String;": (_c: bigint, pointer: bigint, i: number) => at(pointer)[i]?.qName ?? null,
  "getValueByIndex(JI)Ljava/lang/String;": (pointer: bigint, i: number) => at(pointer)[i]?.value ?? null,
  "getIndex(JLjava/lang/String;Ljava/lang/String;)I": (pointer: bigint, uri: string, local: string) => at(pointer).findIndex((a) => a.uri === uri && a.local === local),
  "getIndexForQName(JLjava/lang/String;)I": (pointer: bigint, qName: string) => at(pointer).findIndex((a) => a.qName === qName),
  "getValue(JLjava/lang/String;Ljava/lang/String;)Ljava/lang/String;": (pointer: bigint, uri: string, local: string) =>
    at(pointer).find((a) => a.uri === uri && a.local === local)?.value ?? null,
  "getValueForQName(JLjava/lang/String;)Ljava/lang/String;": (pointer: bigint, qName: string) => at(pointer).find((a) => a.qName === qName)?.value ?? null,
  "freeAttributes(J)V": release,
};
rt.registerJnis("org/apache/harmony/xml/ExpatAttributes", attributeNatives);
