public class MemberUse extends MemberBase implements Tag {
  private MemberType superEcho() { return super.echo(null); }
  public int tag() {
    peer = null;
    array = null;
    MemberBase.shared = null;
    return peer == null && array == null && MemberBase.shared == null && echo(null) == null
      && MemberBase.staticEcho(null) == null && superEcho() == null ? 42 : 0;
  }
}
