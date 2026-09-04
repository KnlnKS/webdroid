import { describe, expect, test } from "bun:test";
import { rewriteTextureSwizzles, visibleUniforms } from "./swizzle";

describe("texture swizzle shader rewriting", () => {
  test("keeps directives first and wraps a direct sampler call", () => {
    const input = `#version 300 es\n#define MODE 1\n#extension GL_EXT_shader_texture_lod : enable\nprecision mediump float;\nuniform sampler2D font;\nout vec4 color;\nvoid main(){color=texture(font,vec2(0));}`;
    const got = rewriteTextureSwizzles(input, 7);
    expect(got.maps).toHaveLength(1);
    const map = got.maps[0];
    expect(map).toMatchObject({ sampler: "font", size: 1 });
    expect(got.source.indexOf("#extension")).toBeLessThan(got.source.indexOf(`uniform highp int ${map.mapUniform}`));
    expect(got.source).toContain(`f(texture(font,vec2(0)),${map.mapUniform})`);
    expect(got.source).toContain("if(m==1672)return v");
    expect(got.hidden.has(map.mapUniform)).toBe(true);
  });

  test("supports nested calls and literal sampler arrays", () => {
    const input = `#version 300 es\nprecision highp float;\nuniform sampler2D atlas[4];\nuniform sampler2D mask;\nout vec4 color;\nvoid main(){color=texture(atlas[2],texture(mask,vec2(0)).xy);}`;
    const got = rewriteTextureSwizzles(input, "fragment");
    const atlas = got.maps.find((m) => m.sampler === "atlas")!;
    const mask = got.maps.find((m) => m.sampler === "mask")!;
    expect(atlas.size).toBe(4);
    expect(got.source).toContain(`f(texture(atlas[2],`);
    expect(got.source).toContain(`f(texture(mask,vec2(0)),${mask.mapUniform})`);
    expect(got.source).toContain(`,${atlas.mapUniform}[2])`);
    expect(got.unsupported).toEqual([]);
  });

  test("does not rewrite comments, macros, shadow samplers, or indirect samplers", () => {
    const input = `#version 300 es\n#define SAMPLE(s,p) texture(s,p)\n// texture(fake, p)\nprecision highp float;\nuniform sampler2DShadow shadowMap;\nuniform sampler2D realMap;\nvec4 indirect(sampler2D s,vec2 p){return texture(s,p);}\nvoid main(){float x=texture(shadowMap,vec3(0));}`;
    const got = rewriteTextureSwizzles(input, 9);
    expect(got.source).toBe(input);
    expect(got.maps).toEqual([]);
    expect(got.unsupported).toContain("preprocessor:texture");
    expect(got.unsupported).toContain("texture:s");
    expect(got.unsupported.some((x) => x.includes("shadowMap"))).toBe(false);
  });

  test("emits integer result overloads only when used", () => {
    const input = `#version 300 es\nprecision highp float;\nuniform isampler2D si;\nuniform usampler2D su;\nvoid main(){ivec4 a=texelFetch(si,ivec2(0),0);uvec4 b=texelFetch(su,ivec2(0),0);}`;
    const got = rewriteTextureSwizzles(input, 11);
    expect(got.source).toContain("highp ivec4");
    expect(got.source).toContain("highp uvec4");
    expect(got.source).not.toContain("highp vec4 v");
  });
});

test("visibleUniforms builds both reflection index maps", () => {
  const infos = [
    { name: "color", size: 1, type: 0x8b52 },
    { name: "_hidden[0]", size: 3, type: 0x1404 },
    { name: "tex", size: 1, type: 0x8b5e },
  ] as WebGLActiveInfo[];
  const gl = {
    ACTIVE_UNIFORMS: 0x8b86,
    getProgramParameter: () => infos.length,
    getActiveUniform: (_program: WebGLProgram, index: number) => infos[index],
  } as unknown as WebGL2RenderingContext;
  const got = visibleUniforms(gl, {} as WebGLProgram, new Set(["_hidden"]));
  expect(got.infos.map((x) => x.name)).toEqual(["color", "tex"]);
  expect(got.guestToWeb).toEqual([0, 2]);
  expect([...got.webToGuest]).toEqual([0, -1, 1]);
});
