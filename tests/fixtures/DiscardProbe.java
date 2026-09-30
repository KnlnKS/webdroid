// Rebuild in a temporary directory with javac --release 17 -XDstringConcat=inline, then d8
// --min-api 26 --lib "$ANDROID_HOME/platforms/android-35/android.jar" --output <dir>
// <dir>/DiscardProbe.class, and copy classes.dex to DiscardProbe.dex.
public final class DiscardProbe {
    /** the handler discards the exception: its throwable needs no trace */
    public static int ignored(String s) {
        try { return Integer.parseInt(s); } catch (NumberFormatException e) { return -1; }
    }

    /** the handler reads it */
    public static String traced(String s) {
        try { return "" + Integer.parseInt(s); } catch (NumberFormatException e) { return frames(e); }
    }

    /** the handler discards another class, so this one leaves with its trace */
    static int other(String s) {
        try { return Integer.parseInt(s); } catch (ArithmeticException e) { return -2; }
    }

    public static String escaped(String s) {
        try { return "" + other(s); } catch (NumberFormatException e) { return frames(e); }
    }

    static String frames(Throwable t) {
        StringBuilder sb = new StringBuilder();
        for (StackTraceElement e : t.getStackTrace()) sb.append(e.getMethodName()).append(',');
        return sb.toString();
    }
}
