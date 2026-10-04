import java.io.*;
import java.lang.reflect.*;

/** Reference runner: reads "Cls.method arg..." lines (float/double args as raw bits) and prints each result the same way. */
public class Ref {
  public static void main(String[] args) throws Exception {
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
    for (String line; (line = in.readLine()) != null; ) {
      String[] t = line.split(" ");
      int dot = t[0].indexOf('.');
      Method m = null;
      for (Method c : Class.forName(t[0].substring(0, dot)).getDeclaredMethods()) if (c.getName().equals(t[0].substring(dot + 1))) m = c;
      Class<?>[] ps = m.getParameterTypes();
      Object[] a = new Object[ps.length];
      for (int i = 0; i < ps.length; i++) {
        long v = Long.parseLong(t[i + 1]);
        Class<?> p = ps[i];
        a[i] = p == long.class ? (Object) v : p == double.class ? (Object) Double.longBitsToDouble(v) : p == float.class ? (Object) Float.intBitsToFloat((int) v)
          : p == boolean.class ? (Object) (v != 0) : p == byte.class ? (Object) (byte) v : p == short.class ? (Object) (short) v : p == char.class ? (Object) (char) v : (Object) (int) v;
      }
      String out;
      try {
        Object r = m.invoke(null, a);
        out = r instanceof Double ? "" + Double.doubleToRawLongBits((Double) r) : r instanceof Float ? "" + Float.floatToRawIntBits((Float) r)
          : r instanceof Boolean ? ((Boolean) r ? "1" : "0") : r instanceof Character ? "" + (int) (Character) r : "" + r;
      } catch (InvocationTargetException e) { out = "throw"; }
      System.out.println(out);
    }
  }
}
