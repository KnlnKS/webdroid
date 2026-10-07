import { readdirSync } from "node:fs";

export const corpusApks = (dir = "apks"): string[] => readdirSync(dir).filter(name =>
  /\.x?apk$/i.test(name) && !/^(genshin|clashofclans|clashroyale)/.test(name.toLowerCase().replace(/[^a-z]/g, ""))).sort();
