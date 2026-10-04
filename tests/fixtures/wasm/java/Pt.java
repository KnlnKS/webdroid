/** Drives the classes customdiff.ts writes by hand: Pq and Pq2 take their toString, equals and hashCode from ObjectMethods.bootstrap over getters that are virtual and interface methods. */
public class Pt {
  public static int ts(int a) { return new Pq(a, a % 2 == 0 ? null : "n").toString().hashCode() * 31 + new Pq2(a, "m").toString().hashCode(); }
  public static int hc(int a) { return new Pq(a, "n").hashCode() * 7 + new Pq2(a, "m").hashCode() + new Pq(a, null).hashCode(); }
  public static int eq(int a) {
    Pq p = new Pq(a, "n"), q = new Pq2(a, "n");
    return (p.equals(new Pq(a, "n")) ? 1 : 0) + (p.equals(new Pq(a + 1, "n")) ? 2 : 0) + (p.equals(q) ? 4 : 0) + (q.equals(p) ? 8 : 0) + (q.equals(new Pq2(a, "n")) ? 16 : 0) + (p.equals(new Pq(a, "o")) ? 32 : 0) + (p.equals(null) ? 64 : 0) + (p.equals("n") ? 128 : 0);
  }
}
