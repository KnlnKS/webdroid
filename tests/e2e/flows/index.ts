import { existsSync } from "node:fs";
import { validateFlow, type Flow } from "../types.ts";
import { fitnotes } from "./fitnotes.ts";
import { mihonOnboarding, mihonApp } from "./mihon.ts";
import { flappybird } from "./flappybird.ts";
import { harmonic } from "./harmonic.ts";
import { calculatorm } from "./calculatorm.ts";
import { lichess } from "./lichess.ts";
import { doodlejump } from "./doodlejump.ts";
import { resy } from "./resy.ts";
import { reddit } from "./reddit.ts";
import { tiktok } from "./tiktok.ts";
import { youtube } from "./youtube.ts";
import { chatgpt } from "./chatgpt.ts";
import { komikku } from "./komikku.ts";

export const FLOWS: Flow[] = [fitnotes, mihonOnboarding, mihonApp, flappybird, harmonic, calculatorm, lichess, doodlejump, resy, reddit, tiktok, youtube, chatgpt, komikku];
for (const flow of FLOWS) validateFlow(flow);
/** the flows a name selects: the one it names exactly, else those it is a prefix of */
function flowsNamed(name: string): Flow[] {
  const exact = FLOWS.find((f) => f.app === name);
  return exact ? [exact] : FLOWS.filter((f) => name && f.app.startsWith(name));
}
/** the flows `names` (each a comma-separated list) select once each, else every flow but the live ones unless `live`; an unknown name throws, and
 *  with `apks` so does a flow whose apk is missing */
export function selectFlows(names: string[], { live = false, apks = false } = {}): Flow[] {
  const split = names.flatMap((list) => list.split(",")).map((name) => name.trim()), unknown = split.filter((name) => !flowsNamed(name).length);
  if (unknown.length) throw new Error(`unknown flow ${unknown.map((name) => JSON.stringify(name)).join(", ")}`);
  const flows = [...new Set(split.length ? split.flatMap(flowsNamed) : FLOWS.filter((flow) => live || flow.clock !== "live"))];
  const absent = apks ? flows.filter((flow) => !existsSync(`apks/${flow.apk}`)) : [];
  if (absent.length) throw new Error(absent.map((flow) => `${flow.app}: apks/${flow.apk} is missing`).join("\n"));
  return flows;
}
