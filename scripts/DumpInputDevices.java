// Run by gen-framework on the reference device (app_process): the key codes each named input
// device answers InputDevice.hasKeys for, one line per device: "<name>\t<code> <code> ...".
import android.view.InputDevice;
import android.view.KeyEvent;

public class DumpInputDevices {
  public static void main(String[] args) {
    int[] all = new int[KeyEvent.getMaxKeyCode() + 1];
    for (int i = 0; i < all.length; i++) all[i] = i;
    for (int id : InputDevice.getDeviceIds()) {
      InputDevice device = InputDevice.getDevice(id);
      boolean[] has = device.hasKeys(all);
      StringBuilder line = new StringBuilder(device.getName()).append('\t');
      for (int i = 0; i < all.length; i++) if (has[i]) line.append(i).append(' ');
      System.out.println(line.toString().trim());
    }
  }
}
