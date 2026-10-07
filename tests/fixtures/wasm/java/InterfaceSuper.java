public class InterfaceSuper {
  interface A { default int f() { return 11; } }
  interface B extends A { default int f() { return 22; } }
  interface C extends A, B {}
  interface Reversed extends B, A {}
  interface Own extends A, B { default int f() { return 33; } }
  interface Basic extends A {}
  static class Select implements C { public int f() { return C.super.f(); } }
  static class Reverse implements Reversed { public int f() { return Reversed.super.f(); } }
  static class Declared implements Own { public int f() { return Own.super.f(); } }
  static class Inherited implements Basic { public int f() { return Basic.super.f(); } }
  static class Parent { public int f() { return 44; } }
  static class Child extends Parent { public int f() { return super.f(); } }
  public static int selected() { return new Select().f(); }
  public static int reversed() { return new Reverse().f(); }
  public static int declared() { return new Declared().f(); }
  public static int inherited() { return new Inherited().f(); }
  public static int classSuper() { return new Child().f(); }
  public static Class<?> self() { return InterfaceSuper.class; }
  public static void main(String[] args) {
    System.out.println(selected()); System.out.println(reversed());
    System.out.println(declared()); System.out.println(inherited()); System.out.println(classSuper());
  }
}
