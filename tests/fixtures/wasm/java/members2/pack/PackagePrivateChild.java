package pack;
public class PackagePrivateChild extends PackageBase {
  int foo(PackageType value) { return 22; }
  public int own() { return foo(null); }
}
