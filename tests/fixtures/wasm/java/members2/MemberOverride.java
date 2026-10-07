public class MemberOverride extends MemberBase implements Tag {
  static { Ldr.memberInitEffects++; }
  @Override public MemberType echo(MemberType value) { Ldr.memberDispatchEffects++; return value; }
  public int tag() { return 42; }
}
