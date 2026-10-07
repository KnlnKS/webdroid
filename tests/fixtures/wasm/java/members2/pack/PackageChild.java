package pack;
public class PackageChild extends PackageBase {
  public int foo(PackageType value) { return 22; }
  public int own() { return foo(null); }
}
