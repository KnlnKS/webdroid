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
      do {
        const nl = source.indexOf("\n", i + 1);
        if (nl < 0) { i = source.length; break; }
        let p = nl - 1;
        if (source.charCodeAt(p) === 13) p--;
        i = nl + 1;
        if (source.charCodeAt(p) !== 92) break;
      } while (i < source.length);
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

function samplerArg(source: string, tokens: Token[], start: number, end: number, samplers: Map<string, Sampler>): { sampler: Sampler; map: string } | null {
  [start, end] = stripParens(tokens, start, end);
  const sampler = samplers.get(tokens[start]?.text ?? "");
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
    do {
      const nl = source.indexOf("\n", i + 1);
      if (nl < 0) { i = source.length; break; }
      let p = nl - 1;
      if (source.charCodeAt(p) === 13) p--;
      i = nl + 1;
      if (source.charCodeAt(p) !== 92) break;
    } while (i < source.length);
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
      + `highp ${vector} ${prefix}f(highp ${vector} v, highp int m){if(m==1672)return v;return ${vector}(${prefix}p(v,m&7),${prefix}p(v,(m>>3)&7),${prefix}p(v,(m>>6)&7),${prefix}p(v,(m>>9)&7));}`;
  };
  return `\n${declarations}\n${[...kinds].map(pick).join("\n")}\n`;
}

export function rewriteTextureSwizzles(source: string, shaderKey: string | number): SwizzleRewrite {
  const unsupported: string[] = [];
  let prefix = `_wdSwz${hashKey(String(shaderKey))}_`;
  for (let n = 0; source.includes(prefix); n++) prefix = `_wdSwz${hashKey(`${shaderKey}:${n}`)}_`;
  const tokens = scan(source, unsupported);
  const samplers = parseSamplers(tokens, prefix, unsupported);
  const insertions = new Map<number, string[]>();
  const kinds = new Set<Sampler["kind"]>();
  const add = (at: number, text: string): void => { const list = insertions.get(at); if (list) list.push(text); else insertions.set(at, [text]); };

  for (let i = 0; i < tokens.length - 1; i++) {
    const fn = tokens[i].text;
    if (!sampleFns.has(fn) || tokens[i + 1].text !== "(") continue;
    const close = matching(tokens, i + 1, "(", ")");
    if (close < 0) { unsupported.push(`${fn}:unclosed`); continue; }
    let comma = -1, parens = 0, brackets = 0;
    for (let p = i + 2; p < close; p++) {
      const text = tokens[p].text;
      if (text === "(") parens++; else if (text === ")") parens--;
      else if (text === "[") brackets++; else if (text === "]") brackets--;
      else if (text === "," && parens === 0 && brackets === 0) { comma = p; break; }
    }
    const arg = comma > 0 ? samplerArg(source, tokens, i + 2, comma, samplers) : null;
    if (!arg) {
      const argText = comma > 0 ? source.slice(tokens[i + 2]?.start ?? tokens[i + 1].end, tokens[comma].start).trim() : "?";
      const shadow = samplers.get(argText)?.shadow;
      if (!shadow) unsupported.push(`${fn}:${argText}`);
      continue;
    }
    arg.sampler.used = true;
    kinds.add(arg.sampler.kind);
    add(tokens[i].start, `${prefix}f(`);
    add(tokens[close].end, `,${arg.map})`);
  }

  const used = [...samplers.values()].filter((s) => s.used);
  if (!used.length) return { source, maps: [], hidden: new Set(), unsupported: [...new Set(unsupported)] };
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
