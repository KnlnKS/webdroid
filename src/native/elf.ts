// ELF32/ARM shared-object loader: map PT_LOAD segments into guest memory, apply the four
// relocation kinds Android's static linker emits, expose exports/init arrays/exidx.

export interface Module {
  name: string;
  base: number;
  size: number;
  end: number;
  exports: Map<string, number>;
  initArray: number[];
  finiArray: number[];
  init: number;
  needed: string[];
  exidx: { addr: number; count: number };
  symbols: { addr: Uint32Array; names: string[] };
  textrel: boolean;
}

export type Resolver = (sym: string, weak: boolean, from: Module) => number;

export function loadElf(_name: string, _bytes: Uint8Array, _resolve: Resolver): Module {
  throw new Error("TODO loadElf");
}

export function symbolize(_mods: Iterable<Module>, _pc: number): string {
  throw new Error("TODO symbolize");
}
