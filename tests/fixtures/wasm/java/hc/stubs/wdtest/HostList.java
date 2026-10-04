package wdtest;

/** declared for javac only: a list whose elements the host holds (scripts/wasm/hostcases.ts) */
public class HostList extends java.util.AbstractList<Object> {
  public native Object get(int index);
  public native int size();
  public native void add(int index, Object element);
}
