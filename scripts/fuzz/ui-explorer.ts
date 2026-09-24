import { createReadStream, renameSync } from "node:fs";
import type { UiNode } from "../../tests/e2e/types";
import { Random } from "./random";
import { uiActionKey, uiActions, uiStateKey, validateUiAction, type UiAction } from "./ui-model";

const MAX_STATES = 256;
const MAX_ACTIONS_PER_STATE = 256;
const MAX_SCROLLS_PER_STATE = 4;
const MAX_PATH = 24;
const MAX_COVERAGE = 20_000;
const MAX_SIGNALS = 2_000;

export type UiPrefix = { actions: UiAction[]; states: string[]; target: string | null };
type State = Omit<UiPrefix, "target"> & { hasUntried: boolean; tried: string[]; discoveries: number; replayFailures: number };
type Journal = { schemaVersion: 1; apkHash: string; states: Record<string, State>; coverage: string[]; signals: string[] };

function availableActions(state: State, candidates: readonly UiAction[]): UiAction[] {
  if (state.tried.length >= MAX_ACTIONS_PER_STATE) return [];
  const counts = new Map<string, number>();
  for (const key of state.tried) counts.set(key, (counts.get(key) ?? 0) + 1);
  return candidates.filter((action) => (counts.get(uiActionKey(action)) ?? 0) <
    (action.type === "scroll" ? MAX_SCROLLS_PER_STATE : 1));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJournal(value: unknown, apkHash: string): Journal {
  if (!isObject(value) || value.schemaVersion !== 1 || value.apkHash !== apkHash || !isObject(value.states) ||
      !Array.isArray(value.coverage) || !value.coverage.every((item) => typeof item === "string") ||
      !Array.isArray(value.signals) || !value.signals.every((item) => typeof item === "string"))
    throw new Error("invalid or stale UI exploration journal");
  const states: Record<string, State> = {};
  for (const [key, raw] of Object.entries(value.states)) {
    if (!isObject(raw) || !Array.isArray(raw.actions) || !Array.isArray(raw.states) ||
        !raw.states.every((item) => typeof item === "string") || raw.states.length !== raw.actions.length ||
        typeof raw.hasUntried !== "boolean" || !Array.isArray(raw.tried) ||
        !raw.tried.every((item) => typeof item === "string") || typeof raw.discoveries !== "number" ||
        !Number.isSafeInteger(raw.discoveries) || raw.discoveries < 0 || typeof raw.replayFailures !== "number" ||
        !Number.isSafeInteger(raw.replayFailures) || raw.replayFailures < 0)
      throw new Error(`invalid UI exploration state ${key}`);
    states[key] = { actions: raw.actions.map((item, index) => validateUiAction(item, `${key}.actions[${index}]`)),
      states: raw.states,
      hasUntried: raw.hasUntried, tried: raw.tried, discoveries: raw.discoveries, replayFailures: raw.replayFailures };
  }
  return { schemaVersion: 1, apkHash, states, coverage: value.coverage, signals: value.signals };
}

export class UiExplorer {
  private readonly states: Record<string, State>;
  private readonly coverage: Set<string>;
  private readonly signals: Set<string>;
  private liveCandidates: UiAction[] = [];
  private liveKey = "";

  private constructor(private readonly file: string, private readonly apkHash: string, journal: Journal) {
    this.states = journal.states;
    this.coverage = new Set(journal.coverage);
    this.signals = new Set(journal.signals);
  }

  static async open(directory: string, pkg: string, apk: string): Promise<UiExplorer> {
    const digest = new Bun.CryptoHasher("sha256");
    for await (const chunk of createReadStream(apk)) digest.update(chunk);
    const apkHash = digest.digest("hex");
    const file = `${directory}/${pkg}-${apkHash.slice(0, 12)}.exploration.json`;
    const stored: unknown = await Bun.file(file).exists() ? JSON.parse(await Bun.file(file).text()) :
      { schemaVersion: 1, apkHash, states: {}, coverage: [], signals: [] };
    return new UiExplorer(file, apkHash, parseJournal(stored, apkHash));
  }

  get apkDigest(): string { return this.apkHash; }

  observeState(nodes: readonly UiNode[], width: number, height: number, prefix: UiPrefix): string {
    const key = uiStateKey(nodes);
    const candidates = uiActions(nodes, width, height);
    this.liveKey = key;
    this.liveCandidates = candidates;
    const current = this.states[key];
    if (!current && Object.keys(this.states).length < MAX_STATES && prefix.actions.length <= MAX_PATH)
      this.states[key] = { actions: [...prefix.actions], states: [...prefix.states], hasUntried: true,
        tried: [], discoveries: 0, replayFailures: 0 };
    else {
      if (current) {
        if (prefix.actions.length < current.actions.length) {
          current.actions = [...prefix.actions];
          current.states = [...prefix.states];
          current.replayFailures = 0;
        }
      }
    }
    const saved = this.states[key];
    if (saved) saved.hasUntried = availableActions(saved, candidates).length > 0;
    return key;
  }

  choose(key: string, random: Random): UiAction | null {
    const state = this.states[key];
    if (!state) return null;
    if (this.liveKey !== key || !state.hasUntried) return null;
    const available = availableActions(state, this.liveCandidates);
    const semantic = available.filter((action) => "target" in action);
    return (semantic.length ? random.pick(semantic) : available.length ? random.pick(available) : null);
  }

  observeAction(key: string, action: UiAction, coverage: readonly string[], signals: readonly string[], recordAttempt = true): number {
    const state = this.states[key];
    if (!state) throw new Error(`UI exploration state ${key} is absent`);
    const actionKey = uiActionKey(action);
    if (recordAttempt && state.tried.length < MAX_ACTIONS_PER_STATE && (action.type === "scroll" || !state.tried.includes(actionKey)))
      state.tried.push(actionKey);
    if (this.liveKey === key) state.hasUntried = availableActions(state, this.liveCandidates).length > 0;
    let discoveries = 0;
    for (const method of coverage) if (this.coverage.size < MAX_COVERAGE && !this.coverage.has(method)) { this.coverage.add(method); discoveries++; }
    for (const signal of signals) if (this.signals.size < MAX_SIGNALS && !this.signals.has(signal)) { this.signals.add(signal); discoveries++; }
    state.discoveries += discoveries;
    return discoveries;
  }

  nextPrefix(exclude: ReadonlySet<string>): UiPrefix | null {
    const frontiers = Object.entries(this.states).filter(([key, state]) =>
      state.hasUntried &&
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
    const journal: Journal = { schemaVersion: 1, apkHash: this.apkHash, states: this.states,
      coverage: [...this.coverage], signals: [...this.signals] };
    const temporary = `${this.file}.${process.pid}.tmp`;
    await Bun.write(temporary, JSON.stringify(journal));
    renameSync(temporary, this.file);
  }

  summary(): { states: number; actions: number; coverage: number; signals: number } {
    return { states: Object.keys(this.states).length, actions: Object.values(this.states).reduce((total, state) => total + state.tried.length, 0),
      coverage: this.coverage.size, signals: this.signals.size };
  }
}
