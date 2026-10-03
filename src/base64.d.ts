// ES2026 Uint8Array base64 and hex, which TypeScript's ES2022 lib does not declare yet
interface Uint8Array {
  toBase64(options?: { alphabet?: "base64" | "base64url"; omitPadding?: boolean }): string;
  toHex(): string;
}
interface Uint8ArrayConstructor {
  fromBase64(text: string, options?: { alphabet?: "base64" | "base64url"; lastChunkHandling?: "loose" | "strict" | "stop-before-partial" }): Uint8Array<ArrayBuffer>;
}
