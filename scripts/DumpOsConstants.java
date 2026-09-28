// Run by gen-framework on the reference device (app_process): android.system.OsConstants' values.
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;

public class DumpOsConstants {
  public static void main(String[] args) throws Exception {
    for (Field f : Class.forName("android.system.OsConstants").getDeclaredFields()) {
      if (Modifier.isStatic(f.getModifiers()) && f.getType() == int.class) System.out.println(f.getName() + " " + f.getInt(null));
    }
  }
}
