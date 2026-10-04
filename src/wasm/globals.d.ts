// What the engines ship and the TypeScript lib of this repository (ES2022, DOM) does not declare yet.
interface String {
  isWellFormed(): boolean;
}

declare namespace WebAssembly {
  class Tag {}
  class Exception {
    constructor(tag: Tag, payload: unknown[]);
    is(tag: Tag): boolean;
    getArg(tag: Tag, index: number): unknown;
  }
}
