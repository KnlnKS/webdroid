import { mkdir, writeFile } from "node:fs/promises";
import { bundle } from "./bundle.ts";
await mkdir("dist-backend", { recursive: true });
await writeFile("dist-backend/server.mjs", await bundle("backend/index.ts", { platform: "node", define: { "process.env.NODE_ENV": '"production"' } }));
