package org.webdroid.gmsclient;

import android.app.Activity;
import android.graphics.Point;
import android.os.Bundle;
import android.util.Log;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.android.gms.maps.CameraUpdateFactory;
import com.google.android.gms.maps.GoogleMap;
import com.google.android.gms.maps.MapView;
import com.google.android.gms.maps.model.CameraPosition;
import com.google.android.gms.maps.model.LatLng;
import com.google.android.gms.maps.model.Marker;
import com.google.android.gms.maps.model.MarkerOptions;

public class MapProbeActivity extends Activity {
    private MapView view;
    private GoogleMap map;
    private Marker marker;
    private TextView status;
    private int loaded, idle, clicks, finished, canceled;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        status = new TextView(this);
        status.setText("map: waiting");
        status.setLines(2);
        layout.addView(status);
        LinearLayout controls = new LinearLayout(this);
        layout.addView(controls);
        button(controls, "Move", () -> map.moveCamera(CameraUpdateFactory.newLatLngZoom(new LatLng(51.5074, -0.1278), 10)));
        button(controls, "Animate", this::animate);
        button(controls, "Twice", () -> {
            animate();
            view.postDelayed(this::animate, 50);
        });
        button(controls, "Marker", () -> {
            if (marker != null) marker.remove();
            marker = map.addMarker(new MarkerOptions().position(map.getCameraPosition().target).title("SDK marker"));
            trace("marker added");
        });
        view = new MapView(this);
        view.onCreate(state);
        layout.addView(view, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(layout);
        view.getMapAsync(ready -> {
            map = ready;
            map.setOnMapLoadedCallback(() -> { loaded++; trace("loaded"); });
            map.setOnCameraIdleListener(() -> { idle++; trace("idle"); });
            map.setOnMarkerClickListener(clicked -> { clicks++; trace("marker clicked"); return false; });
            map.setOnMapClickListener(point -> trace("map clicked"));
            trace("ready");
        });
    }

    private void animate() {
        map.animateCamera(CameraUpdateFactory.zoomBy(1), 500, new GoogleMap.CancelableCallback() {
            @Override public void onFinish() { finished++; trace("finished"); }
            @Override public void onCancel() { canceled++; trace("canceled"); }
        });
    }

    private void button(LinearLayout controls, String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setOnClickListener(v -> { if (map != null) action.run(); });
        controls.addView(button, new LinearLayout.LayoutParams(0, -2, 1));
    }

    private void trace(String event) {
        CameraPosition camera = map.getCameraPosition();
        String line = event + " target=" + camera.target.latitude + "," + camera.target.longitude + " zoom=" + camera.zoom
                + " loaded=" + loaded + " idle=" + idle + " clicks=" + clicks + " finished=" + finished + " canceled=" + canceled;
        if (marker != null) {
            Point point = map.getProjection().toScreenLocation(marker.getPosition());
            int[] origin = new int[2];
            view.getLocationOnScreen(origin);
            line += " marker=" + (origin[0] + point.x) + "," + (origin[1] + point.y);
            line += " screen=" + origin[0] + "," + origin[1];
            view.getLocationInWindow(origin);
            line += " window=" + origin[0] + "," + origin[1] + " size=" + view.getWidth() + "," + view.getHeight();
        }
        status.setText("map: " + event + "; zoom=" + camera.zoom);
        Log.i("GmsClientMap", line);
    }

    @Override public void onStart() { super.onStart(); view.onStart(); }
    @Override public void onResume() { super.onResume(); view.onResume(); }
    @Override public void onPause() { view.onPause(); super.onPause(); }
    @Override public void onStop() { view.onStop(); super.onStop(); }
    @Override public void onDestroy() { view.onDestroy(); super.onDestroy(); }
    @Override public void onLowMemory() { super.onLowMemory(); view.onLowMemory(); }
    @Override public void onSaveInstanceState(Bundle state) { super.onSaveInstanceState(state); view.onSaveInstanceState(state); }
}
