package libcore.io;

import java.io.FileDescriptor;
import java.io.IOException;
import java.net.Socket;

public final class IoUtils {
    public static void close(FileDescriptor fd) throws IOException { throw new UnsupportedOperationException(); }
    public static void closeQuietly(AutoCloseable closeable) { throw new UnsupportedOperationException(); }
    public static void closeQuietly(FileDescriptor fd) { throw new UnsupportedOperationException(); }
    public static void closeQuietly(Socket socket) { throw new UnsupportedOperationException(); }
    public static byte[] readFileAsByteArray(String absolutePath) throws IOException { throw new UnsupportedOperationException(); }
}
