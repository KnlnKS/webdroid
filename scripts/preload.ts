// Loaded (node --import) before every script: the generated modules src imports, then the host src assumes
import "./node-env.ts";
import { ensureGenerated } from "./generated.ts";

await ensureGenerated();
