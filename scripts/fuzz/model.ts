export const SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ProbeArgument =
  | { kind: "null" }
  | { kind: "boolean"; value: boolean }
  | { kind: "byte" | "char" | "short" | "int"; value: number }
  | { kind: "long"; value: string }
  | { kind: "float" | "double"; value: number }
  | { kind: "string"; value: string }
  | { kind: "enum"; class: string; value: string }
  | { kind: "int-array" | "float-array"; value: number[] }
  | { kind: "string-array"; value: string[] };

export type ApiCall = {
  name: string;
  descriptor: string;
  args?: ProbeArgument[];
  owner?: string;
  static?: boolean;
  replaceReceiver?: boolean;
};

export type ApiCase = {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  kind: "api";
  owner: string;
  constructorDescriptor?: string;
  constructorArgs?: ProbeArgument[];
  calls: ApiCall[];
};

export type GraphicsCommand = { op: string; args?: JsonPrimitive[] };

export type GraphicsCase = {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  kind: "graphics";
  width: number;
  height: number;
  commands: GraphicsCommand[];
};

export type ProbeCase = ApiCase | GraphicsCase;

export type ProbeResult = {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  kind: ProbeCase["kind"];
} & (
  | { outcome: "value"; value: JsonValue }
  | { outcome: "exception"; exception: string; message: string }
);

export type FailureKind =
  | "exception-mismatch"
  | "value-mismatch"
  | "pixel-mismatch"
  | "missing-api"
  | "native-required"
  | "layout-error"
  | "draw-error"
  | "gl-error"
  | "wedge"
  | "timeout"
  | "harness-error";

export type Failure = {
  kind: FailureKind;
  fingerprint: string;
  detail: string;
  pixel?: { strictPct: number; tolerantPct: number; contentDiffPct: number };
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function argument(value: unknown, label: string): ProbeArgument {
  const input = record(value, label), kind = text(input.kind, `${label}.kind`);
  if (kind === "null") return { kind };
  if (kind === "boolean") return { kind, value: bool(input.value, `${label}.value`) };
  if (kind === "byte" || kind === "char" || kind === "short" || kind === "int") return { kind, value: number(input.value, `${label}.value`) };
  if (kind === "long" || kind === "string") return { kind, value: text(input.value, `${label}.value`) };
  if (kind === "float" || kind === "double") return { kind, value: number(input.value, `${label}.value`) };
  if (kind === "enum") return { kind, class: text(input.class, `${label}.class`), value: text(input.value, `${label}.value`) };
  if (kind === "int-array" || kind === "float-array") {
    if (!Array.isArray(input.value)) throw new Error(`${label}.value must be an array`);
    return { kind, value: input.value.map((item, index) => number(item, `${label}.value[${index}]`)) };
  }
  if (kind === "string-array") {
    if (!Array.isArray(input.value)) throw new Error(`${label}.value must be an array`);
    return { kind, value: input.value.map((item, index) => text(item, `${label}.value[${index}]`)) };
  }
  throw new Error(`unsupported argument kind ${kind}`);
}

function argumentsList(value: unknown, label: string): ProbeArgument[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => argument(item, `${label}[${index}]`));
}

function call(value: unknown, label: string): ApiCall {
  const input = record(value, label);
  const output: ApiCall = { name: text(input.name, `${label}.name`), descriptor: text(input.descriptor, `${label}.descriptor`) };
  const args = argumentsList(input.args, `${label}.args`);
  if (args) output.args = args;
  if (input.owner !== undefined) output.owner = text(input.owner, `${label}.owner`);
  if (input.static !== undefined) output.static = bool(input.static, `${label}.static`);
  if (input.replaceReceiver !== undefined) output.replaceReceiver = bool(input.replaceReceiver, `${label}.replaceReceiver`);
  return output;
}

function json(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => json(item, `${label}[${index}]`));
  const input = record(value, label), output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(input)) output[key] = json(item, `${label}.${key}`);
  return output;
}

export function validateProbeCase(value: unknown): ProbeCase {
  const input = record(value, "case");
  if (input.schemaVersion !== SCHEMA_VERSION) throw new Error(`unsupported case schema ${String(input.schemaVersion)}`);
  const id = text(input.id, "case.id");
  if (!id) throw new Error("case.id must not be empty");
  if (input.kind === "api") {
    const owner = text(input.owner, "case.owner");
    if (!Array.isArray(input.calls)) throw new Error("case.calls must be an array");
    const output: ApiCase = { schemaVersion: SCHEMA_VERSION, id, kind: "api", owner, calls: input.calls.map((item, index) => call(item, `case.calls[${index}]`)) };
    if (input.constructorDescriptor !== undefined) output.constructorDescriptor = text(input.constructorDescriptor, "case.constructorDescriptor");
    const constructorArgs = argumentsList(input.constructorArgs, "case.constructorArgs");
    if (constructorArgs) output.constructorArgs = constructorArgs;
    return output;
  }
  if (input.kind === "graphics") {
    if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || Number(input.width) < 1 || Number(input.height) < 1)
      throw new Error("graphics dimensions must be positive integers");
    if (!Array.isArray(input.commands)) throw new Error("case.commands must be an array");
    const commands = input.commands.map((value, index): GraphicsCommand => {
      const command = record(value, `case.commands[${index}]`);
      if (command.args !== undefined && !Array.isArray(command.args)) throw new Error(`case.commands[${index}].args must be an array`);
      return {
        op: text(command.op, `case.commands[${index}].op`),
        ...(command.args === undefined ? {} : { args: command.args.map((item, itemIndex) => {
          if (item === null || typeof item === "boolean" || typeof item === "string") return item;
          return number(item, `case.commands[${index}].args[${itemIndex}]`);
        }) }),
      };
    });
    return { schemaVersion: SCHEMA_VERSION, id, kind: "graphics", width: Number(input.width), height: Number(input.height), commands };
  }
  throw new Error(`unsupported case kind ${String(input.kind)}`);
}

export function validateProbeResult(value: unknown): ProbeResult {
  const input = record(value, "result");
  if (input.schemaVersion !== SCHEMA_VERSION) throw new Error(`unsupported result schema ${String(input.schemaVersion)}`);
  const id = text(input.id, "result.id");
  const kind = input.kind;
  if (kind !== "api" && kind !== "graphics") throw new Error(`unsupported result kind ${String(kind)}`);
  if (input.outcome === "value") return { schemaVersion: SCHEMA_VERSION, id, kind, outcome: "value", value: json(input.value, "result.value") };
  if (input.outcome === "exception") return {
    schemaVersion: SCHEMA_VERSION, id, kind, outcome: "exception",
    exception: text(input.exception, "result.exception"), message: text(input.message, "result.message"),
  };
  throw new Error(`unsupported result outcome ${String(input.outcome)}`);
}

export function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
}
