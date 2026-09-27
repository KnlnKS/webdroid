import { JObj, rt, driven, type Gen } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { type JFile, mkFile, readStreamFully } from "../jvm/natives/jio";
import { vfs } from "../shell/vfs";
import { i8 } from "../jvm/abi";

class JAtomicFile extends JObj { base = ""; }
function recover(file: JAtomicFile): void { vfs.rename(file.base + ".bak", file.base); }
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
  "finishWrite(Ljava/io/FileOutputStream;)V": driven(function* (this: JAtomicFile, stream: unknown): Gen {
    if (stream == null) return;
    yield vcall(stream, "close", "()V");
    vfs.rename(this.base + ".new", this.base);
    yield vfs.flush();
  }),
  "failWrite(Ljava/io/FileOutputStream;)V": driven(function* (this: JAtomicFile, stream: unknown): Gen {
    if (stream == null) return;
    yield vcall(stream, "close", "()V");
    vfs.delete(this.base + ".new");
  }),
  "openRead()Ljava/io/FileInputStream;": openRead,
  "readFully()[B": driven(function* (this: JAtomicFile): Gen {
    const stream = yield openRead.call(this);
    try { return i8(yield readStreamFully(stream)); }
    finally { yield vcall(stream, "close", "()V"); }
  }),
  "delete()V": function (this: JAtomicFile) {
    vfs.delete(this.base); vfs.delete(this.base + ".new"); vfs.delete(this.base + ".bak");
  },
} });
