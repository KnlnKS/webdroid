package wdtest;

/** implemented by the host: makes an instance of the abstract Hc.Shape, a class the host implements */
public class Maker {
  public static native Object make();
  public static native Object face();
}
