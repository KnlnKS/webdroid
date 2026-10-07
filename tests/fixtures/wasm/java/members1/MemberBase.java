public class MemberBase {
  public MemberType peer;
  public MemberType[] array;
  public static MemberType shared;
  public MemberType echo(MemberType value) { return value; }
  public static MemberType staticEcho(MemberType value) { return value; }
  public UnusedMemberType unused(UnusedMemberType value) { return value; }
}
class UnusedMemberType {}
