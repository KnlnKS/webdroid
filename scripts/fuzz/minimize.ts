import type { ApiCase, GraphicsCase, JsonPrimitive, ProbeArgument, ProbeCase } from "./model";

type Reproduces<T extends ProbeCase = ProbeCase> = (candidate: T) => Promise<boolean>;

function sequence(input: ProbeCase): readonly unknown[] {
  return input.kind === "api" ? input.calls : input.commands;
}

function withSequence<T extends ProbeCase>(input: T, items: readonly unknown[]): T {
  return (input.kind === "api" ? { ...input, calls: items } : { ...input, commands: items }) as T;
}

function shrinks(value: JsonPrimitive): JsonPrimitive[] {
  if (typeof value === "number") return [...new Set([0, 1, -1, Math.sign(value), Math.trunc(value / 2)])].filter((item) => item !== value);
  if (typeof value === "string") return [...new Set(["", value.slice(0, 1), value.slice(0, Math.floor(value.length / 2))])].filter((item) => item !== value);
  if (typeof value === "boolean") return value ? [false] : [];
  return [];
}

async function shrinkGraphics(input: GraphicsCase, reproduces: Reproduces<GraphicsCase>): Promise<GraphicsCase> {
  let current = input;
  for (let commandIndex = 0; commandIndex < current.commands.length; commandIndex++) {
    const command = current.commands[commandIndex]!;
    for (let argumentIndex = 0; argumentIndex < (command.args?.length ?? 0); argumentIndex++) {
      for (const value of shrinks(command.args![argumentIndex]!)) {
        const commands = current.commands.slice();
        const args = command.args!.slice();
        args[argumentIndex] = value;
        commands[commandIndex] = { ...command, args };
        const candidate = { ...current, commands };
        if (await reproduces(candidate)) { current = candidate; break; }
      }
    }
  }
  return current;
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

async function shrinkApi(input: ApiCase, reproduces: Reproduces<ApiCase>): Promise<ApiCase> {
  let current = input;
  for (let callIndex = -1; callIndex < current.calls.length; callIndex++) {
    const args = callIndex < 0 ? current.constructorArgs : current.calls[callIndex]?.args;
    if (!args) continue;
    for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex++) {
      for (const argument of argumentShrinks(args[argumentIndex]!)) {
        const nextArgs = args.slice();
        nextArgs[argumentIndex] = argument;
        const candidate = callIndex < 0
          ? { ...current, constructorArgs: nextArgs }
          : { ...current, calls: current.calls.map((call, index) => index === callIndex ? { ...call, args: nextArgs } : call) };
        if (await reproduces(candidate)) { current = candidate; break; }
      }
    }
  }
  return current;
}

export async function minimizeCase<T extends ProbeCase>(input: T, reproduces: Reproduces<T>): Promise<T> {
  let current: ProbeCase = input;
  for (let chunk = Math.floor(sequence(current).length / 2); chunk >= 1; chunk = Math.floor(chunk / 2)) {
    let start = 0;
    while (start < sequence(current).length) {
      const items = sequence(current);
      const candidate = withSequence(current, [...items.slice(0, start), ...items.slice(start + chunk)]);
      if (sequence(candidate).length && await reproduces(candidate as T)) current = candidate;
      else start += chunk;
    }
  }
  if (current.kind === "graphics") current = await shrinkGraphics(current, reproduces as Reproduces<GraphicsCase>);
  else current = await shrinkApi(current, reproduces as Reproduces<ApiCase>);
  return current as T;
}

export async function reproducesTwice<T extends ProbeCase>(input: T, reproduces: Reproduces<T>): Promise<boolean> {
  return await reproduces(input) && await reproduces(input);
}
