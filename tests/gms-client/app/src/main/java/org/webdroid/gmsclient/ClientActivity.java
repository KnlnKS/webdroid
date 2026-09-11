package org.webdroid.gmsclient;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.os.Bundle;
import android.os.Looper;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.google.android.gms.maps.MapView;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;

public class ClientActivity extends Activity {
    private LinearLayout layout;
    private TextView status;
    private MapView map;
    private LocationCallback location;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        status = new TextView(this);
        status.setTextSize(18);
        layout.addView(status);
        button("Availability", () -> status.setText("availability: " + GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(this)));
        button("Sign in", () -> startActivityForResult(GoogleSignIn.getClient(this, GoogleSignInOptions.DEFAULT_SIGN_IN).getSignInIntent(), 1));
        button("Messaging", this::messaging);
        button("Received messages", () -> status.setText("messages: " + getSharedPreferences("messaging", 0).getInt("received", 0)));
        button("Location", this::location);
        button("Map", this::map);
        button("Map probe", () -> startActivity(new Intent(this, MapProbeActivity.class)));
        button("Bitmap probe", () -> BitmapProbe.run(getResources()));
        setContentView(layout);
        status.setText("GMS client ready");
        if (getIntent().getBooleanExtra("bitmap_probe", false)) BitmapProbe.run(getResources());
    }
    private void button(String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setOnClickListener(view -> {
            try { action.run(); } catch (Exception error) { failure(error); }
        });
        layout.addView(button);
    }
    private void failure(Exception error) { status.setText("error: " + error.getClass().getSimpleName()); }
    @Override public void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != 1) return;
        try {
            status.setText("authentication: " + (GoogleSignIn.getSignedInAccountFromIntent(data).getResult(ApiException.class) != null));
        } catch (ApiException error) { status.setText("authentication status: " + error.getStatusCode()); }
    }
    private void messaging() {
        if (FirebaseApp.getApps(this).isEmpty()) {
            Intent config = getIntent();
            String id = config.getStringExtra("firebase_app_id"), key = config.getStringExtra("firebase_api_key");
            String project = config.getStringExtra("firebase_project_id"), sender = config.getStringExtra("firebase_sender_id");
            if (id == null || key == null || project == null || sender == null) { status.setText("Firebase test configuration required"); return; }
            FirebaseApp.initializeApp(this, new FirebaseOptions.Builder().setApplicationId(id).setApiKey(key).setProjectId(project).setGcmSenderId(sender).build());
        }
        status.setText("messaging: requesting registration");
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> {
            getSharedPreferences("messaging", 0).edit().putString("token", token).apply();
            status.setText("messaging: token received");
        }).addOnFailureListener(this::failure);
    }
    private void location() {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, 2); return;
        }
        if (location != null) LocationServices.getFusedLocationProviderClient(this).removeLocationUpdates(location);
        location = new LocationCallback() {
            @Override public void onLocationResult(LocationResult result) {
                Location fix = result.getLastLocation();
                if (fix != null) status.setText("location: callback; accuracy=" + fix.getAccuracy() + "; time=" + fix.getTime());
            }
        };
        status.setText("location: waiting");
        LocationServices.getFusedLocationProviderClient(this).requestLocationUpdates(
                new LocationRequest.Builder(getIntent().getIntExtra("location_priority", Priority.PRIORITY_HIGH_ACCURACY), 1000).build(), location, Looper.getMainLooper()).addOnFailureListener(this::failure);
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == 2 && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) location();
        else status.setText("location: permission denied");
    }
    private void map() {
        if (map != null) return;
        map = new MapView(this);
        map.onCreate(null);
        map.onStart(); map.onResume();
        layout.addView(map, new LinearLayout.LayoutParams(-1, 0, 1));
        map.getMapAsync(ready -> {
            status.setText("map: ready");
            ready.setOnMapLoadedCallback(() -> status.setText("map: loaded"));
            ready.setOnCameraIdleListener(() -> status.setText("map: camera idle"));
        });
    }
    @Override public void onStart() { super.onStart(); if (map != null) map.onStart(); }
    @Override public void onResume() { super.onResume(); if (map != null) map.onResume(); }
    @Override public void onPause() { if (map != null) map.onPause(); super.onPause(); }
    @Override public void onStop() {
        if (location != null) { LocationServices.getFusedLocationProviderClient(this).removeLocationUpdates(location); location = null; }
        if (map != null) map.onStop(); super.onStop();
    }
    @Override public void onDestroy() { if (map != null) map.onDestroy(); super.onDestroy(); }
    @Override public void onLowMemory() { super.onLowMemory(); if (map != null) map.onLowMemory(); }
}
