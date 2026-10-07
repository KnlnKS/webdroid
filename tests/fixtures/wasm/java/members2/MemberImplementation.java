public class MemberImplementation implements MemberContract, Tag {
  public MemberType echo(MemberType value) { Ldr.memberDispatchEffects++; return value; }
  public int dispatch() { echo(null); return Ldr.memberDispatchEffects; }
  public int tag() { return 42; }
}
