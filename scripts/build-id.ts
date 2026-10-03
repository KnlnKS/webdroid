// The build a page's compiled bodies belong to, which keys the code cache's stores
// (src/jvm/codecache.ts): a hash of the source every emitted body depends on.
//   bun scripts/build-id.ts > build-id
export async function buildId(): Promise<string> {
  let source = "";
  for (const file of [...new Bun.Glob("src/**/*.ts").scanSync()].sort()) source += await Bun.file(file).text();
  return Bun.hash(source).toString(36);
}
if (import.meta.main) process.stdout.write(await buildId());
