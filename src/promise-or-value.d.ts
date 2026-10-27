// A result a caller gets directly when the work finished synchronously and as a promise when it suspended.
type PromiseOrVal<T> = T | Promise<T>;
