package wdtest;

/** declared for javac only: the class is implemented in the host (scripts/wasm/hostcases.ts) and is in no dex */
public class Counter implements Runnable, java.util.function.IntSupplier {
  public Counter() {}
  public native int inc();
  public native int get();
  public native int twice();
  public native Counter self();
  public native boolean same(Counter other);
  public native void setTag(String tag);
  public native String getTag();
  public native int pause(int by);
  public native int reenter();
  public native void fail();
  public native void bump(Object array);
  public native int nested(Object unused);
  public native void run();
  public native int getAsInt();
  public static native Counter make(int n);
}
