declare module "libheif-js/libheif-wasm/libheif-bundle.mjs" {
  interface HeifImage {
    get_width(): number;
    get_height(): number;
    is_primary(): boolean;
    display(pixels: ImageData, done: (pixels: ImageData | null) => void): void;
    free(): void;
  }
  interface HeifDecoder {
    decoder: unknown;
    decode(bytes: Uint8Array): HeifImage[];
  }
  interface HeifModule {
    HeifDecoder: new () => HeifDecoder;
    heif_context_free(context: unknown): void;
  }
  export default function createModule(): Promise<HeifModule>;
}
