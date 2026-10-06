// Fresh-World reflection, class initialization and traces across cold JSPI bridges.
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { world, loadDexes } from "./lib";
import { natives, jsTier } from "./oracle";
import { shellIn } from "./tools";
import { AOSP } from "./paths";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { rt } from "../../src/jvm/runtime";
import { hostThrowable, wasmEntry } from "../../src/wasm/host/entry";
import { useEntry } from "../../src/jvm/natives/jentry";

const dir = mkdtempSync(join(tmpdir(), "cold-init-")), sh = shellIn(dir);
writeFileSync(join(dir, "ColdInit.java"), `import java.lang.invoke.MethodHandles;
import java.lang.annotation.*;
public class ColdInit {
  public enum Choice { A; static {try {Thread.sleep(1);}catch(InterruptedException e){throw new RuntimeException(e);}} }
  @Retention(RetentionPolicy.RUNTIME) public @interface Mark {int value() default 7; Choice choice() default Choice.A;}
  @Mark(42) public static int annotated;
  public interface PublicFields {int shared=13;}
  public static class PublicBase {public int inherited=7; public static int shared=17; private int hidden=29;}
  public static class PublicChild extends PublicBase implements PublicFields {public int own=5; private int inherited=31;}
  public static int publicFields()throws Exception {PublicChild c=new PublicChild();Class<?> cls=PublicChild.class;int r=cls.getField("own").getInt(c)+10*cls.getField("inherited").getInt(c)+100*cls.getField("shared").getInt(null);try{cls.getField("hidden");}catch(NoSuchFieldException e){r+=10000;}return r;}

  public static int annotationDefault()throws Exception{return ((Choice)Mark.class.getDeclaredMethod("choice").getDefaultValue()).ordinal()+7;}
  public static int annotation()throws Exception{return ColdInit.class.getDeclaredField("annotated").getAnnotation(Mark.class).value();}
  public static int concurrentAnnotations()throws Exception {
    final int[] values=new int[4]; final Throwable[] errors=new Throwable[4]; Thread[] threads=new Thread[4];
    for(int i=0;i<4;i++){final int index=i;threads[i]=new Thread(()->{try{values[index]=annotation();}catch(Throwable e){errors[index]=e;}});threads[i].start();}
    int sum=0;for(int i=0;i<4;i++){threads[i].join();if(errors[i]!=null)throw new RuntimeException(errors[i]);sum+=values[i];}return sum;
  }
  static class Wait { static int n; static {try { Thread.sleep(1); } catch(InterruptedException e){throw new RuntimeException(e);} n=42;} }
  public static int run(){return Wait.n;}
  public static int sleep()throws Exception {Thread.sleep(1);return 14;}
  public static int lookup(){return MethodHandles.lookup().lookupClass()==ColdInit.class?1:0;}
  public static int trace(){int n=0;for(StackTraceElement e:new Exception().getStackTrace())if(e.getClassName().equals("ColdInit")&&e.getMethodName().equals("trace"))n++;return n;}
  static int recursiveFrames(int d){if(d>0)return recursiveFrames(d-1);int n=0;for(StackTraceElement e:new Exception().getStackTrace())if(e.getClassName().equals("ColdInit")&&e.getMethodName().equals("recursiveFrames"))n++;return n;}
  public static int recursive(){return recursiveFrames(4);}
  public static int mixed()throws Exception{return middle();}
  public static int sites()throws Exception {
    int a=site();
    Thread.sleep(1);
    return a*1000+site();
  }
  static int site(){for(StackTraceElement e:new Exception().getStackTrace())if(e.getClassName().equals("ColdInit")&&e.getMethodName().equals("sites"))return e.getLineNumber();return -1;}
  static synchronized int middle()throws Exception{return inner();}
  static int inner()throws Exception {Thread.sleep(1);int n=0;for(StackTraceElement e:new Exception().getStackTrace())if(e.getClassName().equals("ColdInit")&&(e.getMethodName().equals("mixed")||e.getMethodName().equals("middle")||e.getMethodName().equals("inner")))n++;return lookup()*100+n;}
  public static void main(String[] args)throws Exception {System.out.println(concurrentAnnotations());System.out.println(annotationDefault());System.out.println(annotation());System.out.println(publicFields());System.out.println(sleep());System.out.println(run());System.out.println(lookup());System.out.println(trace());System.out.println(recursive());System.out.println(mixed());System.out.println(sites());}
}`);
sh(["javac", "--release", "11", "-d", dir, join(dir, "ColdInit.java")]);
sh(["d8", "--release", "--min-api", "34", "--output", dir, ...readdirSync(dir).filter(f => f.endsWith(".class")).map(f => join(dir, f))]);
const dex = join(dir, "classes.dex"), paths = [dex, ...PLATFORM_JARS.slice(0, 2).map(j => join(AOSP, j))];
await jsTier(loadDexes(dex)); rt.mkThrowable = hostThrowable;
const cases = ["concurrentAnnotations", "annotationDefault", "annotation", "publicFields", "sleep", "run", "lookup", "trace", "recursive", "mixed", "sites"], jdk = sh(["java", "-cp", dir, "ColdInit"]).trim().split("\n");
let checks = 0;
for (const cold of [false, true]) for (const [i, name] of cases.entries()) {
  const w = world(paths, { cold, natives }), gaps: string[] = [];
  w.onGap = id => gaps.push(w.gapList[id]);
  useEntry(wasmEntry(w));
  const got = await w.entryAsync("ColdInit", name, "()I")();
  if (String(got) !== jdk[i] || gaps.length) throw new Error(`${cold ? "cold" : "compiled"} ${name}: ${got} != JDK ${jdk[i]}; ${gaps.join(",")}`);
  if (cold && !w.stats.coldCalls) throw new Error("fixture bypassed cold execution");
  checks++; console.log(cold ? "cold" : "compiled", name, got, "cold calls", w.stats.coldCalls);
}
const concurrent = world(paths, { cold: true, natives });
useEntry(wasmEntry(concurrent));
const values = await Promise.all(Array.from({ length: 8 }, () => concurrent.entryAsync("ColdInit", "mixed", "()I")()));
if (values.some(v => String(v) !== jdk[cases.indexOf("mixed")])) throw new Error(`concurrent strands lost callers: ${values}`);
checks++;
console.log(`cold init: ${checks} checks match JDK; fresh Thread.sleep/initializer, caller classes, recursive traces, compiled synchronized middle and suspended concurrent strands`);
