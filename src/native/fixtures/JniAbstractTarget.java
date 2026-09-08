package webdroid;
interface JniParent { int value(); }
interface JniChild extends JniParent {}
public class JniAbstractTarget implements JniChild {
    public int value() { return 42; }
}
