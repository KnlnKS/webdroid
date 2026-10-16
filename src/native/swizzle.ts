/** a swizzle map: the source channel of R, G, B and A in three bits each (0-3 a channel, 4 zero, 5 one); this one keeps them */
export const IDENTITY_SWIZZLE = 0x688;

interface SwizzleMap {
  sampler: string;
  mapUniform: string;
  size: number;
}

export interface SwizzleRewrite {
  source: string;
  maps: readonly SwizzleMap[];
  hidden: ReadonlySet<string>;
  unsupported: readonly string[];
}

interface Token {
  text: string;
  start: number;
  end: number;
}

interface Sampler extends SwizzleMap {
  array: boolean;
  kind: "float" | "int" | "uint";
  shadow: boolean;
  used: boolean;
}

const sampleFns = new Set([
  "texture", "textureProj", "textureLod", "textureOffset", "textureProjOffset",
  "textureLodOffset", "textureGrad", "textureGradOffset", "textureProjGrad",
  "textureProjGradOffset", "texelFetch", "texelFetchOffset",
]);
const SAMPLE_RE = [...sampleFns].map((fn) => [fn, new RegExp(`\\b${fn}\\s*\\(`)] as const);

function hashKey(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** the end of the preprocessor directive at `i`, past its backslash-continued lines and newline */
function directiveEnd(source: string, i: number): number {
  do {
    const nl = source.indexOf("\n", i + 1);
    if (nl < 0) return source.length;
    let p = nl - 1;
    if (source.charCodeAt(p) === 13) p--;
    i = nl + 1;
    if (source.charCodeAt(p) !== 92) break;
  } while (i < source.length);
  return i;
}
function scan(source: string, unsupported: string[]): Token[] {
  const tokens: Token[] = [];
  let i = 0, lineStart = true;
  while (i < source.length) {
    const c = source.charCodeAt(i);
    if (c === 10 || c === 13) { lineStart = true; i++; continue; }
    if (c === 32 || c === 9 || c === 12) { i++; continue; }
    if (source.startsWith("//", i)) {
      const e = source.indexOf("\n", i + 2);
      i = e < 0 ? source.length : e;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const e = source.indexOf("*/", i + 2);
      const end = e < 0 ? source.length : e + 2;
      if (source.slice(i, end).includes("\n")) lineStart = source.lastIndexOf("\n", end - 1) >= i;
      i = end;
      continue;
    }
    if (lineStart && c === 35) {
      const start = i;
      i = directiveEnd(source, i);
      const directive = source.slice(start, i);
      for (const [fn, re] of SAMPLE_RE) if (re.test(directive)) unsupported.push(`preprocessor:${fn}`);
      lineStart = true;
      continue;
    }
    lineStart = false;
    const start = i;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) {
      for (i++; i < source.length; i++) {
        const x = source.charCodeAt(i);
        if (!((x >= 65 && x <= 90) || (x >= 97 && x <= 122) || (x >= 48 && x <= 57) || x === 95)) break;
      }
    } else if (c >= 48 && c <= 57) {
      while (++i < source.length && source.charCodeAt(i) >= 48 && source.charCodeAt(i) <= 57) {}
    } else i++;
    tokens.push({ text: source.slice(start, i), start, end: i });
  }
  return tokens;
}

function samplerKind(type: string): Sampler["kind"] {
  return type.startsWith("isampler") ? "int" : type.startsWith("usampler") ? "uint" : "float";
}

function parseSamplers(tokens: Token[], prefix: string, unsupported: string[]): Map<string, Sampler> {
  const samplers = new Map<string, Sampler>();
  let nextMap = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text !== "uniform") continue;
    let typeAt = i + 1;
    if (/^(?:lowp|mediump|highp)$/.test(tokens[typeAt]?.text ?? "")) typeAt++;
    const type = tokens[typeAt]?.text ?? "";
    if (!/^(?:[iu]?sampler)/.test(type)) continue;
    for (let p = typeAt + 1; p < tokens.length && tokens[p].text !== ";";) {
      const name = tokens[p];
      if (!name || !/^[A-Za-z_]\w*$/.test(name.text)) break;
      p++;
      let size = 1, array = false;
      if (tokens[p]?.text === "[") {
        array = true;
        const n = tokens[p + 1], close = tokens[p + 2];
        if (!n || close?.text !== "]" || !/^\d+$/.test(n.text) || +n.text < 1) {
          unsupported.push(`sampler-array:${name.text}`);
          while (p < tokens.length && tokens[p].text !== "," && tokens[p].text !== ";") p++;
          if (tokens[p]?.text === ",") { p++; continue; }
          break;
        }
        size = +n.text;
        p += 3;
      }
      samplers.set(name.text, {
        sampler: name.text, mapUniform: `${prefix}m${nextMap++}`, size, array,
        kind: samplerKind(type), shadow: type.endsWith("Shadow"), used: false,
      });
      if (tokens[p]?.text === ",") { p++; continue; }
      break;
    }
  }
  return samplers;
}

function matching(tokens: Token[], open: number, left: string, right: string): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].text === left) depth++;
    else if (tokens[i].text === right && --depth === 0) return i;
  }
  return -1;
}

function stripParens(tokens: Token[], start: number, end: number): [number, number] {
  while (tokens[start]?.text === "(" && matching(tokens, start, "(", ")") === end - 1) { start++; end--; }
  return [start, end];
}

type Lookup = (name: string) => Sampler | undefined;
function samplerArg(source: string, tokens: Token[], start: number, end: number, lookup: Lookup): { sampler: Sampler; map: string } | null {
  [start, end] = stripParens(tokens, start, end);
  const sampler = lookup(tokens[start]?.text ?? "");
  if (!sampler || sampler.shadow) return null;
  if (start + 1 === end && !sampler.array) return { sampler, map: sampler.mapUniform };
  if (!sampler.array || tokens[start + 1]?.text !== "[") return null;
  const close = matching(tokens, start + 1, "[", "]");
  if (close !== end - 1) return null;
  const index = source.slice(tokens[start + 1].end, tokens[close].start);
  return { sampler, map: `${sampler.mapUniform}[${index}]` };
}

function preambleEnd(source: string): number {
  let i = 0, lastDirective = 0, depth = 0;
  while (i < source.length) {
    const c = source.charCodeAt(i);
    if (c === 9 || c === 10 || c === 12 || c === 13 || c === 32) { i++; continue; }
    if (source.startsWith("//", i)) {
      const nl = source.indexOf("\n", i + 2);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c !== 35) break;
    const start = i;
    i = directiveEnd(source, i);
    const directive = /^#\s*(\w+)/.exec(source.slice(start, i))?.[1];
    if (directive === "if" || directive === "ifdef" || directive === "ifndef") depth++;
    else if (directive === "endif") depth--;
    // Helpers must remain visible when a conditional extension is disabled.
    if (depth === 0) lastDirective = i;
  }
  return lastDirective;
}

function helpers(prefix: string, samplers: readonly Sampler[], kinds: ReadonlySet<Sampler["kind"]>): string {
  const declarations = samplers.map((s) => `uniform highp int ${s.mapUniform}${s.array ? `[${s.size}]` : ""};`).join("\n");
  const pick = (kind: Sampler["kind"]): string => {
    const vector = kind === "float" ? "vec4" : kind === "int" ? "ivec4" : "uvec4";
    const scalar = kind === "float" ? "float" : kind === "int" ? "int" : "uint";
    const one = kind === "float" ? "1.0" : kind === "int" ? "1" : "1u";
    const zero = kind === "float" ? "0.0" : kind === "int" ? "0" : "0u";
    return `highp ${scalar} ${prefix}p(highp ${vector} v, highp int s){return s<4?v[s]:(s==5?${one}:${zero});}\n`
      + `highp ${vector} ${prefix}f(highp ${vector} v, highp int m){if(m==${IDENTITY_SWIZZLE})return v;return ${vector}(${prefix}p(v,m&7),${prefix}p(v,(m>>3)&7),${prefix}p(v,(m>>6)&7),${prefix}p(v,(m>>9)&7));}`;
  };
  return `\n${declarations}\n${[...kinds].map(pick).join("\n")}\n`;
}

/** the top-level items of the parenthesized list from `open` to `close` (parameters or arguments), as token ranges */
function split(tokens: Token[], open: number, close: number): [number, number][] {
  if (close === open + 1) return [];
  const out: [number, number][] = [];
  let from = open + 1, depth = 0;
  for (let p = from; p < close; p++) {
    const text = tokens[p].text;
    if (text === "(" || text === "[") depth++; else if (text === ")" || text === "]") depth--;
    else if (text === "," && depth === 0) { out.push([from, p]); from = p + 1; }
  }
  out.push([from, close]);
  return out;
}

const IDENT = /^[A-Za-z_]\w*$/, SAMPLER_TYPE = /^[iu]?sampler(?:[123]D|Cube|Buffer|External)\w*$/;
interface SamplerFunction {
  /** the token of its name */
  name: number;
  key: string;
  /** the positions of the sampler parameters that take a map, the token each one ends at, and its map parameter */
  params: { index: number; end: number; map: string }[];
  /** its body's braces, and the samplers among its parameters */
  body: [number, number] | null;
  scope: Map<string, Sampler>;
}
/** Functions that take samplers: each sampler parameter is followed by an int parameter carrying its map, which calls pass. A key (name and arity) whose
 *  declarations disagree on where the samplers are is not rewritten: its calls cannot be told apart here. */
function samplerFunctions(tokens: Token[], prefix: string, unsupported: string[]): { fns: SamplerFunction[]; keys: Map<string, number[]> } {
  const fns: SamplerFunction[] = [], keys = new Map<string, number[] | null>();
  let depth = 0, next = 0;
  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i].text;
    if (text === "{") depth++; else if (text === "}") depth--;
    const before = tokens[i - 1]?.text ?? "";
    if (depth || tokens[i + 1]?.text !== "(" || !IDENT.test(text) || !IDENT.test(before) && before !== "]") continue;
    const close = matching(tokens, i + 1, "(", ")");
    if (close < 0) continue;
    const list = split(tokens, i + 1, close), params: SamplerFunction["params"] = [], scope = new Map<string, Sampler>();
    list.forEach(([from, to], index) => {
      // [qualifiers] type [name [size]]
      let end = from;
      while (end < to && tokens[end].text !== "[") end++;
      const type = end - 2 >= from && SAMPLER_TYPE.test(tokens[end - 2].text) ? end - 2 : end - 1;
      if (type < from || !SAMPLER_TYPE.test(tokens[type].text)) return;
      const name = type === end - 2 ? tokens[end - 1].text : null, shadow = tokens[type].text.endsWith("Shadow");
      if (end < to) { unsupported.push(`sampler-array-param:${text}`); return; }
      const map = `${prefix}a${next++}`;
      if (name) scope.set(name, { sampler: name, mapUniform: map, size: 1, array: false, kind: samplerKind(tokens[type].text), shadow, used: false });
      if (!shadow) params.push({ index, end: tokens[to - 1].end, map });
    });
    if (!scope.size && !params.length) continue;
    const key = `${text}/${list.length}`, indices = params.map((p) => p.index), prior = keys.get(key);
    if (prior === undefined) keys.set(key, indices);
    else if (prior && prior.join() !== indices.join()) { keys.set(key, null); unsupported.push(`sampler-overload:${text}`); }
    const open = tokens[close + 1]?.text === "{" ? close + 1 : -1, end = open < 0 ? -1 : matching(tokens, open, "{", "}");
    fns.push({ name: i, key, params, body: end < 0 ? null : [open, end], scope });
  }
  const agreed = new Map([...keys].filter((e): e is [string, number[]] => !!e[1]?.length));
  return { fns: fns.filter((f) => keys.get(f.key)), keys: agreed };
}

export function rewriteTextureSwizzles(source: string, shaderKey: string | number): SwizzleRewrite {
  const unsupported: string[] = [];
  let prefix = `_wdSwz${hashKey(String(shaderKey))}_`;
  for (let n = 0; source.includes(prefix); n++) prefix = `_wdSwz${hashKey(`${shaderKey}:${n}`)}_`;
  const tokens = scan(source, unsupported);
  const samplers = parseSamplers(tokens, prefix, unsupported);
  const { fns, keys } = samplerFunctions(tokens, prefix, unsupported);
  const insertions = new Map<number, string[]>();
  const kinds = new Set<Sampler["kind"]>();
  const add = (at: number, text: string): void => { const list = insertions.get(at); if (list) list.push(text); else insertions.set(at, [text]); };
  const declared = new Set(fns.map((f) => f.name)), callees = new Set([...keys.keys()].map((key) => key.slice(0, key.lastIndexOf("/"))));
  for (const f of fns) for (const p of f.params) add(p.end, `, highp int ${p.map}`);
  const bodies = fns.filter((f) => f.body).sort((a, b) => a.body![0] - b.body![0]);
  let inside = 0, scope: Map<string, Sampler> | undefined;
  const lookup: Lookup = (name) => scope?.get(name) ?? samplers.get(name);
  const argText = (from: number, to: number) => source.slice(tokens[from]?.start ?? 0, tokens[to - 1]?.end ?? 0).trim();

  for (let i = 0; i < tokens.length - 1; i++) {
    while (inside < bodies.length && bodies[inside].body![1] < i) inside++;
    scope = inside < bodies.length && bodies[inside].body![0] < i ? bodies[inside].scope : undefined;
    const fn = tokens[i].text;
    if (tokens[i + 1].text !== "(") continue;
    if (!sampleFns.has(fn)) {
      if (!callees.has(fn) || declared.has(i)) continue;
      const close = matching(tokens, i + 1, "(", ")"), args = close < 0 ? [] : split(tokens, i + 1, close), indices = keys.get(`${fn}/${args.length}`);
      for (const index of indices ?? []) {
        const [from, to] = args[index], arg = samplerArg(source, tokens, from, to, lookup);
        if (arg) arg.sampler.used = true; else unsupported.push(`${fn}:${argText(from, to)}`);
        add(tokens[to - 1].end, `,${arg?.map ?? IDENTITY_SWIZZLE}`);
      }
      continue;
    }
    const close = matching(tokens, i + 1, "(", ")");
    if (close < 0) { unsupported.push(`${fn}:unclosed`); continue; }
    const [first] = split(tokens, i + 1, close), comma = first && first[1] < close ? first[1] : -1;
    const arg = comma > 0 ? samplerArg(source, tokens, i + 2, comma, lookup) : null;
    if (!arg) {
      const text = comma > 0 ? argText(i + 2, comma) : "?";
      if (!lookup(text)?.shadow) unsupported.push(`${fn}:${text}`);
      continue;
    }
    arg.sampler.used = true;
    kinds.add(arg.sampler.kind);
    add(tokens[i].start, `${prefix}f(`);
    add(tokens[close].end, `,${arg.map})`);
  }

  if (!insertions.size) return { source, maps: [], hidden: new Set(), unsupported: [...new Set(unsupported)] };
  const used = [...samplers.values()].filter((s) => s.used);
  const at = preambleEnd(source);
  const line = source.slice(0, at).split("\n").length;
  add(at, `${helpers(prefix, used, kinds)}#line ${line}\n`);
  let rewritten = "", from = 0;
  for (const [at, values] of [...insertions].sort((a, b) => a[0] - b[0])) {
    rewritten += source.slice(from, at) + values.join("");
    from = at;
  }
  rewritten += source.slice(from);
  const maps = used.map(({ sampler, mapUniform, size }) => ({ sampler, mapUniform, size }));
  return { source: rewritten, maps, hidden: new Set(maps.map((m) => m.mapUniform)), unsupported: [...new Set(unsupported)] };
}

export interface VisibleUniforms {
  infos: readonly WebGLActiveInfo[];
  guestToWeb: readonly number[];
  webToGuest: Int32Array;
}

/** a uniform's name without the "[0]" WebGL reports for an array */
export const uniformBase = (info: WebGLActiveInfo): string => info.name.endsWith("[0]") ? info.name.slice(0, -3) : info.name;
export function visibleUniforms(gl: WebGL2RenderingContext, program: WebGLProgram, hidden: ReadonlySet<string>): VisibleUniforms {
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  const infos: WebGLActiveInfo[] = [], guestToWeb: number[] = [], webToGuest = new Int32Array(count).fill(-1);
  for (let web = 0; web < count; web++) {
    const info = gl.getActiveUniform(program, web);
    if (!info) continue;
    const base = uniformBase(info);
    if (hidden.has(base)) continue;
    webToGuest[web] = infos.length;
    guestToWeb.push(web);
    infos.push(info);
  }
  return { infos, guestToWeb, webToGuest };
}
