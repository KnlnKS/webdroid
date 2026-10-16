import { SCHEMA_VERSION, type ApiCall, type ApiCase, type GraphicsCase, type GraphicsCommand, type ProbeArgument } from "./model.ts";
import { Random } from "./random.ts";

const i = (value: number): ProbeArgument => ({ kind: "int", value });
const f = (value: number): ProbeArgument => ({ kind: "float", value });
const s = (value: string): ProbeArgument => ({ kind: "string", value });

export type ApiRecipeMember = { kind: "class" | "method"; owner: string; signature: string };
type RecipeGenerator = (random: Random, id: string) => ApiCase;
type ApiRecipe = { members: readonly ApiRecipeMember[]; generate: RecipeGenerator };

const apiRecipeMemberId = (member: ApiRecipeMember): string => `${member.kind}:${member.owner}.${member.signature}`;

const member = (kind: ApiRecipeMember["kind"], owner: string, signature: string): ApiRecipeMember => ({ kind, owner, signature });

const BUNDLE = "android/os/Bundle";
const BASE_BUNDLE = "android/os/BaseBundle";
const INTENT = "android/content/Intent";
const STRING = "Ljava/lang/String;";

type StoredValue = {
  name: string;
  descriptor: string;
  generate: (random: Random) => ProbeArgument;
};

const STORED_VALUES: readonly StoredValue[] = [
  { name: "Int", descriptor: "I", generate: (random) => i(random.pick([0, -1, 1, -2147483648, 2147483647, random.int(-10_000, 10_000)])) },
  { name: "Long", descriptor: "J", generate: (random) => ({ kind: "long", value: random.pick(["0", "-1", "1", "-9223372036854775808", "9223372036854775807", String(random.int(-10_000, 10_000))]) }) },
  { name: "Boolean", descriptor: "Z", generate: (random) => ({ kind: "boolean", value: random.chance(0.5) }) },
  { name: "String", descriptor: STRING, generate: (random) => random.chance(0.2) ? { kind: "null" } : s(random.pick(["", "text", "two words", "\uD83D\uDE80"])) },
  { name: "IntArray", descriptor: "[I", generate: (random) => ({ kind: "int-array", value: Array.from({ length: random.int(0, 5) }, () => random.int(-256, 256)) }) },
  { name: "StringArray", descriptor: "[Ljava/lang/String;", generate: (random) => ({ kind: "string-array", value: Array.from({ length: random.int(0, 5) }, () => random.pick(["", "a", "two words", "\uD83D\uDE80"])) }) },
];

const bundleMembers = [
  member("class", BUNDLE, BUNDLE), member("class", BASE_BUNDLE, BASE_BUNDLE), member("method", BUNDLE, "<init>()V"),
  ...STORED_VALUES.flatMap(({ name, descriptor }) => [
    member("method", BASE_BUNDLE, `put${name}(${STRING}${descriptor})V`),
    member("method", BASE_BUNDLE, `get${name}(${STRING})${descriptor}`),
    ...(descriptor === "I" || descriptor === "J" || descriptor === "Z" || descriptor === STRING
      ? [member("method", BASE_BUNDLE, `get${name}(${STRING}${descriptor})${descriptor}`)] : []),
  ]),
  ...["containsKey(Ljava/lang/String;)Z", "size()I"].map((signature) => member("method", BASE_BUNDLE, signature)),
  ...["remove(Ljava/lang/String;)V", "clear()V", "clone()Ljava/lang/Object;"].map((signature) => member("method", BUNDLE, signature)),
];

const intentMembers = [
  member("class", INTENT, INTENT), member("method", INTENT, "<init>()V"),
  ...STORED_VALUES.flatMap(({ name, descriptor }) => [
    member("method", INTENT, `putExtra(${STRING}${descriptor})Landroid/content/Intent;`),
    member("method", INTENT, `get${name}Extra(${STRING}${descriptor === "I" || descriptor === "J" || descriptor === "Z" ? descriptor : ""})${descriptor}`),
  ]),
  ...["hasExtra(Ljava/lang/String;)Z", "removeExtra(Ljava/lang/String;)V",
    "setAction(Ljava/lang/String;)Landroid/content/Intent;", "getAction()Ljava/lang/String;",
    "addCategory(Ljava/lang/String;)Landroid/content/Intent;", "hasCategory(Ljava/lang/String;)Z",
    "setFlags(I)Landroid/content/Intent;", "addFlags(I)Landroid/content/Intent;", "getFlags()I"].map((signature) => member("method", INTENT, signature)),
];

const key = (random: Random): ProbeArgument => s(random.pick(["", "a", "shared", "unicode-\uD83D\uDE80"]));
const rectangle = (random: Random): ProbeArgument[] => Array.from({ length: 4 }, () => i(random.int(-128, 128)));

function bundleCase(random: Random, id: string): ApiCase {
  const stored = random.pick(STORED_VALUES);
  const target = key(random);
  const calls: ApiCall[] = [
    { name: `put${stored.name}`, descriptor: `(${STRING}${stored.descriptor})V`, args: [target, stored.generate(random)] },
  ];
  if (random.chance(0.3)) calls.push({ name: `put${stored.name}`, descriptor: `(${STRING}${stored.descriptor})V`, args: [s("other"), stored.generate(random)] });
  if (random.chance(0.35)) calls.push({ name: `put${stored.name}`, descriptor: `(${STRING}${stored.descriptor})V`, args: [target, stored.generate(random)] });
  if (random.chance(0.25)) calls.push({ name: "remove", descriptor: `(${STRING})V`, args: [target] });
  if (random.chance(0.1)) calls.push({ name: "clear", descriptor: "()V" });
  if (random.chance(0.2)) calls.push({ name: "clone", descriptor: "()Ljava/lang/Object;", replaceReceiver: true });
  const observation = random.int(0, 3);
  if (observation === 0) calls.push({ name: "containsKey", descriptor: `(${STRING})Z`, args: [target] });
  else if (observation === 1) calls.push({ name: "size", descriptor: "()I" });
  else {
    const lookup = observation === 2 ? target : key(random);
    const useDefault = (stored.descriptor === "I" || stored.descriptor === "J" || stored.descriptor === "Z" || stored.descriptor === STRING)
      && random.chance(0.5);
    calls.push({ name: `get${stored.name}`, descriptor: `(${STRING}${useDefault ? stored.descriptor : ""})${stored.descriptor}`,
      args: useDefault ? [lookup, stored.generate(random)] : [lookup] });
  }
  return { schemaVersion: SCHEMA_VERSION, id, kind: "api", owner: BUNDLE, constructorDescriptor: "()V", calls };
}

function intentExtrasCase(random: Random, id: string): ApiCase {
  const stored = random.pick(STORED_VALUES);
  const target = key(random);
  const calls: ApiCall[] = [
    { name: "putExtra", descriptor: `(${STRING}${stored.descriptor})Landroid/content/Intent;`, args: [target, stored.generate(random)] },
  ];
  if (random.chance(0.3)) calls.push({ name: "putExtra", descriptor: `(${STRING}${stored.descriptor})Landroid/content/Intent;`, args: [s("other"), stored.generate(random)] });
  if (random.chance(0.35)) calls.push({ name: "putExtra", descriptor: `(${STRING}${stored.descriptor})Landroid/content/Intent;`, args: [target, stored.generate(random)] });
  if (random.chance(0.25)) calls.push({ name: "removeExtra", descriptor: `(${STRING})V`, args: [target] });
  const observation = random.int(0, 2);
  if (observation === 0) calls.push({ name: "hasExtra", descriptor: `(${STRING})Z`, args: [target] });
  else if (stored.descriptor === "I" || stored.descriptor === "J" || stored.descriptor === "Z") {
    const defaultValue = stored.generate(random);
    calls.push({ name: `get${stored.name}Extra`, descriptor: `(${STRING}${stored.descriptor})${stored.descriptor}`,
      args: [observation === 1 ? target : key(random), defaultValue] });
  } else calls.push({ name: `get${stored.name}Extra`, descriptor: `(${STRING})${stored.descriptor}`,
    args: [observation === 1 ? target : key(random)] });
  return { schemaVersion: SCHEMA_VERSION, id, kind: "api", owner: INTENT, constructorDescriptor: "()V", calls };
}

function intentMetadataCase(random: Random, id: string): ApiCase {
  const action = random.pick(["", "android.intent.action.VIEW", "org.example.ACTION"]);
  const category = random.pick(["", "android.intent.category.DEFAULT", "org.example.CATEGORY"]);
  const calls: ApiCall[] = random.chance(0.5)
    ? [{ name: "setAction", descriptor: `(${STRING})Landroid/content/Intent;`, args: [s(action)] },
      { name: "addCategory", descriptor: `(${STRING})Landroid/content/Intent;`, args: [s(category)] },
      random.chance(0.5) ? { name: "getAction", descriptor: `()${STRING}` }
        : { name: "hasCategory", descriptor: `(${STRING})Z`, args: [s(category)] }]
    : [{ name: "setFlags", descriptor: "(I)Landroid/content/Intent;", args: [i(random.int(0, 0xffff))] },
      { name: "addFlags", descriptor: "(I)Landroid/content/Intent;", args: [i(random.int(0, 0xffff))] },
      { name: "getFlags", descriptor: "()I" }];
  return { schemaVersion: SCHEMA_VERSION, id, kind: "api", owner: INTENT, constructorDescriptor: "()V", calls };
}

function randomApiRecipe(random: Random, id: string): ApiCase {
  return API_RECIPES[random.int(0, API_RECIPES.length - 1)]!.generate(random, id);
}

const API_RECIPES: readonly ApiRecipe[] = [
  {
    members: [member("class", "android/graphics/Color", "android/graphics/Color"), member("method", "android/graphics/Color", "rgb(III)I")],
    generate: (random, id) =>
      ({ schemaVersion: SCHEMA_VERSION, id, kind: "api", owner: "android/graphics/Color", calls: [{ name: "rgb", descriptor: "(III)I", static: true, args: [i(random.int(-64, 320)), i(random.int(-64, 320)), i(random.int(-64, 320))] }] }),
  },
  {
    members: [member("class", "android/graphics/Color", "android/graphics/Color"), member("method", "android/graphics/Color", "parseColor(Ljava/lang/String;)I")],
    generate: (random, id) =>
      ({ schemaVersion: SCHEMA_VERSION, id, kind: "api", owner: "android/graphics/Color", calls: [{ name: "parseColor", descriptor: "(Ljava/lang/String;)I", static: true, args: [s(random.pick(["#000000", "#ffffffff", "red", "transparent", "not-a-color"]))] }] }),
  },
  {
    members: [member("class", "android/graphics/Rect", "android/graphics/Rect"), member("method", "android/graphics/Rect", "<init>(IIII)V"),
      member("method", "android/graphics/Rect", "width()I"), member("method", "android/graphics/Rect", "height()I"),
      member("method", "android/graphics/Rect", "centerX()I"), member("method", "android/graphics/Rect", "centerY()I")],
    generate: (random, id) =>
      ({ schemaVersion: SCHEMA_VERSION, id, kind: "api", owner: "android/graphics/Rect", constructorDescriptor: "(IIII)V", constructorArgs: rectangle(random), calls: [{ name: random.pick(["width", "height", "centerX", "centerY"]), descriptor: "()I" }] }),
  },
  {
    members: [member("class", "android/graphics/Rect", "android/graphics/Rect"), member("method", "android/graphics/Rect", "<init>(IIII)V"), member("method", "android/graphics/Rect", "contains(II)Z")],
    generate: (random, id) =>
      ({ schemaVersion: SCHEMA_VERSION, id, kind: "api", owner: "android/graphics/Rect", constructorDescriptor: "(IIII)V", constructorArgs: rectangle(random), calls: [{ name: "contains", descriptor: "(II)Z", args: [i(random.int(-128, 128)), i(random.int(-128, 128))] }] }),
  },
  {
    members: [member("class", "android/net/Uri", "android/net/Uri"), member("method", "android/net/Uri", "parse(Ljava/lang/String;)Landroid/net/Uri;"),
      member("method", "android/net/Uri", "toString()Ljava/lang/String;"), member("method", "android/net/Uri", "getScheme()Ljava/lang/String;"),
      member("method", "android/net/Uri", "getHost()Ljava/lang/String;"), member("method", "android/net/Uri", "getPath()Ljava/lang/String;")],
    generate: (random, id) =>
      ({ schemaVersion: SCHEMA_VERSION, id, kind: "api", owner: "android/net/Uri", calls: [
        { name: "parse", descriptor: "(Ljava/lang/String;)Landroid/net/Uri;", static: true, replaceReceiver: true, args: [s(random.pick(["https://example.com/a?b=c#d", "content://org.example/items/1", "file:///tmp/a b", "mailto:a@example.com"]))] },
        { name: random.pick(["toString", "getScheme", "getHost", "getPath"]), descriptor: "()Ljava/lang/String;" },
      ] }),
  },
  {
    members: [member("class", "android/text/TextUtils", "android/text/TextUtils"), member("method", "android/text/TextUtils", "isEmpty(Ljava/lang/CharSequence;)Z")],
    generate: (random, id) =>
      ({ schemaVersion: SCHEMA_VERSION, id, kind: "api", owner: "android/text/TextUtils", calls: [{ name: "isEmpty", descriptor: "(Ljava/lang/CharSequence;)Z", static: true, args: [random.chance(0.2) ? { kind: "null" } : s(random.pick(["", "a", " android ", "\uD83D\uDE80"]))] }] }),
  },
  {
    members: [member("class", "android/graphics/Matrix", "android/graphics/Matrix"), member("method", "android/graphics/Matrix", "<init>()V"),
      member("method", "android/graphics/Matrix", "setRotate(F)V"), member("method", "android/graphics/Matrix", "setScale(FF)V"),
      member("method", "android/graphics/Matrix", "setTranslate(FF)V"), member("method", "android/graphics/Matrix", "isIdentity()Z")],
    generate: (random, id) => matrixCase(random, id),
  },
  { members: bundleMembers, generate: bundleCase },
  { members: intentMembers, generate: intentExtrasCase },
  { members: intentMembers, generate: intentMetadataCase },
] as const;

export const API_RECIPE_MEMBER_IDS = new Set(API_RECIPES.flatMap((recipe) => recipe.members.map(apiRecipeMemberId)));

function matrixCase(random: Random, id: string): ApiCase {
  const transform = random.pick([
    { name: "setRotate", descriptor: "(F)V", args: [f(random.int(-720, 720))] },
    { name: "setScale", descriptor: "(FF)V", args: [f(random.int(-4, 4)), f(random.int(-4, 4))] },
    { name: "setTranslate", descriptor: "(FF)V", args: [f(random.int(-128, 128)), f(random.int(-128, 128))] },
  ]);
  return { schemaVersion: SCHEMA_VERSION, id, kind: "api", owner: "android/graphics/Matrix", constructorDescriptor: "()V", constructorArgs: [], calls: [transform, { name: "isIdentity", descriptor: "()Z" }] };
}

export function generateApiCases(seed: number, count: number): ApiCase[] {
  const random = new Random(seed);
  return Array.from({ length: count }, (_, index) => randomApiRecipe(random, `api-${seed}-${index}`));
}

const COLOURS = [0x00000000, 0xff000000, 0xffffffff, 0xffff0000, 0xff00ff00, 0xff0000ff, 0x80808080].map((value) => value | 0);
const TEXT = ["", "A", "webdroid", "ffi 123", "\uD83D\uDE80"];

function coordinate(random: Random): number {
  return random.pick([-64, -1, 0, 1, 32, 64, 127, 128, 192, random.int(-128, 256)]);
}

const coordinates = (random: Random): [number, number, number, number] =>
  [coordinate(random), coordinate(random), coordinate(random), coordinate(random)];

const sixCoordinates = (random: Random): [number, number, number, number, number, number] =>
  [coordinate(random), coordinate(random), coordinate(random), coordinate(random), coordinate(random), coordinate(random)];

function drawCommand(random: Random): GraphicsCommand {
  switch (random.int(0, 20)) {
    case 0: return { op: "color", args: [random.pick(COLOURS)] };
    case 1: return { op: "alpha", args: [random.int(-32, 288)] };
    case 2: return { op: "strokeWidth", args: [random.pick([0, 1, 2, 8, 32])] };
    case 3: return { op: "style", args: [random.pick(["FILL", "STROKE", "FILL_AND_STROKE"])] };
    case 4: return { op: "textSize", args: [random.pick([0, 1, 8, 16, 32, 96])] };
    case 5: return { op: "drawRect", args: coordinates(random) };
    case 6: return { op: "drawCircle", args: [coordinate(random), coordinate(random), random.pick([-1, 0, 1, 16, 64, 192])] };
    case 7: return { op: "drawLine", args: coordinates(random) };
    case 8: return { op: "drawText", args: [random.pick(TEXT), coordinate(random), coordinate(random)] };
    case 9: return { op: "translate", args: [coordinate(random), coordinate(random)] };
    case 10: return { op: "scale", args: [random.pick([-2, -1, 0, 0.5, 1, 2]), random.pick([-2, -1, 0, 0.5, 1, 2])] };
    case 11: return { op: "rotate", args: [random.int(-720, 720)] };
    case 12: return { op: "clipRect", args: coordinates(random) };
    case 13: return { op: "drawOval", args: coordinates(random) };
    case 14: { const [left, top, right, bottom] = coordinates(random); return { op: "drawRoundRect", args: [left, top, right, bottom, random.int(0, 64), random.int(0, 64)] }; }
    case 15: { const [left, top, right, bottom] = coordinates(random); return { op: "drawArc", args: [left, top, right, bottom, random.int(-360, 360), random.int(-720, 720), random.chance(0.5)] }; }
    case 16: return { op: "antiAlias", args: [random.chance(0.5)] };
    case 17: return { op: "strokeCap", args: [random.pick(["BUTT", "ROUND", "SQUARE"])] };
    case 18: return { op: "strokeJoin", args: [random.pick(["MITER", "ROUND", "BEVEL"])] };
    case 19: return { op: "skew", args: [random.pick([-1, -0.5, 0, 0.5, 1]), random.pick([-1, -0.5, 0, 0.5, 1])] };
    default: return { op: "drawColor", args: [random.pick(COLOURS)] };
  }
}

function subsystemCommands(random: Random, index: number): GraphicsCommand[] {
  switch (index % 6) {
    case 0: return [
      { op: "pathMove", args: [coordinate(random), coordinate(random)] },
      { op: "pathCubic", args: sixCoordinates(random) },
      { op: "pathAddCircle", args: [coordinate(random), coordinate(random), random.int(0, 64), random.pick(["CW", "CCW"])] },
      { op: "pathFill", args: [random.pick(["WINDING", "EVEN_ODD", "INVERSE_WINDING", "INVERSE_EVEN_ODD"])] },
      { op: "drawPath" },
    ];
    case 1: return [
      { op: random.pick(["matrixScale", "matrixSkew"]), args: [random.pick([-2, -1, 0, 0.5, 1, 2]), random.pick([-2, -1, 0, 0.5, 1, 2])] },
      { op: "matrixPostTranslate", args: [coordinate(random), coordinate(random)] }, { op: "setMatrix" },
      { op: "drawRect", args: [0, 0, 64, 64] },
    ];
    case 2: return [{ op: "drawable", args: [random.pick(COLOURS), random.int(-32, 64), random.int(-32, 64), random.int(64, 160), random.int(64, 160), random.int(0, 255)] }];
    case 3: return [{ op: "renderNode", args: [random.int(-32, 32), random.int(-32, 32), random.int(64, 160), random.int(64, 160), random.next(), coordinate(random), coordinate(random)] }];
    case 4: return [{ op: "viewText", args: [random.pick(TEXT), random.pick(COLOURS), random.pick([8, 16, 32]), random.int(32, 128), random.int(16, 96)] }];
    default: return [
      { op: "bitmapDensity", args: [random.pick([0, 120, 160, 240, 320, 480, 640])] },
      { op: "blendMode", args: [random.pick([null, "SRC_OVER", "SRC_IN", "MULTIPLY", "SCREEN", "PLUS"])] },
      { op: "drawRect", args: [0, 0, 128, 128] },
    ];
  }
}

export function generateGraphicsCases(seed: number, count: number): GraphicsCase[] {
  const random = new Random(seed);
  return Array.from({ length: count }, (_, index) => {
    const commands: GraphicsCommand[] = [{ op: "drawColor", args: [0] }];
    let saveDepth = 0;
    const length = random.int(2, 24);
    for (let command = 0; command < length; command++) {
      if (random.chance(0.08)) { commands.push({ op: "save" }); saveDepth++; }
      else if (saveDepth && random.chance(0.08)) { commands.push({ op: "restore" }); saveDepth--; }
      else commands.push(drawCommand(random));
    }
    commands.push(...subsystemCommands(random, index));
    while (saveDepth-- > 0) commands.push({ op: "restore" });
    return { schemaVersion: SCHEMA_VERSION, id: `graphics-${seed}-${index}`, kind: "graphics", width: 128, height: 128, commands };
  });
}
