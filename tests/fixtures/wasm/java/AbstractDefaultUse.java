public class AbstractDefaultUse extends InterfaceSuper.Default implements InterfaceSuper.Reabstracted, InterfaceSuper.OtherReabstracted {
  public static int prepare() { new AbstractDefaultUse(); return 42; }
  public static int call() { return new AbstractDefaultUse().f(); }
  public static int check() {
    try { call(); return 0; } catch (AbstractMethodError expected) { return 1; }
  }
  static class ClassUse extends ClassReabstract {}
  public static int prepareClass() { new ClassUse(); return 42; }
  public static int callClass() { return new ClassUse().f(); }
  public static int checkClass() {
    try { callClass(); return 0; } catch (AbstractMethodError expected) { return 1; }
  }
  public static void main(String[] args) { System.out.println(prepare()); System.out.println(check()); System.out.println(prepareClass()); System.out.println(checkClass()); }
}
