package libcore.io;

import android.system.ErrnoException;
import java.io.FileDescriptor;

public interface Os {
    void chmod(String path, int mode) throws ErrnoException;
    int getuid();
    long lseek(FileDescriptor fd, long offset, int whence) throws ErrnoException;
    FileDescriptor[] pipe2(int flags) throws ErrnoException;
    void symlink(String oldPath, String newPath) throws ErrnoException;
}
