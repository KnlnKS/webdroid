// What the tier that runs Java gives the runtime and the natives, installed in one step: the calls into Java, JNI and the Java objects host
// code makes. Each lives where its readers reach it (jentry's bindings, jnivm's `vm`, Runtime's makers); until a tier installs them, Java is
// unreachable and a throwable is a plain Error.
import { rt, fieldNames } from "./runtime.ts";
import { useEntry, type Entry } from "./natives/jentry.ts";
import { wasmBox, type BoxDesc } from "./natives/jbox.ts";
import { useJniVm, type JniVm } from "../native/jnivm.ts";

export interface JavaHost {
  entry: Entry;
  jni: JniVm;
  /** a Java throwable of class `cls` with message `msg` */
  throwable(cls: string, msg: string | null): unknown;
  /** an instance of `cls`, its constructor not run */
  make(cls: string): unknown;
  /** the java.lang.Class of `cls` */
  classFor(cls: string): unknown;
  /** Java's own box of `v`, as `valueOf` makes it */
  box(desc: BoxDesc, v: number | bigint): unknown;
  /** the property a facade holds `cls`'s instance field `name` under */
  fieldName(cls: string, name: string): string | undefined;
  /** the Java frames calling into the runtime here, innermost first */
  javaFrames(): string[];
  /** the loader of the innermost Java frame whose class is not the platform's */
  userClassLoader(): object | null;
}

/** from here host code reaches Java through `host` */
export function useJavaHost(host: JavaHost): void {
  useEntry(host.entry); useJniVm(host.jni);
  rt.mkThrowable = host.throwable; rt.make = host.make; rt.classFor = host.classFor;
  rt.javaFrames = host.javaFrames; rt.userClassLoader = host.userClassLoader;
  wasmBox.make = host.box; fieldNames.find = host.fieldName;
}
