public class InterfaceSuper {
  private static int offset;
  public static void setOffset(int value) { offset = value; }
  interface A { default int f() { return 11 + offset; } }
  interface B extends A { default int f() { return 22 + offset; } }
  interface C extends A, B {}
  interface Reversed extends B, A {}
  interface Own extends A, B { default int f() { return 33 + offset; } }
  interface Basic extends A {}
  static class Select implements C { public int f() { return C.super.f(); } }
  static class Reverse implements Reversed { public int f() { return Reversed.super.f(); } }
  static class Declared implements Own { public int f() { return Own.super.f(); } }
  static class Inherited implements Basic { public int f() { return Basic.super.f(); } }
  static class Parent { public int f() { return 44 + offset; } }
  static class Child extends Parent { public int f() { return super.f(); } }
  public static int selected() { return new Select().f(); }
  public static int reversed() { return new Reverse().f(); }
  public static int declared() { return new Declared().f(); }
  public static int inherited() { return new Inherited().f(); }
  public static int classSuper() { return new Child().f(); }
  public static Class<?> self() { return InterfaceSuper.class; }
  public static void main(String[] args) {
    for (int value : new int[] {0, 17, 34, 51, 68}) {
      setOffset(value);
      System.out.println(selected()); System.out.println(reversed());
      System.out.println(declared()); System.out.println(inherited()); System.out.println(classSuper());
    }
  }
}
