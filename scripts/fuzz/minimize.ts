import { validateGraphicsCommand, type JsonPrimitive, type ProbeArgument, type ProbeCase } from "./model.ts";

type Reproduces<T extends ProbeCase = ProbeCase> = (candidate: T) => Promise<boolean>;

function sequence(input: ProbeCase): readonly unknown[] {
  return input.kind === "api" ? input.calls : input.commands;
}

function withSequence<T extends ProbeCase>(input: T, items: readonly unknown[]): T {
  return (input.kind === "api" ? { ...input, calls: items } : { ...input, commands: items }) as T;
}

function shrinks(value: JsonPrimitive): JsonPrimitive[] {
  if (typeof value === "number") return [...new Set([0, Math.sign(value), Math.trunc(value / 2)])]
    .filter((item) => Math.abs(item) < Math.abs(value));
  if (typeof value === "string") return [...new Set(["", value.slice(0, 1), value.slice(0, Math.floor(value.length / 2))])]
    .filter((item) => item.length < value.length);
  if (typeof value === "boolean") return value ? [false] : [];
  return [];
}

function argumentShrinks(argument: ProbeArgument): ProbeArgument[] {
  if (argument.kind === "null" || argument.kind === "enum") return [];
  if (argument.kind === "int-array" || argument.kind === "float-array" || argument.kind === "string-array") {
    const value = argument.value;
    return value.length ? [{ ...argument, value: [] } as ProbeArgument, { ...argument, value: value.slice(0, Math.floor(value.length / 2)) } as ProbeArgument] : [];
  }
  if (argument.kind === "long") return shrinks(Number(argument.value)).map((value) => ({ ...argument, value: String(value) }));
  if (argument.kind === "boolean" || argument.kind === "string" || argument.kind === "byte" || argument.kind === "char" ||
      argument.kind === "short" || argument.kind === "int" || argument.kind === "float" || argument.kind === "double")
    return shrinks(argument.value).map((value) => ({ ...argument, value }) as ProbeArgument);
  return [];
}

export async function reproducesTwice<T extends ProbeCase>(input: T, reproduces: Reproduces<T>): Promise<boolean> {
  return await reproduces(input) && await reproduces(input);
}

type ReproducesBatch<T extends ProbeCase> = (candidates: readonly T[]) => Promise<readonly boolean[]>;

function argumentCandidates(input: ProbeCase): ProbeCase[] {
  const candidates: ProbeCase[] = [];
  if (input.kind === "graphics") {
    input.commands.forEach((command, commandIndex) => {
      if (!("args" in command)) return;
      command.args.forEach((value, argumentIndex) => {
      for (const shrunk of shrinks(value)) {
        const commands = input.commands.slice(), args: JsonPrimitive[] = command.args.slice();
        args[argumentIndex] = shrunk;
        try {
          commands[commandIndex] = validateGraphicsCommand({ op: command.op, args });
        } catch {
          continue;
        }
        candidates.push({ ...input, commands });
      }
      });
    });
  } else {
    const append = (callIndex: number, args: ProbeArgument[]) => args.forEach((value, argumentIndex) => {
      for (const shrunk of argumentShrinks(value)) {
        const nextArgs = args.slice(); nextArgs[argumentIndex] = shrunk;
        candidates.push(callIndex < 0
          ? { ...input, constructorArgs: nextArgs }
          : { ...input, calls: input.calls.map((call, index) => index === callIndex ? { ...call, args: nextArgs } : call) });
      }
    });
    if (input.constructorArgs) append(-1, input.constructorArgs);
    input.calls.forEach((call, index) => { if (call.args) append(index, call.args); });
  }
  return candidates;
}

export async function minimizeCaseBatched<T extends ProbeCase>(input: T, reproduces: ReproducesBatch<T>): Promise<T> {
  let current: ProbeCase = input;
  let rounds = 0;
  for (let chunk = Math.floor(sequence(current).length / 2); chunk >= 1; chunk = Math.floor(chunk / 2)) {
    for (; rounds < 4;) {
      const items = sequence(current), candidates: ProbeCase[] = [];
      for (let start = 0; start < items.length; start += chunk) {
        const candidate = withSequence(current, [...items.slice(0, start), ...items.slice(start + chunk)]);
        if (sequence(candidate).length) candidates.push(candidate);
      }
      if (!candidates.length) break;
      const matches = await reproduces(candidates as T[]);
      const match = matches.findIndex(Boolean);
      if (match < 0) break;
      current = candidates[match]!;
      rounds++;
    }
  }
  for (rounds = 0; rounds < 4; rounds++) {
    const candidates = argumentCandidates(current);
    if (!candidates.length) break;
    const matches = await reproduces(candidates as T[]);
    const match = matches.findIndex(Boolean);
    if (match < 0) break;
    current = candidates[match]!;
  }
  return current as T;
}
