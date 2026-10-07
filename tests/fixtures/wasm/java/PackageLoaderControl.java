import java.net.URL;
import java.net.URLClassLoader;
import java.io.File;
public class PackageLoaderControl {
  public static void main(String[] paths) throws Exception {
    URL a = new File(paths[0]).toURI().toURL(), b = new File(paths[1]).toURI().toURL();
    ClassLoader parent = new URLClassLoader(new URL[] { a }, ClassLoader.getPlatformClassLoader());
    ClassLoader child = new URLClassLoader(new URL[] { b }, parent) {
      @Override protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
        if (name.equals("pack.PackageChild") || name.equals("pack.PackageType")) {
          Class<?> c = findLoadedClass(name);
          return c == null ? findClass(name) : c;
        }
        return super.loadClass(name, resolve);
      }
    };
    ClassLoader delegated = new URLClassLoader(new URL[] { b }, parent);
    ClassLoader same = new URLClassLoader(new URL[] { b, a }, ClassLoader.getPlatformClassLoader());
    for (ClassLoader loader : new ClassLoader[] { child, delegated, same }) {
      Class<?> cls = loader.loadClass("pack.PackageChild"); Object value = cls.getDeclaredConstructor().newInstance();
      System.out.println((Integer) cls.getMethod("inherited").invoke(value) * 100 + (Integer) cls.getMethod("own").invoke(value));
    }
  }
}
