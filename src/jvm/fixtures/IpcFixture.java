package webdroid;

import java.io.Serializable;
import java.io.ObjectOutputStream;

public class IpcFixture {
  private static int constructions;
  public static class Payload implements Serializable {
    int number;
    transient String transientValue;
    Payload next;
    Object[] references;
    boolean[] flags;
    public Payload() { constructions++; }
  }
  public static class Custom implements Serializable {
    private void writeObject(ObjectOutputStream out) {}
  }
  public static Payload create() {
    Payload p = new Payload();
    p.number = 42;
    p.transientValue = "local";
    p.next = p;
    p.references = new Object[] {p, "text", null};
    p.flags = new boolean[] {true, false, true};
    return p;
  }
  public static int check(Payload p) {
    return (p.number == 42 ? 1 : 0) | (p.next == p ? 2 : 0)
        | (p.references[0] == p ? 4 : 0) | ("text".equals(p.references[1]) ? 8 : 0)
        | (p.references[2] == null ? 16 : 0) | (p.transientValue == null ? 32 : 0)
        | (p.flags[0] && !p.flags[1] && p.flags[2] ? 64 : 0);
  }
  public static int constructions() { return constructions; }
}
