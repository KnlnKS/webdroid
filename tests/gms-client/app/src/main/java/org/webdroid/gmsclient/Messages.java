package org.webdroid.gmsclient;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public class Messages extends FirebaseMessagingService {
    @Override public void onNewToken(String token) {
        getSharedPreferences("messaging", 0).edit().putString("token", token).apply();
    }
    @Override public void onMessageReceived(RemoteMessage message) {
        android.content.SharedPreferences state = getSharedPreferences("messaging", 0);
        state.edit().putInt("received", state.getInt("received", 0) + 1).apply();
    }
}
