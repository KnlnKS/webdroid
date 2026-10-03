export async function snapshotDocument(doc: Document): Promise<{ width: number; height: number; data: string }> {
  const width = Math.max(1, doc.documentElement.scrollWidth, doc.defaultView?.innerWidth ?? 0);
  const height = Math.max(1, doc.documentElement.scrollHeight, doc.defaultView?.innerHeight ?? 0);
  if (width * height > 32_000_000) throw new Error("WebView snapshot exceeds bitmap limit");
  const root = doc.documentElement.cloneNode(true) as HTMLElement;
  root.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  for (const script of root.querySelectorAll("script")) script.remove();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(root)}</foreignObject></svg>`;
  const image = new Image();
  image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await image.decode();
  const canvas = doc.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0);
  return { width, height, data: canvas.toDataURL("image/png") };
}
