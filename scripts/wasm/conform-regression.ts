// Runner regression: real generic arrays keep their Type, data rows and failures reach TestNG.
// Run after `conform ojluni-time` has fetched the jars: bun scripts/wasm/conform-regression.ts
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { androidTool } from "../android-sdk";
import { parseLines } from "../conform/results";
import { SUITES } from "../conform/suites";
import { ROOT } from "./paths";
import { bundleForNode } from "./undernode";
import { arrayProviderFailures } from "./conform-coverage";

const out = mkdtempSync(join(ROOT, "conform-cache/runner-regression-")), classes = join(out, "classes");
mkdirSync(classes);
const jars = SUITES["ojluni-time"].maven.map((coords) => {
  const [, artifact, version] = coords.split(":");
  return join(ROOT, `conform-cache/jars/${artifact}-${version}.jar`);
});
const source = join(out, "ProviderRegression.java");
await Bun.write(source, `
import java.lang.reflect.*;
import java.util.*;
import org.testng.Assert;
import org.testng.annotations.*;
public class ProviderRegression<T> {
    @DataProvider(name="rows") Iterator<Object[]> rows() {
        return Arrays.asList(new Object[] {1}, new Object[] {2}).iterator();
    }
    @Test(dataProvider="rows") public void row(int value) { Assert.assertTrue(value > 0); }
    @Test(dataProvider="rows") public void failingRow(int value) { Assert.assertEquals(value, 1); }
    @Test(dataProvider="rows", expectedExceptions=IllegalArgumentException.class)
    public void expected(int value) { throw new IllegalArgumentException(String.valueOf(value)); }
    public Iterator<T[]> variables() { return null; }
    public Iterator<List<String>[]> parameterized() { return null; }
    @Test public void genericArrays() throws Exception {
        Type variable = ((ParameterizedType) getClass().getMethod("variables").getGenericReturnType()).getActualTypeArguments()[0];
        Assert.assertTrue(variable instanceof GenericArrayType);
        Assert.assertTrue(((GenericArrayType) variable).getGenericComponentType() instanceof TypeVariable);
        Type array = ((ParameterizedType) getClass().getMethod("parameterized").getGenericReturnType()).getActualTypeArguments()[0];
        Assert.assertTrue(array instanceof GenericArrayType);
        Assert.assertTrue(((GenericArrayType) array).getGenericComponentType() instanceof ParameterizedType);
    }
    @DataProvider(name="broken") Iterator<Object[]> broken() { throw new IllegalStateException("provider failed"); }
    @Test(dataProvider="broken") public void providerFailure(int value) { Assert.fail("must not run"); }
    public static void main(String[] args) throws Exception { System.out.print("\\u0001" + NgRunner.run("ProviderRegression", "")); }
}
`);
const javaHome = process.env.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@21";
const env = { ...process.env, JAVA_HOME: javaHome, PATH: `${javaHome}/bin:${process.env.PATH}` };
function run(cmd: string[]): string {
  const result = Bun.spawnSync(cmd, { env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(`${cmd[0]}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
run(["javac", "--release", "17", "-XDstringConcat=inline", "-cp", jars.join(":"), "-d", classes, join(ROOT, "scripts/conform/NgRunner.java"), source]);
run([androidTool("d8"), "--min-api", "35", "--output", out, ...jars, ...readdirSync(classes).map((file) => join(classes, file))]);
const jdk = run(["java", "-cp", [classes, ...jars].join(":"), "ProviderRegression"]);
const wasm = run(await bundleForNode(join(import.meta.dir, "conformone.ts"), [out, "NgRunner", "ProviderRegression"]));
for (const [tier, output] of [["jdk", jdk], ["wasm", wasm]]) {
  const { tests, skipped } = parseLines(output.slice(output.indexOf("\u0001") + 1));
  const pass = [...tests.values()].filter((result) => result.ok).length;
  const failures = [...tests].filter(([, result]) => !result.ok);
  if (pass !== 6 || failures.length !== 1 || !failures[0][0].startsWith("failingRow[2]") || skipped.size !== 1 ||
      ![...skipped][0][0].startsWith("providerFailure[") || ![...skipped.values()][0].includes("provider failed") ||
      tier === "wasm" && ![...skipped.values()][0].startsWith("array provider adapter: ")) throw new Error(`${tier}: unexpected results\n${output}`);
  if (tier === "wasm" && arrayProviderFailures("ProviderRegression", skipped).length !== 1) throw new Error("lost provider was treated as baseline drift");
  console.log(`${tier}: 6 pass, 1 intentional row failure, 1 provider failure reported; generic arrays preserved`);
}
// The original cast must also fail coverage without needing any emitted baseline row names.
if (arrayProviderFailures("ProviderRegression", new Map([["row[]", "java.lang.ClassCastException: libcore.reflect.GenericArrayTypeImpl cannot be cast to java.lang.Class"]])).length !== 1) throw new Error("original cast was treated as baseline drift");
console.log("coverage guard rejects the original cast and the adapted provider failure independently of baseline rows");
