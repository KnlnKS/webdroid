import { SCHEMA_VERSION, type ApiCase, type GraphicsCase, type GraphicsCommand, type ProbeArgument } from "./model";
import { Random } from "./random";

const i = (value: number): ProbeArgument => ({ kind: "int", value });
const f = (value: number): ProbeArgument => ({ kind: "float", value });
const s = (value: string): ProbeArgument => ({ kind: "string", value });

function apiRecipe(random: Random, id: string): ApiCase {
  const rect = [random.int(-128, 128), random.int(-128, 128), random.int(-128, 128), random.int(-128, 128)];
  switch (random.int(0, 6)) {
    case 0:
      return { schemaVersion: SCHEMA_VERSION, id, kind: "api", owner: "android/graphics/Color", calls: [{ name: "rgb", descriptor: "(III)I", static: true, args: [i(random.int(-64, 320)), i(random.int(-64, 320)), i(random.int(-64, 320))] }] };
    case 1:
      return { schemaVersion: SCHEMA_VERSION, id, kind: "api", owner: "android/graphics/Color", calls: [{ name: "parseColor", descriptor: "(Ljava/lang/String;)I", static: true, args: [s(random.pick(["#000000", "#ffffffff", "red", "transparent", "not-a-color"]))] }] };
    case 2:
      return { schemaVersion: SCHEMA_VERSION, id, kind: "api", owner: "android/graphics/Rect", constructorDescriptor: "(IIII)V", constructorArgs: rect.map(i), calls: [{ name: random.pick(["width", "height", "centerX", "centerY"]), descriptor: "()I" }] };
    case 3:
      return { schemaVersion: SCHEMA_VERSION, id, kind: "api", owner: "android/graphics/Rect", constructorDescriptor: "(IIII)V", constructorArgs: rect.map(i), calls: [{ name: "contains", descriptor: "(II)Z", args: [i(random.int(-128, 128)), i(random.int(-128, 128))] }] };
    case 4:
      return { schemaVersion: SCHEMA_VERSION, id, kind: "api", owner: "android/net/Uri", calls: [
        { name: "parse", descriptor: "(Ljava/lang/String;)Landroid/net/Uri;", static: true, replaceReceiver: true, args: [s(random.pick(["https://example.com/a?b=c#d", "content://org.example/items/1", "file:///tmp/a b", "mailto:a@example.com"]))] },
        { name: random.pick(["toString", "getScheme", "getHost", "getPath"]), descriptor: "()Ljava/lang/String;" },
      ] };
    case 5:
      return { schemaVersion: SCHEMA_VERSION, id, kind: "api", owner: "android/text/TextUtils", calls: [{ name: "isEmpty", descriptor: "(Ljava/lang/CharSequence;)Z", static: true, args: [random.chance(0.2) ? { kind: "null" } : s(random.pick(["", "a", " android ", "\uD83D\uDE80"]))] }] };
    default:
      return matrixCase(random, id);
  }
}

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
  return Array.from({ length: count }, (_, index) => index % 7 === 6
    ? matrixCase(random, `api-${seed}-${index}`)
    : apiRecipe(random, `api-${seed}-${index}`));
}

const COLOURS = [0x00000000, 0xff000000, 0xffffffff, 0xffff0000, 0xff00ff00, 0xff0000ff, 0x80808080].map((value) => value | 0);
const TEXT = ["", "A", "webdroid", "ffi 123", "\uD83D\uDE80"];

function coordinate(random: Random): number {
  return random.pick([-64, -1, 0, 1, 32, 64, 127, 128, 192, random.int(-128, 256)]);
}

function drawCommand(random: Random): GraphicsCommand {
  switch (random.int(0, 13)) {
    case 0: return { op: "color", args: [random.pick(COLOURS)] };
    case 1: return { op: "alpha", args: [random.int(-32, 288)] };
    case 2: return { op: "strokeWidth", args: [random.pick([0, 1, 2, 8, 32])] };
    case 3: return { op: "style", args: [random.pick(["FILL", "STROKE", "FILL_AND_STROKE"])] };
    case 4: return { op: "textSize", args: [random.pick([0, 1, 8, 16, 32, 96])] };
    case 5: return { op: "drawRect", args: Array.from({ length: 4 }, () => coordinate(random)) };
    case 6: return { op: "drawCircle", args: [coordinate(random), coordinate(random), random.pick([-1, 0, 1, 16, 64, 192])] };
    case 7: return { op: "drawLine", args: Array.from({ length: 4 }, () => coordinate(random)) };
    case 8: return { op: "drawText", args: [random.pick(TEXT), coordinate(random), coordinate(random)] };
    case 9: return { op: "translate", args: [coordinate(random), coordinate(random)] };
    case 10: return { op: "scale", args: [random.pick([-2, -1, 0, 0.5, 1, 2]), random.pick([-2, -1, 0, 0.5, 1, 2])] };
    case 11: return { op: "rotate", args: [random.int(-720, 720)] };
    case 12: return { op: "clipRect", args: Array.from({ length: 4 }, () => coordinate(random)) };
    default: return { op: "drawColor", args: [random.pick(COLOURS)] };
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
    while (saveDepth-- > 0) commands.push({ op: "restore" });
    return { schemaVersion: SCHEMA_VERSION, id: `graphics-${seed}-${index}`, kind: "graphics", width: 128, height: 128, commands };
  });
}
