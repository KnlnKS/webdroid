// What a WebView page's renderer documents and the app tell each other.
import type { DocumentCookie } from "../webcookies";
import type { ClientHints } from "./clienthints";

/** the WebView settings' font faces, by their families, and the rules that use them */
export type WebFonts = { faces: { family: string; path: string; weight: string; style: string; stretch: string }[]; css: string };
export type AppMessage = { kind: string; [key: string]: unknown };
/** what the renderer bootstrap leaves the page script: the load's context */
export interface PageConfig {
  id?: string | null; page: string | null; agent?: string; interfaces?: Record<string, Record<string, boolean>>; cookies?: DocumentCookie[];
  clientHints?: ClientHints; sharedThread?: boolean; intercept?: boolean; sub?: boolean; frames?: string; fonts?: WebFonts;
  post?: ((data: object, transfer: Transferable[]) => void) | null; listen?: ((receive: (data: AppMessage) => void) => void) | null;
}

