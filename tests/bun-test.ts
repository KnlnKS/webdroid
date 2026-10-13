// bun:test as scripts/test.ts runs it: node:test's runner and the matchers the tests use
import { describe as suite, test as nodeTest, before, after, mock as nodeMock } from "node:test";
import { inspect, isDeepStrictEqual } from "node:util";

const TIMEOUT_MS = 60_000;
type Body = () => void | Promise<void>;
type Test = (name: string, fn: Body, timeout?: number) => unknown;
// Bun runs a file's top-level beforeAll hooks before anything else; node's root hooks need not precede a suite's tests,
// so every test and suite hook first waits for them
const rootHooks: Body[] = [];
let rootRun: Promise<void> | null = null, depth = 0;
const afterRoot = (fn: Body): Body => async () => { await (rootRun ??= rootHooks.reduce<Promise<void>>((p, h) => p.then(h), Promise.resolve())); await fn(); };
export const test = Object.assign((name: string, fn: Body, timeout = TIMEOUT_MS) => nodeTest(name, { timeout }, afterRoot(fn)), {
  skipIf: (skip: boolean): Test => (name, fn, timeout = TIMEOUT_MS) => nodeTest(name, { timeout, skip }, afterRoot(fn)),
  each: <T>(cases: T[]) => (name: string, fn: (c: T) => void | Promise<void>, timeout?: number) =>
    cases.forEach((c) => test(name.replace("%s", String(c)), () => fn(c), timeout)),
});
export const it = test;
export const describe = (name: string, fn: () => void) => suite(name, () => { depth++; try { fn(); } finally { depth--; } });
export const beforeAll = (fn: Body, timeout = TIMEOUT_MS) => depth ? before(afterRoot(fn), { timeout }) : void rootHooks.push(fn);
export const afterAll = (fn: Body, timeout = TIMEOUT_MS) => after(fn, { timeout });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
/** bun's toEqual: recursive, undefined properties ignored, typed arrays by type and content, arrays by their elements */
function equals(a: unknown, b: unknown, strict: boolean): boolean {
  if (Object.is(a, b)) return true;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) return isDeepStrictEqual(a, b);
  if (!isObject(a) || !isObject(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equals(v, b[i], strict));
  if (a instanceof Map && b instanceof Map) return a.size === b.size && [...a].every(([k, v]) => b.has(k) && equals(v, b.get(k), strict));
  if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every((v) => b.has(v));
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => strict || o[k] !== undefined);
  const ka = keys(a), kb = keys(b);
  return ka.length === kb.length && ka.every((k) => equals(a[k], b[k], strict));
}
const matchesShape = (actual: unknown, shape: unknown): boolean =>
  !isObject(shape) || !isObject(actual) ? equals(actual, shape, false)
    : Array.isArray(shape) ? Array.isArray(actual) && actual.length === shape.length && shape.every((s, i) => matchesShape(actual[i], s))
    : Object.keys(shape).every((k) => matchesShape(actual[k], shape[k]));

type Matchers = Record<string, (...args: any[]) => void>;
function matchers(actual: any, negate: boolean): Matchers {
  const check = (pass: boolean, what: string, ...expected: unknown[]) => {
    if (pass === negate) throw new Error(`expected ${inspect(actual, { depth: 4 })} ${negate ? "not " : ""}${what} ${expected.map((e) => inspect(e, { depth: 4 })).join(" ")}`);
  };
  const thrown = (): { e: unknown } | null => { try { actual(); } catch (e) { return { e }; } return null; };
  return {
    toBe: (e) => check(Object.is(actual, e), "to be", e),
    toEqual: (e) => check(equals(actual, e, false), "to equal", e),
    toStrictEqual: (e) => check(equals(actual, e, true), "to strictly equal", e),
    toMatchObject: (e) => check(matchesShape(actual, e), "to match", e),
    toBeNull: () => check(actual === null, "to be null"),
    toBeUndefined: () => check(actual === undefined, "to be undefined"),
    toBeDefined: () => check(actual !== undefined, "to be defined"),
    toBeTruthy: () => check(!!actual, "to be truthy"),
    toBeFalsy: () => check(!actual, "to be falsy"),
    toBeNaN: () => check(Number.isNaN(actual), "to be NaN"),
    toBeFunction: () => check(typeof actual === "function", "to be a function"),
    toBeInstanceOf: (c) => check(actual instanceof c, "to be an instance of", c?.name),
    toBeGreaterThan: (n) => check(actual > n, "to be >", n),
    toBeGreaterThanOrEqual: (n) => check(actual >= n, "to be >=", n),
    toBeLessThan: (n) => check(actual < n, "to be <", n),
    toBeLessThanOrEqual: (n) => check(actual <= n, "to be <=", n),
    toBeCloseTo: (n, digits = 2) => check(Math.abs(actual - n) < 10 ** -digits / 2, "to be close to", n),
    toContain: (e) => check(typeof actual === "string" ? actual.includes(e) : [...actual].some((x) => Object.is(x, e)), "to contain", e),
    toHaveLength: (n) => check(actual?.length === n, "to have length", n),
    toStartWith: (s) => check(typeof actual === "string" && actual.startsWith(s), "to start with", s),
    toMatch: (r) => check(typeof r === "string" ? actual.includes(r) : r.test(actual), "to match", r),
    toHaveBeenCalled: () => check(actual.mock.calls.length > 0, "to have been called"),
    toHaveBeenCalledTimes: (n) => check(actual.mock.calls.length === n, "to have been called times", n),
    toThrow: (e?: unknown) => {
      const r = thrown(), message = r && (r.e instanceof Error ? r.e.message : String(r.e));
      check(!!r && (e === undefined || (typeof e === "string" ? message!.includes(e) : e instanceof RegExp ? e.test(message!)
        : typeof e === "function" ? r.e instanceof (e as new () => unknown) : message === (e as Error).message)), "to throw", e);
    },
  };
}
/** `expect(promise).rejects/resolves`: the settled value, then the matcher */
const settled = (actual: unknown, rejected: boolean) => new Proxy({}, { get: (_, name: string) => async (...args: unknown[]) => {
  let value: unknown, failed = false;
  try { value = await actual; } catch (e) { value = e; failed = true; }
  if (failed !== rejected) throw new Error(`expected ${rejected ? "a rejection" : "a value"}, got ${failed ? "rejection " : ""}${inspect(value)}`);
  return matchers(rejected && name === "toThrow" ? () => { throw value; } : value, false)[name](...args);
} }) as Matchers;
export function expect(actual: unknown) {
  return Object.assign(matchers(actual, false), { not: matchers(actual, true), rejects: settled(actual, true), resolves: settled(actual, false) });
}
type Mock = ((...args: any[]) => any) & { mock: { calls: unknown[][] }; mockImplementation(f: (...args: any[]) => any): Mock; mockResolvedValue(v: unknown): Mock; mockRestore(): void };
export function mock(fn: (...args: any[]) => any = () => {}): Mock {
  const calls: unknown[][] = [];
  let impl = fn;
  const m: Mock = Object.assign((...args: unknown[]) => { calls.push(args); return impl(...args); }, {
    mock: { calls },
    mockImplementation: (f: (...args: any[]) => any) => { impl = f; return m; },
    mockResolvedValue: (v: unknown) => { impl = () => Promise.resolve(v); return m; },
    mockRestore: () => {},
  });
  return m;
}
/** a mock over `o[key]` that calls through until given an implementation */
export function spyOn(o: Record<string, any>, key: string): Mock {
  const original = o[key], m = mock(original.bind(o));
  m.mockRestore = () => { o[key] = original; };
  o[key] = m;
  return m;
}
export const jest = {
  fn: mock,
  useFakeTimers: () => nodeMock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] }),
  useRealTimers: () => nodeMock.timers.reset(),
  runOnlyPendingTimers: () => nodeMock.timers.runAll(),
  advanceTimersByTime: (ms: number) => nodeMock.timers.tick(ms),
};
