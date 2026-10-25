// Functions the generated code calls through table slots like any method: the class model's runtime (classes.ts) and the per-class allocators.
// A definition is registered by name; World.synthSlot gives it a slot with a lazy-link stub and compiles it with Compiler.buildSynthetic on first call.
import type { Code } from "./code.ts";
import type { ElemKind, Kind } from "./kinds.ts";
import type { Compiler } from "./j2w.ts";

export interface Synth { params: Kind[]; ret: Kind | "V"; body: (cx: Compiler, c: Code) => void; pure?: boolean }
/** the runtime functions, which link's modules register as they load: the class model's (classes.ts, members.ts, fields.ts, reflect.ts, signatures.ts), the
 *  scheduler's (sched.ts), Unsafe's (unsafe.ts), guest memory's (guest.ts) and the String literals' (strings.ts) */
export type RtName = `g${"ld" | "st"}${8 | 16 | 32 | 64}` | `g${"get" | "put"}_${ElemKind}`
  | "classOf" | "mkClass" | "instArr" | "astore" | "acopy" | "aclone" | "cnfe" | "initErroneous" | "initFail" | "mkField" | "declFields" | "nameEq" | "newMulti"
  | "methodArray" | "ctorArray" | "throwsArray" | "mkExec" | "mnameEq" | "findMethod" | "classArray" | "argp" | "fprep" | "fgetp" | "fbox" | "fget" | "fstore" | "fset"
  | "validateSignatures" | "blockStatus" | "menterSlow" | "mexitSlow" | "yieldNow" | "initWait" | "initWake" | "curThread" | "threadLoaderReady"
  | "ufield" | "uget" | "uput" | "strLit";
export const rtfns = new Map<string, Synth>();
/** registers the runtime function `name`; a pure one runs no Java code, which the compiler counts on to leave frames that call only such functions out of the depth */
export const rt = (name: RtName, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code) => void, pure = false) => rtfns.set(name, { params, ret, body, pure });
