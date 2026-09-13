import { JObj, rt } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { type JFile, mkFile, readStreamFully, vfs } from "../jvm/natives/jio";
import { i8 } from "../jvm/abi";

class JAtomicFile extends JObj { base = ""; }
function rename(from: string, to: string): void {
  const data = vfs.read(from);
  if (data) { vfs.write(to, data); vfs.delete(from); }
}
function recover(file: JAtomicFile): void { rename(file.base + ".bak", file.base); }
async function openRead(this: JAtomicFile): Promise<unknown> {
  recover(this);
  if (vfs.exists(this.base)) vfs.delete(this.base + ".new");
  return newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", this.base);
}
rt.register({ name: "android/util/AtomicFile", ctor: JAtomicFile, methods: {
  "<init>(Ljava/io/File;)V": function (this: JAtomicFile, base: JFile) { this.base = base.path; },
  "getBaseFile()Ljava/io/File;": function (this: JAtomicFile) { return mkFile(this.base); },
  "startWrite()Ljava/io/FileOutputStream;": function (this: JAtomicFile) {
    recover(this);
    vfs.mkdir(this.base.slice(0, this.base.lastIndexOf("/")));
    return newObj("java/io/FileOutputStream", "(Ljava/lang/String;)V", this.base + ".new");
  },
  "finishWrite(Ljava/io/FileOutputStream;)V": async function (this: JAtomicFile, stream: unknown) {
    if (stream == null) return;
    await vcall(stream, "close", "()V");
    rename(this.base + ".new", this.base);
    await vfs.flush();
  },
  "failWrite(Ljava/io/FileOutputStream;)V": async function (this: JAtomicFile, stream: unknown) {
    if (stream == null) return;
    await vcall(stream, "close", "()V");
    vfs.delete(this.base + ".new");
  },
  "openRead()Ljava/io/FileInputStream;": openRead,
  "readFully()[B": async function (this: JAtomicFile) {
    const stream = await openRead.call(this);
    try { return i8(await readStreamFully(stream)); }
    finally { await vcall(stream, "close", "()V"); }
  },
  "delete()V": function (this: JAtomicFile) {
    vfs.delete(this.base); vfs.delete(this.base + ".new"); vfs.delete(this.base + ".bak");
  },
} });
