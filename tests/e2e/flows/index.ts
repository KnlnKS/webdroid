import type { Flow } from "../types";
import { fitnotes } from "./fitnotes";
import { mihonOnboarding, mihonApp } from "./mihon";
import { flappybird } from "./flappybird";

export const FLOWS: Flow[] = [fitnotes, mihonOnboarding, mihonApp, flappybird];
