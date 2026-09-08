package webdroid;

// The test renames the DEX text field to same: Java source forbids this legal DEX shape.
public class StaticFieldsFixture {
  public static Object same = new Object();
  public static String text = "initial";
  public static String read() { return text; }
  public static void write(String value) { text = value; }
  public static Object monitor() { return same; }
}
