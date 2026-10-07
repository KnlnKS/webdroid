package pack;
public class PackageBase {
  int foo(PackageType value) { return 11; }
  public int inherited() { return foo(null); }
}
