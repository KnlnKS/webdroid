// A value or the Promise of one: a host path stays synchronous unless something it called waited, and allocates nothing then.
export type Maybe<T> = PromiseOrVal<T>;

/** `next` applied to `value`, after it settles when it is a promise; `failed` takes its rejection, as `then` does */
export function chain<A, B>(value: Maybe<A>, next: (v: A) => Maybe<B>, failed?: (e: unknown) => Maybe<B>): Maybe<B> {
  return value instanceof Promise ? value.then(next, failed) : next(value);
}
/** `value`, with `failed` taking its rejection when it is a promise */
export function caught<A>(value: Maybe<A>, failed: (e: unknown) => Maybe<A>): Maybe<A> { return value instanceof Promise ? value.catch(failed) : value; }
/** `f` over `items` from `at` on, each call after the Promise the one before answered, if it answered one */
export function each<T>(items: readonly T[], f: (item: T, i: number) => unknown, at = 0): PromiseOrVal<void> {
  for (; at < items.length; at++) {
    const r = f(items[at], at);
    if (r instanceof Promise) { const next = at + 1; return r.then(() => each(items, f, next)); }
  }
}
