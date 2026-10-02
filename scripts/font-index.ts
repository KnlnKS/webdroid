// The platform font index a page loads in place of reading every system font (src/android/fonts.ts).
//   bun scripts/font-index.ts > font-index.json
import { mountLocalPlatformData } from "./lib";

await mountLocalPlatformData();
const { platformFontIndex } = await import("../src/android/fonts");
process.stdout.write(JSON.stringify(await platformFontIndex()));
