import dalvik.system.DexClassLoader;
import dalvik.system.PathClassLoader;
import java.lang.reflect.Array;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;


/** Two DexClassLoaders over dex files that define the class Shared (ldr1, ldr2): each sees its own class, with its own statics, and both see the app's Tag. */
public class Ldr {
  static class FailedInit {
    static int value = fail();
    static int fail() { throw new IllegalStateException("fixture initializer"); }
  }
  public static int resolverForName(String path) throws Exception {
    int result = 0;
    ClassLoader loader = resolverLoader(path, 0);
    Class<?> type = Class.forName("Shared", false, loader);
    if (Class.forName("[LShared;", false, loader).getComponentType() == type) result |= 1;
    if (Class.forName("[[I", false, loader).getClassLoader() == Object.class.getClassLoader()) result |= 2;
    for (int mode = 1; mode <= 2; mode++) {
      try { Class.forName("Shared", false, resolverLoader(path, mode)); }
      catch (ClassNotFoundException expected) {
        Throwable cause = expected.getCause();
        if (mode == 1 && cause instanceof ClassNotFoundException || mode == 2 && cause instanceof NullPointerException) result |= 1 << (mode + 1);
      }
    }
    Method intrinsic = Class.class.getDeclaredMethod("classForName", String.class, boolean.class, ClassLoader.class);
    intrinsic.setAccessible(true);
    try { intrinsic.invoke(null, "Shared", false, resolverLoader(path, 3)); }
    catch (InvocationTargetException expected) {
      if (expected.getCause() instanceof ClassNotFoundException && expected.getCause().getCause() instanceof NoClassDefFoundError) result |= 16;
    }
    try { Class.forName("Shared", false, resolverLoader(path, 3)); }
    catch (NoClassDefFoundError expected) { result |= 32; }
    return result;
  }
  public static int resolverForNameInit() throws Exception {
    Class.forName("Ldr$FailedInit", false, Ldr.class.getClassLoader());
    try { Class.forName("Ldr$FailedInit", true, Ldr.class.getClassLoader()); }
    catch (ExceptionInInitializerError expected) { return 1; }
    return 0;
  }
  private static int resolverCalls;
  private static volatile boolean resolverRaceRelease;
  public static void resolverReleaseRace() { resolverRaceRelease = true; }
  public static int resolverCalls() { return resolverCalls; }
  public static ClassLoader resolverLoader(String path, int mode) {
    if (mode == 4 || mode == 5) resolverRaceRelease = false;
    ClassLoader parent = new DexClassLoader(path, null, null, Ldr.class.getClassLoader());
    return new ClassLoader(parent) {
      private int attempts;
      @Override public Class<?> loadClass(String name) throws ClassNotFoundException {
        int attempt;
        synchronized (this) { resolverCalls++; attempt = ++attempts; }
        if (mode == 1) throw new ClassNotFoundException(name);
        if (mode == 2) return null;
        if (mode == 3) return String.class;
        if (mode == 6 && !Thread.holdsLock(this)) throw new IllegalMonitorStateException();
        try {
          if (mode == 4 && attempt == 1 || mode == 5 && attempt == 2) {
            while (!resolverRaceRelease) Thread.sleep(1);
          } else Thread.sleep(1);
        } catch (InterruptedException e) { throw new RuntimeException(e); }
        if (mode == 6 && !Thread.holdsLock(this)) throw new IllegalMonitorStateException();
        if (mode == 4 && attempt == 1) throw new ClassNotFoundException(name);
        if (mode == 5 && attempt == 2) return String.class;
        return getParent().loadClass(name);
      }
    };
  }
  public static int proxyLoaders(String pathA, String pathB) throws Exception {
    ClassLoader a = new DexClassLoader(pathA, null, null, Ldr.class.getClassLoader());
    ClassLoader b = new DexClassLoader(pathB, null, null, Ldr.class.getClassLoader());
    Method generate = java.lang.reflect.Proxy.class.getDeclaredMethod("generateProxy", String.class, Class[].class, ClassLoader.class, Method[].class, Class[][].class);
    generate.setAccessible(true);
    Class<?>[] interfaces = {Runnable.class};
    Method[] methods = {Runnable.class.getMethod("run")};
    Class<?>[][] exceptions = {new Class<?>[0]};
    Class<?> ca = (Class<?>) generate.invoke(null, "fixture.SameProxy", interfaces, a, methods, exceptions);
    Class<?> cb = (Class<?>) generate.invoke(null, "fixture.SameProxy", interfaces, b, methods, exceptions);
    int result = ca != cb && ca.getName().equals(cb.getName()) ? 1 : 0;
    if (ca.getClassLoader() == a && cb.getClassLoader() == b) result |= 2;
    try { Class.forName("fixture.SameProxy", false, null); } catch (ClassNotFoundException expected) { result |= 4; }
    ClassLoader plain = new ClassLoader(Ldr.class.getClassLoader()) {};
    Class<?> cp = (Class<?>) generate.invoke(null, "fixture.SameProxy", interfaces, plain, methods, exceptions);
    if (cp != ca && cp != cb && cp.getClassLoader() == plain && plain.loadClass("fixture.SameProxy") == cp) result |= 8;
    Class<?> app = (Class<?>) generate.invoke(null, "fixture.RootProxy", interfaces, a, methods, exceptions);
    Class<?> boot = (Class<?>) generate.invoke(null, "fixture.RootProxy", interfaces, null, methods, exceptions);
    if (app != boot) result |= 16;
    if (app.getClassLoader() == a) result |= 32;
    if (boot.getClassLoader() == Runnable.class.getClassLoader()) result |= 64;
    if (Class.forName("fixture.RootProxy", false, null) == boot) result |= 128;
    if (Class.forName("fixture.RootProxy", false, a) == app) result |= 256;
    Class<?> publicProxy = java.lang.reflect.Proxy.getProxyClass(plain, Runnable.class);
    if (publicProxy.getClassLoader() == plain && java.lang.reflect.Proxy.getProxyClass(plain, Runnable.class) == publicProxy) result |= 512;
    if (Array.newInstance(cp, 0).getClass().getClassLoader() == plain && Array.newInstance(boot, 0).getClass().getClassLoader() == Runnable.class.getClassLoader()) result |= 1024;
    try {
      generate.invoke(null, "fixture.SameProxy", interfaces, a, methods, exceptions);
    } catch (java.lang.reflect.InvocationTargetException expected) {
      if (expected.getCause() instanceof LinkageError && a.loadClass("fixture.SameProxy") == ca) result |= 2048;
    }
    if (java.lang.reflect.Modifier.isPublic(ca.getModifiers()) && java.lang.reflect.Modifier.isFinal(ca.getModifiers())) result |= 4096;
    return result;
  }
  public static int delegateLast(String pathA, String pathB) throws Exception {
    ClassLoader parent = new DexClassLoader(pathA, null, null, Ldr.class.getClassLoader());
    ClassLoader child = new dalvik.system.DelegateLastClassLoader(pathB, parent);
    Class<?> own = child.loadClass("Shared"), inherited = parent.loadClass("Shared");
    int result = own != inherited && own.getClassLoader() == child ? 1 : 0;
    if (child.loadClass("Shared") == own && Class.forName("Shared", false, child) == own) result |= 2;
    Object instance = own.newInstance();
    if (own.getField("childOnly").getInt(instance) == 42) result |= 4;
    if (own.getMethod("self").getReturnType() == own && own.getField("peer").getType() == own) result |= 8;
    ClassLoader ordinary = new DexClassLoader(pathB, null, null, parent);
    if (ordinary.loadClass("Shared") == inherited) result |= 16;
    return result;
  }
  public static int hierarchyDelegateLast(String pathA, String pathB) throws Exception {
    ClassLoader parent = new DexClassLoader(pathA, null, null, Ldr.class.getClassLoader());
    parent.loadClass("Shared"); parent.loadClass("NamespaceFace");
    ClassLoader child = new dalvik.system.DelegateLastClassLoader(pathB, parent);
    Class<?> sub = child.loadClass("Sub"), sup = sub.getSuperclass();
    Class<?> face = sup.getInterfaces()[1];
    int result = sup.getClassLoader() == child ? 1 : 0;
    if (face.getClassLoader() == child) result |= 2;
    if (child.loadClass("Shared") == sup && child.loadClass("NamespaceFace") == face) result |= 4;
    return result;
  }
  public static ClassLoader symbolicLoader(String pathA, String pathB) {
    ClassLoader parent = new DexClassLoader(pathA, null, null, Ldr.class.getClassLoader());
    return new dalvik.system.DelegateLastClassLoader(pathB, parent);
  }
  public static int symbolicDelegateLast(String pathA, String pathB) throws Exception {
    return (Integer) symbolicLoader(pathA, pathB).loadClass("Shared").getMethod("symbolic").invoke(null);
  }
  public static int customParent(String pathA, String pathB) throws Exception {
    ClassLoader a = new DexClassLoader(pathA, null, null, Ldr.class.getClassLoader());
    ClassLoader parent = new ClassLoader(a) {};
    ClassLoader b = new DexClassLoader(pathB, null, null, parent);
    Class<?> sub = b.loadClass("Sub"), shared = b.loadClass("Shared");
    return (sub.getSuperclass() == shared ? 100 : 0) + ((Tag) sub.newInstance()).tag();
  }
  static int failed;
  static void expect(int bit, boolean ok) { if (!ok) failed |= 1 << bit; }

  public static int libraries(String pathA, String pathB) throws Exception {
    ClassLoader boot = Object.class.getClassLoader();
    ClassLoader library = new PathClassLoader(pathB, boot);
    ClassLoader[] libraries = new ClassLoader[] { library };
    java.lang.reflect.Constructor<?> ctor = PathClassLoader.class.getDeclaredConstructor(String.class, String.class, ClassLoader.class, ClassLoader[].class, ClassLoader[].class);
    ClassLoader before = (ClassLoader) ctor.newInstance(pathA, null, boot, libraries, null);
    ClassLoader after = (ClassLoader) ctor.newInstance(pathA, null, boot, null, libraries);
    Class<?> ca = before.loadClass("Shared"), cb = after.loadClass("Shared");
    Object a = ca.newInstance(), b = cb.newInstance();
    int x = (Integer) ca.getMethod("tag").invoke(a), y = (Integer) cb.getMethod("tag").invoke(b);
    if (ca.getClassLoader() != library || cb.getClassLoader() != after || ca == cb) return -1;
    return x * 10 + y;
  }

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
