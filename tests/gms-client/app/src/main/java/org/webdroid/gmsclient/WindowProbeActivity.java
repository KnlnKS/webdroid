package org.webdroid.gmsclient;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.Insets;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.TextView;

public class WindowProbeActivity extends Activity {
    private LinearLayout content;
    private TextView target;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        button("Normal", () -> mode("normal", false, false));
        button("Fullscreen", () -> mode("fullscreen", true, false));
        button("Edge", () -> mode("edge", false, true));
        button("Hide", () -> {
            getWindow().getInsetsController().hide(WindowInsets.Type.systemBars());
            target.postDelayed(() -> trace("hidden", target), 500);
        });
        button("Legacy", () -> {
            getWindow().getInsetsController().show(WindowInsets.Type.systemBars());
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
            target.postDelayed(() -> trace("legacy", target), 500);
        });
        button("Popup", () -> {
            TextView text = label("popup target");
            PopupWindow popup = new PopupWindow(text, 240, 180, true);
            popup.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(Color.WHITE));
            popup.showAsDropDown(target);
            text.postDelayed(() -> trace("popup", text), 250);
        });
        button("Dialog", () -> {
            Dialog dialog = new Dialog(this);
            TextView text = label("dialog target");
            dialog.setContentView(text);
            dialog.show();
            text.postDelayed(() -> {
                trace("dialog", text);
                dialog.getWindow().setLayout(640, 360);
                dialog.getWindow().setGravity(android.view.Gravity.BOTTOM);
                text.postDelayed(() -> {
                    trace("dialog sized", text);
                    dialog.getWindow().setLayout(48, 24);
                    text.postDelayed(() -> {
                        trace("dialog tiny", text);
                        dialog.getWindow().setLayout(0, 0);
                        text.postDelayed(() -> {
                            trace("dialog zero", text);
                            dialog.getWindow().setLayout(640, 360);
                        }, 250);
                    }, 250);
                }, 250);
            }, 250);
        });
        target = label("window target");
        content.addView(target, new LinearLayout.LayoutParams(-1, 180));
        setContentView(content);
        target.postDelayed(() -> trace("initial", target), 250);
        trace("detached", label("detached"));
    }

    private TextView label(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setBackgroundColor(Color.YELLOW);
        return view;
    }

    private void button(String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setOnClickListener(view -> action.run());
        content.addView(button);
    }

    private void mode(String label, boolean fullscreen, boolean edge) {
        getWindow().getInsetsController().show(WindowInsets.Type.systemBars());
        getWindow().getDecorView().setSystemUiVisibility(0);
        getWindow().setFlags(fullscreen ? WindowManager.LayoutParams.FLAG_FULLSCREEN : 0,
                WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().setDecorFitsSystemWindows(!edge);
        target.postDelayed(() -> trace(label, target), 250);
    }

    private void trace(String event, View view) {
        int[] screen = new int[2], window = new int[2], rootScreen = new int[2];
        view.getLocationOnScreen(screen);
        view.getLocationInWindow(window);
        View root = view.getRootView();
        root.getLocationOnScreen(rootScreen);
        String line = event + " screen=" + screen[0] + "," + screen[1]
                + " window=" + window[0] + "," + window[1]
                + " size=" + view.getWidth() + "," + view.getHeight()
                + " root=" + rootScreen[0] + "," + rootScreen[1] + "," + root.getWidth() + "," + root.getHeight();
        WindowInsets insets = view.getRootWindowInsets();
        if (insets != null) {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
            line += " bars=" + bars.left + "," + bars.top + "," + bars.right + "," + bars.bottom;
        }
        Log.i("GmsClientWindow", line);
    }
}
