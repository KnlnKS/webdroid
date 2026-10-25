import { existsSync, readdirSync } from "node:fs";

const androidSdkRoot = (): string => process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ??
  [`${process.env.HOME}/Library/Android/sdk`, "/opt/homebrew/share/android-commandlinetools"].find(existsSync) ?? `${process.env.HOME}/Library/Android/sdk`;

export function androidPlatform(api: number): string {
  const path = `${androidSdkRoot()}/platforms/android-${api}`;
  if (!existsSync(path)) throw new Error(`Android API ${api} is not installed under ${androidSdkRoot()}`);
  return path;
}

export function androidTool(name: string): string {
  const root = androidSdkRoot();
  if (name === "adb") {
    const path = `${root}/platform-tools/adb`;
    if (existsSync(path)) return path;
  }
  const buildTools = `${root}/build-tools`;
  const versions = (existsSync(buildTools) ? readdirSync(buildTools) : []).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }));
  const path = versions.map((version) => `${root}/build-tools/${version}/${name}`).filter(existsSync).at(-1);
  if (!path) throw new Error(`No Android ${name} tool is installed under ${root}`);
  return path;
}
