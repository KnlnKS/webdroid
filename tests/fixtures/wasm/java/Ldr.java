import dalvik.system.DexClassLoader;
import java.lang.reflect.Array;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/** An interface the app's dex defines and the classes of the two loaders implement. */
interface Tag { int tag(); }

/** Two DexClassLoaders over dex files that define the class Shared (ldr1, ldr2): each sees its own class, with its own statics, and both see the app's Tag. */
public class Ldr {
  static int failed;
  static void expect(int bit, boolean ok) { if (!ok) failed |= 1 << bit; }

  /** a bit set for each check that failed */
  public static int check(String pathA, String pathB) throws Exception {
    failed = 0;
    ClassLoader parent = Ldr.class.getClassLoader();
    ClassLoader a = new DexClassLoader(pathA, null, null, parent), b = new DexClassLoader(pathB, null, null, parent);
    Class<?> ca = a.loadClass("Shared"), cb = b.loadClass("Shared");
    expect(0, ca != cb && ca.getName().equals("Shared") && cb.getName().equals("Shared"));
    expect(1, ca.getClassLoader() == a && cb.getClassLoader() == b);
    expect(2, a.loadClass("Shared") == ca && b.loadClass("Shared") == cb);
    Method bumpA = ca.getMethod("bump"), bumpB = cb.getMethod("bump");
    bumpA.invoke(null); bumpA.invoke(null);
    expect(3, (Integer) bumpA.invoke(null) == 3 && (Integer) bumpB.invoke(null) == 1);
    Object oa = ca.newInstance(), ob = cb.newInstance();
    expect(4, ca.isInstance(oa) && cb.isInstance(ob) && !ca.isInstance(ob) && !cb.isInstance(oa));
    expect(5, oa instanceof Tag && ob instanceof Tag && ((Tag) oa).tag() == 1 && ((Tag) ob).tag() == 2);
    boolean cce = false;
    try { ca.cast(ob); } catch (ClassCastException e) { cce = true; }
    expect(6, cce);
    expect(7, Class.forName("Shared", true, a) == ca && Class.forName("Shared", false, b) == cb);
    boolean cnf = false;
    try { Class.forName("Sub", true, a); } catch (ClassNotFoundException e) { cnf = true; }
    Class<?> sub = Class.forName("Sub", true, b);
    expect(8, cnf && sub.getSuperclass() == cb && ((Tag) sub.newInstance()).tag() == 22);
    expect(9, a.loadClass("Tag") == Tag.class && Class.forName("Tag", true, b) == Tag.class);
    // methods whose signatures name the loader's own class
    Method same = ca.getMethod("same", ca, ca);
    Object made = ca.getMethod("make").invoke(null);
    expect(10, ca.isInstance(made) && (Boolean) same.invoke(null, made, made) && !(Boolean) same.invoke(null, made, oa));
    boolean nsme = false;
    try { cb.getMethod("same", ca, ca); } catch (NoSuchMethodException e) { nsme = true; }
    expect(11, nsme && cb.getMethod("same", cb, cb).getParameterTypes()[0] == cb);
    expect(12, ca.getMethod("self").invoke(oa) == oa && ca.getMethod("self").getReturnType() == ca);
    Class<?> arrA = Array.newInstance(ca, 1).getClass(), arrB = Array.newInstance(cb, 1).getClass();
    expect(13, arrA != arrB && arrA.getComponentType() == ca && arrB.getComponentType() == cb && arrA.getName().equals("[LShared;"));
    expect(14, ca.getClassLoader() != null && Ldr.class.getClassLoader() != a && a.getParent() == parent);
    // exceptions: thrown and caught by a loader's own classes, and seen from outside
    boolean boomed = false;
    try { ca.getMethod("boom").invoke(null); } catch (InvocationTargetException e) {
      Throwable t = e.getCause();
      boomed = t instanceof RuntimeException && t.getClass().getName().equals("Boom") && t.getClass().getClassLoader() == a && t.getStackTrace()[0].getClassName().equals("Shared");
    }
    expect(15, boomed && (Integer) ca.getMethod("guarded").invoke(null) == 7 && (Integer) cb.getMethod("guarded").invoke(null) == 7);
    return failed;
  }
}
