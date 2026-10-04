// scratch: P.run() on the JS tier
import { jsTier } from "./oracle";
import { loadDexes } from "./lib";
import { join } from "node:path";
const call = await jsTier(loadDexes(join(process.argv[2], "classes.dex")));
console.log(await call(process.argv[3], "run", "()Ljava/lang/String;", []));
process.exit(0);
