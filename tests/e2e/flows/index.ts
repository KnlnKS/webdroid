import type { Flow } from "../types";
import { fitnotes } from "./fitnotes";
import { mihonOnboarding, mihonApp } from "./mihon";
import { flappybird } from "./flappybird";
import { harmonic } from "./harmonic";
import { calculatorm } from "./calculatorm";
import { lichess } from "./lichess";
import { doodlejump } from "./doodlejump";
import { resy } from "./resy";
import { reddit } from "./reddit";
import { tiktok } from "./tiktok";

export const FLOWS: Flow[] = [fitnotes, mihonOnboarding, mihonApp, flappybird, harmonic, calculatorm, lichess, doodlejump, resy, reddit, tiktok];
