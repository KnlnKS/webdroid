import java.util.ArrayList;
/** A platform method the build devirtualised (ArrayList.contains calls indexOf), and a later dex that falsifies it (Aot2). */
public class Aot {
  public static class MyList extends ArrayList<Object> {}
  public static int plain() { return new ArrayList<Object>().contains("x") ? 1 : 0; }
  public static int inherited() { return new MyList().contains("x") ? 1 : 0; }
}
