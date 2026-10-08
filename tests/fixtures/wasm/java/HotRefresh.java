public class HotRefresh {
  public interface Value { int answer(); }
  public static class One implements Value { public int answer() { return 7; } }
  static Value value = new One();
  static class Later { static int delta() { return 5; } }
  static int helper(boolean later) { return value.answer() + (later ? Later.delta() : 0); }
  public static int run(boolean later) {
    int sum = 0;
    for (int i = 0; i < 128; i++) sum += helper(later);
    return sum;
  }
  public static void choose(Value next) { value = next; }
  public static void main(String[] args) throws Exception {
    System.out.println(run(false));
    System.out.println(run(true));
    choose((Value) Class.forName("HotRefreshLate").getDeclaredConstructor().newInstance());
    System.out.println(run(true));
  }
}
