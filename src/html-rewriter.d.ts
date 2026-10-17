// The Workers' HTMLRewriter (lol-html), which scripts/node-env.ts provides under node
interface HTMLRewriter {
  on(selector: string, handlers: import("html-rewriter-wasm").ElementHandlers): this;
  onDocument(handlers: import("html-rewriter-wasm").DocumentHandlers): this;
  transform(response: Response): Response;
}
declare var HTMLRewriter: { new (): HTMLRewriter; prototype: HTMLRewriter };
