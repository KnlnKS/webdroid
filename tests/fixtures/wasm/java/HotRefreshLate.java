public class HotRefreshLate implements HotRefresh.Value {
  public int answer() { return 11; }
  public static HotRefresh.Value make() { return new HotRefreshLate(); }
}
