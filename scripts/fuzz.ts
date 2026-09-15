import { inventory } from "./fuzz/inventory";

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "inventory":
    await inventory(args);
    break;
  default:
    throw new Error("usage: bun run fuzz <inventory|api|graphics|ui|replay|smoke> [options]");
}
