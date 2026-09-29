package libcore.io;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.Reader;

public final class Streams {
    public static void readFully(InputStream in, byte[] dst) throws IOException { throw new UnsupportedOperationException(); }
    public static void readFully(InputStream in, byte[] dst, int offset, int byteCount) throws IOException { throw new UnsupportedOperationException(); }
    public static byte[] readFully(InputStream in) throws IOException { throw new UnsupportedOperationException(); }
    public static byte[] readFullyNoClose(InputStream in) throws IOException { throw new UnsupportedOperationException(); }
    public static String readFully(Reader reader) throws IOException { throw new UnsupportedOperationException(); }
    public static int copy(InputStream in, OutputStream out) throws IOException { throw new UnsupportedOperationException(); }
}
