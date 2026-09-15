package org.webdroid.fuzz;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Point;
import android.graphics.Rect;
import android.graphics.RectF;
import android.os.Bundle;
import android.os.Parcel;
import android.os.Parcelable;
import android.util.Base64;
import android.view.View;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public final class ProbeActivity extends Activity {
    private static final String ENDPOINT = "http://127.0.0.1:4876";
    private TextView status;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        status = new TextView(this);
        status.setText("waiting for fuzz cases");
        setContentView(status);
        new Thread(this::runCases, "webdroid-fuzz-probe").start();
    }

    private void runCases() {
        int completed = 0;
        try {
            for (;;) {
                JSONObject input = nextCase();
                if (input == null) break;
                JSONObject result = execute(input);
                postResult(result);
                completed++;
                int count = completed;
                runOnUiThread(() -> status.setText("completed " + count + " cases"));
            }
            int count = completed;
            runOnUiThread(() -> status.setText("done: " + count + " cases"));
        } catch (Throwable error) {
            String message = error.getClass().getName() + ": " + error.getMessage();
            runOnUiThread(() -> status.setText(message));
        }
    }

    private static JSONObject nextCase() throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(ENDPOINT + "/case").openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        int code = connection.getResponseCode();
        if (code == 204) return null;
        if (code != 200) throw new IllegalStateException("case server returned " + code);
        return new JSONObject(read(connection.getInputStream()));
    }

    private static void postResult(JSONObject result) throws Exception {
        byte[] body = result.toString().getBytes(StandardCharsets.UTF_8);
        HttpURLConnection connection = (HttpURLConnection) new URL(ENDPOINT + "/result").openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "text/plain; charset=utf-8");
        connection.setFixedLengthStreamingMode(body.length);
        try (OutputStream output = connection.getOutputStream()) { output.write(body); }
        if (connection.getResponseCode() != 204) throw new IllegalStateException("result server rejected case");
    }

    private static String read(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        for (int count; (count = input.read(buffer)) >= 0;) output.write(buffer, 0, count);
        return output.toString(StandardCharsets.UTF_8.name());
    }

    private static JSONObject execute(JSONObject input) {
        JSONObject result = new JSONObject();
        put(result, "schemaVersion", 1);
        put(result, "id", input.optString("id"));
        put(result, "kind", input.optString("kind"));
        try {
            Object value = input.getString("kind").equals("graphics") ? graphics(input) : api(input);
            put(result, "outcome", "value");
            put(result, "value", normalize(value));
        } catch (Throwable thrown) {
            Throwable error = thrown instanceof InvocationTargetException && thrown.getCause() != null
                    ? thrown.getCause() : thrown;
            put(result, "outcome", "exception");
            put(result, "exception", error.getClass().getName());
            put(result, "message", String.valueOf(error.getMessage()));
        }
        return result;
    }

    private static Object api(JSONObject input) throws Exception {
        Class<?> owner = Class.forName(input.getString("owner").replace('/', '.'));
        Object receiver = null;
        if (input.has("constructorDescriptor")) {
            Class<?>[] parameters = parameters(input.getString("constructorDescriptor"));
            Constructor<?> constructor = owner.getConstructor(parameters);
            receiver = constructor.newInstance(arguments(input.optJSONArray("constructorArgs"), parameters));
        }
        Object value = receiver;
        JSONArray calls = input.optJSONArray("calls");
        if (calls == null) return value;
        for (int index = 0; index < calls.length(); index++) {
            JSONObject call = calls.getJSONObject(index);
            Class<?> callOwner = call.has("owner")
                    ? Class.forName(call.getString("owner").replace('/', '.')) : owner;
            String descriptor = call.getString("descriptor");
            Class<?>[] parameters = parameters(descriptor);
            Method method = callOwner.getMethod(call.getString("name"), parameters);
            value = method.invoke(call.optBoolean("static") ? null : receiver,
                    arguments(call.optJSONArray("args"), parameters));
            if (call.optBoolean("replaceReceiver") && value != null) receiver = value;
        }
        return value;
    }

    private static Class<?>[] parameters(String descriptor) throws Exception {
        int end = descriptor.indexOf(')');
        if (descriptor.charAt(0) != '(' || end < 0) throw new IllegalArgumentException("bad descriptor " + descriptor);
        List<Class<?>> result = new ArrayList<>();
        for (int index = 1; index < end;) {
            int start = index;
            while (descriptor.charAt(index) == '[') index++;
            if (descriptor.charAt(index) == 'L') index = descriptor.indexOf(';', index) + 1;
            else index++;
            result.add(classFor(descriptor.substring(start, index)));
        }
        return result.toArray(new Class<?>[0]);
    }

    private static Class<?> classFor(String descriptor) throws Exception {
        if (descriptor.startsWith("[") || descriptor.startsWith("L")) {
            String name = descriptor.startsWith("L")
                    ? descriptor.substring(1, descriptor.length() - 1) : descriptor;
            return Class.forName(name.replace('/', '.'));
        }
        return switch (descriptor.charAt(0)) {
            case 'Z' -> boolean.class;
            case 'B' -> byte.class;
            case 'C' -> char.class;
            case 'S' -> short.class;
            case 'I' -> int.class;
            case 'J' -> long.class;
            case 'F' -> float.class;
            case 'D' -> double.class;
            default -> throw new IllegalArgumentException("unsupported descriptor " + descriptor);
        };
    }

    private static Object[] arguments(JSONArray values, Class<?>[] parameters) throws Exception {
        if (values == null) values = new JSONArray();
        if (values.length() != parameters.length) throw new IllegalArgumentException("argument count mismatch");
        Object[] result = new Object[parameters.length];
        for (int index = 0; index < result.length; index++) result[index] = argument(values.getJSONObject(index));
        return result;
    }

    private static Object argument(JSONObject value) throws Exception {
        String kind = value.getString("kind");
        return switch (kind) {
            case "null" -> null;
            case "boolean" -> value.getBoolean("value");
            case "byte" -> (byte) value.getInt("value");
            case "char" -> (char) value.getInt("value");
            case "short" -> (short) value.getInt("value");
            case "int" -> value.getInt("value");
            case "long" -> Long.parseLong(value.getString("value"));
            case "float" -> (float) value.getDouble("value");
            case "double" -> value.getDouble("value");
            case "string" -> value.getString("value");
            case "enum" -> enumValue(value);
            case "int-array" -> intArray(value.getJSONArray("value"));
            case "float-array" -> floatArray(value.getJSONArray("value"));
            case "string-array" -> stringArray(value.getJSONArray("value"));
            default -> throw new IllegalArgumentException("unsupported argument " + kind);
        };
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    private static Object enumValue(JSONObject value) throws Exception {
        Class enumClass = Class.forName(value.getString("class").replace('/', '.'));
        return Enum.valueOf(enumClass, value.getString("value"));
    }

    private static int[] intArray(JSONArray input) throws Exception {
        int[] result = new int[input.length()];
        for (int index = 0; index < result.length; index++) result[index] = input.getInt(index);
        return result;
    }

    private static float[] floatArray(JSONArray input) throws Exception {
        float[] result = new float[input.length()];
        for (int index = 0; index < result.length; index++) result[index] = (float) input.getDouble(index);
        return result;
    }

    private static String[] stringArray(JSONArray input) throws Exception {
        String[] result = new String[input.length()];
        for (int index = 0; index < result.length; index++) result[index] = input.getString(index);
        return result;
    }

    private static Object graphics(JSONObject input) throws Exception {
        int width = input.optInt("width", 128), height = input.optInt("height", 128);
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        Path path = new Path();
        Matrix matrix = new Matrix();
        JSONArray commands = input.getJSONArray("commands");
        for (int index = 0; index < commands.length(); index++) {
            JSONObject command = commands.getJSONObject(index);
            JSONArray a = command.optJSONArray("args");
            if (a == null) a = new JSONArray();
            switch (command.getString("op")) {
                case "drawColor" -> canvas.drawColor(a.getInt(0));
                case "color" -> paint.setColor(a.getInt(0));
                case "alpha" -> paint.setAlpha(a.getInt(0));
                case "strokeWidth" -> paint.setStrokeWidth((float) a.getDouble(0));
                case "style" -> paint.setStyle(Paint.Style.valueOf(a.getString(0)));
                case "textSize" -> paint.setTextSize((float) a.getDouble(0));
                case "drawRect" -> canvas.drawRect(f(a, 0), f(a, 1), f(a, 2), f(a, 3), paint);
                case "drawCircle" -> canvas.drawCircle(f(a, 0), f(a, 1), f(a, 2), paint);
                case "drawLine" -> canvas.drawLine(f(a, 0), f(a, 1), f(a, 2), f(a, 3), paint);
                case "drawText" -> canvas.drawText(a.getString(0), f(a, 1), f(a, 2), paint);
                case "translate" -> canvas.translate(f(a, 0), f(a, 1));
                case "scale" -> canvas.scale(f(a, 0), f(a, 1));
                case "rotate" -> canvas.rotate(f(a, 0));
                case "save" -> canvas.save();
                case "restore" -> canvas.restore();
                case "clipRect" -> canvas.clipRect(f(a, 0), f(a, 1), f(a, 2), f(a, 3));
                case "pathReset" -> path.reset();
                case "pathMove" -> path.moveTo(f(a, 0), f(a, 1));
                case "pathLine" -> path.lineTo(f(a, 0), f(a, 1));
                case "pathQuad" -> path.quadTo(f(a, 0), f(a, 1), f(a, 2), f(a, 3));
                case "pathClose" -> path.close();
                case "drawPath" -> canvas.drawPath(path, paint);
                case "matrixRotate" -> matrix.setRotate(f(a, 0));
                case "matrixTranslate" -> matrix.setTranslate(f(a, 0), f(a, 1));
                case "setMatrix" -> canvas.setMatrix(matrix);
                default -> throw new IllegalArgumentException("unknown graphics op " + command.getString("op"));
            }
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes);
        JSONObject result = new JSONObject();
        put(result, "width", width);
        put(result, "height", height);
        put(result, "saveCount", canvas.getSaveCount());
        put(result, "center", bitmap.getPixel(width / 2, height / 2));
        put(result, "png", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
        return result;
    }

    private static float f(JSONArray values, int index) throws Exception {
        return (float) values.getDouble(index);
    }

    private static Object normalize(Object value) throws Exception {
        if (value == null) return JSONObject.NULL;
        if (value instanceof JSONObject || value instanceof JSONArray) return value;
        if (value instanceof Boolean || value instanceof Integer || value instanceof String) return value;
        if (value instanceof Long) return value.toString();
        if (value instanceof Float || value instanceof Double) {
            double number = ((Number) value).doubleValue();
            return Double.isFinite(number) ? number : String.valueOf(number);
        }
        if (value instanceof Character) return (int) ((Character) value).charValue();
        if (value instanceof Enum<?>) return ((Enum<?>) value).name();
        if (value instanceof int[]) return new JSONArray((int[]) value);
        if (value instanceof String[]) return new JSONArray((String[]) value);
        if (value instanceof Rect) {
            Rect rect = (Rect) value;
            return new JSONArray(new int[]{rect.left, rect.top, rect.right, rect.bottom});
        }
        if (value instanceof RectF) {
            RectF rect = (RectF) value;
            return new JSONArray(new double[]{rect.left, rect.top, rect.right, rect.bottom});
        }
        if (value instanceof Point) {
            Point point = (Point) value;
            return new JSONArray(new int[]{point.x, point.y});
        }
        if (value instanceof Matrix) {
            float[] values = new float[9];
            ((Matrix) value).getValues(values);
            return new JSONArray(values);
        }
        if (value instanceof Bitmap) {
            Bitmap bitmap = (Bitmap) value;
            return new JSONArray(new int[]{bitmap.getWidth(), bitmap.getHeight(), bitmap.getDensity()});
        }
        if (value instanceof Parcelable) {
            Parcel parcel = Parcel.obtain();
            parcel.writeParcelable((Parcelable) value, 0);
            byte[] bytes = parcel.marshall();
            parcel.recycle();
            return Base64.encodeToString(bytes, Base64.NO_WRAP);
        }
        if (value instanceof CharSequence) return value.toString();
        return value.getClass().getName();
    }

    private static void put(JSONObject object, String key, Object value) {
        try { object.put(key, value); }
        catch (Exception error) { throw new IllegalStateException(error); }
    }
}
