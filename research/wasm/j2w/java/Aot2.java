import java.util.ArrayList;
public class Aot2 {
  public static class MyList extends ArrayList<Object> { @Override public int indexOf(Object o) { return 7; } }
  public static int sub() { return new MyList().contains("x") ? 1 : 0; }
  public static int plain() { return new ArrayList<Object>().contains("x") ? 1 : 0; }
}
