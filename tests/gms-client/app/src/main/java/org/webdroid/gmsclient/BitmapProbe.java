package org.webdroid.gmsclient;

import android.content.res.Resources;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Log;
import android.util.TypedValue;
import java.io.InputStream;

final class BitmapProbe {
    static void run(Resources resources) {
        int[] ids = {R.drawable.probe_mdpi, R.drawable.probe_nodpi, R.drawable.probe_default, R.drawable.probe_alias};
        String[] names = {"mdpi", "nodpi", "default", "alias"};
        for (int i = 0; i < ids.length; i++) {
            TypedValue value = new TypedValue();
            try (InputStream stream = resources.openRawResource(ids[i], value)) {
                Log.i("GmsClientBitmap", names[i] + " resource density=" + value.density + " type=" + value.type + " byte=" + stream.read());
            } catch (Exception error) { throw new AssertionError(error); }
            for (int mode = 0; mode < 7; mode++) {
                BitmapFactory.Options options = new BitmapFactory.Options();
                if (mode == 1) options.inScaled = false;
                if (mode == 2) options.inJustDecodeBounds = true;
                if (mode == 3) options.inSampleSize = 2;
                if (mode == 4) { options.inDensity = 160; options.inTargetDensity = 240; }
                if (mode == 5) { options.inDensity = 160; options.inScreenDensity = 160; }
                if (mode == 6) options.inMutable = true;
                Bitmap bitmap = BitmapFactory.decodeResource(resources, ids[i], options);
                Log.i("GmsClientBitmap", names[i] + " mode=" + mode + " bitmap=" + (bitmap == null ? "null"
                        : bitmap.getWidth() + "x" + bitmap.getHeight() + "@" + bitmap.getDensity() + " mutable=" + bitmap.isMutable())
                        + " bounds=" + options.outWidth + "x" + options.outHeight
                        + " density=" + options.inDensity + "/" + options.inTargetDensity);
                if (bitmap != null) bitmap.recycle();
            }
        }
        Log.i("GmsClientBitmap", "missing=" + (BitmapFactory.decodeResource(resources, 0) == null));
    }
}
