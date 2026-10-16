import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { UiNode } from "../../tests/e2e/types.ts";
import type { Random } from "./random.ts";
import { uiActionKey, uiActions, uiScrollFamilyKey, uiStateKey, validateUiAction, type UiAction } from "./ui-model.ts";

const MAX_STATES = 256;
const MAX_ACTIONS_PER_STATE = 256;
const MAX_SCROLLS_PER_FAMILY = 4;
const MAX_PATH = 24;
const MAX_SIGNALS = 2_000;

export type UiPrefix = { actions: UiAction[]; states: string[]; target: string | null };
type Candidate = { key: string; scroll: boolean };
type State = Omit<UiPrefix, "target"> & { family: string; candidates: Candidate[]; tried: string[]; discoveries: number; replayFailures: number };
type Journal = { schemaVersion: 2; apkHash: string; states: Record<string, State>; scrollAttempts: Record<string, number>; signals: string[] };

function scrollKey(family: string, action: string): string { return JSON.stringify([family, action]); }

function available(state: State, candidate: Candidate, scrollAttempts: Record<string, number>): boolean {
  return state.tried.length < MAX_ACTIONS_PER_STATE && (candidate.scroll
    ? (scrollAttempts[scrollKey(state.family, candidate.key)] ?? 0) < MAX_SCROLLS_PER_FAMILY
    : !state.tried.includes(candidate.key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJournal(value: unknown, apkHash: string): Journal {
  if (!isObject(value) || value.schemaVersion !== 2 || value.apkHash !== apkHash || !isObject(value.states) ||
      !isObject(value.scrollAttempts) || Object.values(value.scrollAttempts).some((count) =>
        typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) ||
      !Array.isArray(value.signals) || !value.signals.every((item) => typeof item === "string"))
    throw new Error("invalid or stale UI exploration journal");
  const states: Record<string, State> = {};
  for (const [key, raw] of Object.entries(value.states)) {
    if (!isObject(raw) || !Array.isArray(raw.actions) || !Array.isArray(raw.states) ||
        !raw.states.every((item) => typeof item === "string") || raw.states.length !== raw.actions.length ||
        typeof raw.family !== "string" || !Array.isArray(raw.candidates) ||
        !raw.candidates.every((item) => isObject(item) && typeof item.key === "string" && typeof item.scroll === "boolean") ||
        !Array.isArray(raw.tried) ||
        !raw.tried.every((item) => typeof item === "string") || typeof raw.discoveries !== "number" ||
        !Number.isSafeInteger(raw.discoveries) || raw.discoveries < 0 || typeof raw.replayFailures !== "number" ||
        !Number.isSafeInteger(raw.replayFailures) || raw.replayFailures < 0)
      throw new Error(`invalid UI exploration state ${key}`);
    states[key] = { actions: raw.actions.map((item, index) => validateUiAction(item, `${key}.actions[${index}]`)),
      states: raw.states,
      family: raw.family, candidates: raw.candidates as Candidate[], tried: raw.tried,
      discoveries: raw.discoveries, replayFailures: raw.replayFailures };
  }
  return { schemaVersion: 2, apkHash, states, scrollAttempts: value.scrollAttempts as Record<string, number>,
    signals: value.signals };
}

export class UiExplorer {
  private readonly file: string; private readonly apkHash: string;
  private readonly states: Record<string, State>;
  private readonly signals: Set<string>;
  private readonly scrollAttempts: Record<string, number>;
  private liveCandidates: UiAction[] = [];
  private liveKey = "";

  private constructor(file: string, apkHash: string, journal: Journal) {
    this.file = file; this.apkHash = apkHash;
    this.states = journal.states;
    this.scrollAttempts = journal.scrollAttempts;
    this.signals = new Set(journal.signals);
  }

  static async open(directory: string, pkg: string, apk: string): Promise<UiExplorer> {
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(apk)) digest.update(chunk);
    const apkHash = digest.digest("hex");
    const file = `${directory}/${pkg}-${apkHash.slice(0, 12)}-v2.exploration.json`;
    const stored: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) :
      { schemaVersion: 2, apkHash, states: {}, scrollAttempts: {}, signals: [] };
    return new UiExplorer(file, apkHash, parseJournal(stored, apkHash));
  }

  get apkDigest(): string { return this.apkHash; }

  observeState(nodes: readonly UiNode[], width: number, height: number, prefix: UiPrefix): string {
    const key = uiStateKey(nodes);
    const candidates = uiActions(nodes, width, height);
    const family = uiScrollFamilyKey(nodes);
    this.liveKey = key;
    this.liveCandidates = candidates;
    const current = this.states[key];
    if (current && prefix.actions.length < current.actions.length) {
      current.actions = [...prefix.actions];
      current.states = [...prefix.states];
      current.replayFailures = 0;
    } else if (!current && Object.keys(this.states).length < MAX_STATES && prefix.actions.length <= MAX_PATH) {
      this.states[key] = { actions: [...prefix.actions], states: [...prefix.states], family, candidates: [],
        tried: [], discoveries: 0, replayFailures: 0 };
    }
    const saved = this.states[key];
    if (saved) {
      saved.family = family;
      saved.candidates = candidates.map((action) => ({ key: uiActionKey(action), scroll: action.type === "scroll" }));
    }
    return key;
  }

  choose(key: string, random: Random): UiAction | null {
    const state = this.states[key];
    if (!state || this.liveKey !== key) return null;
    const actions = this.liveCandidates.filter((action) => available(state,
      { key: uiActionKey(action), scroll: action.type === "scroll" }, this.scrollAttempts));
    const semantic = actions.filter((action) => "target" in action);
    return semantic.length ? random.pick(semantic) : actions.length ? random.pick(actions) : null;
  }

  observeAction(key: string, action: UiAction, signals: readonly string[], recordAttempt = true): number {
    const state = this.states[key];
    if (!state) throw new Error(`UI exploration state ${key} is absent`);
    const actionKey = uiActionKey(action);
    if (recordAttempt && state.tried.length < MAX_ACTIONS_PER_STATE && (action.type === "scroll" || !state.tried.includes(actionKey))) {
      state.tried.push(actionKey);
      if (action.type === "scroll") {
        const attemptKey = scrollKey(state.family, actionKey);
        this.scrollAttempts[attemptKey] = (this.scrollAttempts[attemptKey] ?? 0) + 1;
      }
    }
    let discoveries = 0;
    for (const signal of signals) if (this.signals.size < MAX_SIGNALS && !this.signals.has(signal)) { this.signals.add(signal); discoveries++; }
    state.discoveries += discoveries;
    return discoveries;
  }

  nextPrefix(exclude: ReadonlySet<string>): UiPrefix | null {
    const frontiers = Object.entries(this.states).filter(([key, state]) =>
      state.candidates.some((candidate) => available(state, candidate, this.scrollAttempts)) &&
      state.replayFailures < 3 && !exclude.has(JSON.stringify({ actions: state.actions, states: state.states, target: key })));
    frontiers.sort(([, left], [, right]) => left.actions.length - right.actions.length || right.discoveries - left.discoveries);
    const selected = frontiers[0];
    return selected ? { actions: selected[1].actions, states: selected[1].states, target: selected[0] } : null;
  }

  rejectPrefix(prefix: UiPrefix): void {
    const state = prefix.target ? this.states[prefix.target] : undefined;
    if (state && JSON.stringify(state.actions) === JSON.stringify(prefix.actions) &&
        JSON.stringify(state.states) === JSON.stringify(prefix.states)) state.replayFailures++;
  }

  async save(): Promise<void> {
    const journal: Journal = { schemaVersion: 2, apkHash: this.apkHash, states: this.states, scrollAttempts: this.scrollAttempts,
      signals: [...this.signals] };
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(journal));
    renameSync(temporary, this.file);
  }

  summary(): { states: number; actions: number; signals: number } {
    return { states: Object.keys(this.states).length, actions: Object.values(this.states).reduce((total, state) => total + state.tried.length, 0),
      signals: this.signals.size };
  }
}
