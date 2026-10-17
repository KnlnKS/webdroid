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
