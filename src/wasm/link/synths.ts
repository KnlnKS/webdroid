// Synthetic functions are made from their names: a runtime function's (rtfns.ts), or a family's and its argument, which names classes by name and members by index.
// Any World over the same Program makes the function another World's code or demand names.
import { rtfns, type Synth } from "../compiler/rtfns.ts";
import type { World } from "./world.ts";

const families = new Map<string, { make: (w: World, arg: string) => Synth | undefined; asked: boolean }>();

/** makes the functions named `family:arg`, or undefined when the Program lacks what `arg` names; `asked`: the host makes them when compiled code asks it
 *  (hostInfo), so a launch's demand records them for a build */
export function synthFamily(family: string, make: (w: World, arg: string) => Synth | undefined, asked = false): void { families.set(family, { make, asked }); }

const familyOf = (name: string) => { const at = name.indexOf(":"); return at < 0 ? undefined : families.get(name.slice(0, at)); };
/** the definition of synthetic function `name`, if the Program has what it names */
export function synthOf(w: World, name: string): Synth | undefined {
  return name.includes(":") ? familyOf(name)?.make(w, name.slice(name.indexOf(":") + 1)) : rtfns.get(name);
}
/** whether the host makes `name` when compiled code asks it */
export const askedSynth = (name: string): boolean => !!familyOf(name)?.asked;
/** `arg` as a class name and the index after its last colon */
export function memberArg(arg: string): [cls: string, index: number] { const at = arg.lastIndexOf(":"); return [arg.slice(0, at), +arg.slice(at + 1)]; }
