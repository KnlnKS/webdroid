// IDisplayManager, under AOSP's DisplayManagerGlobal, DisplayManager and Display: the device
// profile's one built-in display. Geometry, density and refresh rate come from the profile; the
// rest is what the reference AVD answers an app (app_process as uid 2000: getDisplayInfo(0),
// getPreferredWideGamutColorSpaceId, getOverlaySupport, getBrightness).
import { rt, JObj, noops, driven, type Gen } from "../jvm/runtime.ts";
import { mangleField, jarray } from "../jvm/abi.ts";
import { newObj, scall, vcall, staticField } from "../jvm/natives/jentry.ts";
import { hostService, binderEscape } from "./binder.ts";
import { handle, deref, FINALIZER } from "./handles.ts";
import { nativeParcel, readInt, writeInt } from "./parcel.ts";
import { device } from "../shell/config.ts";
import { detached } from "../jvm/natives/jthrowable.ts";

const INFO = "android/view/DisplayInfo";
/** a Display.Mode for the panel, in its natural (portrait) orientation */
const mode = () => newObj("android/view/Display$Mode", "(IIIFFZ[F[I)V", 1, Math.min(device.width, device.height),
  Math.max(device.width, device.height), device.refreshRate, device.refreshRate, 0, new Float32Array(0), new Int32Array(0));

const displayInfo = driven(function* (): Gen<JObj> {
  const info: Record<string, unknown> = yield newObj(INFO, "()V");
  const { width, height } = device, short = Math.min(width, height), long = Math.max(width, height);
  const rate = device.refreshRate, interval = device.frameIntervalNanos;
  const date = yield newObj("android/hardware/display/DeviceProductInfo$ManufactureDate", "(Ljava/lang/Integer;Ljava/lang/Integer;)V",
    yield scall("java/lang/Integer", "valueOf", "(I)Ljava/lang/Integer;", 27), yield scall("java/lang/Integer", "valueOf", "(I)Ljava/lang/Integer;", 2006));
  const values: Record<string, unknown> = {
    layerStack: 0, flags: 16515, type: 1, displayId: 0, displayGroupId: 0,
    address: yield scall("android/view/DisplayAddress", "fromPhysicalDisplayId", "(J)Landroid/view/DisplayAddress$Physical;", 4619827259835644672n),
    deviceProductInfo: yield newObj("android/hardware/display/DeviceProductInfo",
      "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/Integer;Landroid/hardware/display/DeviceProductInfo$ManufactureDate;I)V",
      "EMU_display_0", "GGL", "1", null, date, 0),
    name: "Built-in Screen", uniqueId: "local:4619827259835644672",
    appWidth: width, appHeight: height, logicalWidth: width, logicalHeight: height,
    smallestNominalAppWidth: short, smallestNominalAppHeight: short, largestNominalAppWidth: long, largestNominalAppHeight: long,
    rotation: width > height ? 1 : 0, modeId: 1, renderFrameRate: rate, defaultModeId: 1, userPreferredModeId: -1,
    supportedModes: jarray([yield mode()], "Landroid/view/Display$Mode;"),
    appsSupportedModes: jarray([yield mode()], "Landroid/view/Display$Mode;"),
    colorMode: 0, supportedColorModes: Int32Array.of(0),
    hdrCapabilities: yield newObj("android/view/Display$HdrCapabilities", "([IFFF)V", new Int32Array(0), 500, 500, 0),
    userDisabledHdrTypes: new Int32Array(0), minimalPostProcessingSupported: 0,
    logicalDensityDpi: device.densityDpi, physicalXDpi: device.densityDpi, physicalYDpi: device.densityDpi,
    appVsyncOffsetNanos: 1000000n, presentationDeadlineNanos: interval, state: 2, committedState: 2, ownerUid: 0,
    refreshRateOverride: rate, removeMode: 0, brightnessMinimum: 0, brightnessMaximum: 1, brightnessDefault: BRIGHTNESS,
    roundedCorners: yield staticField("android/view/RoundedCorners", "NO_ROUNDED_CORNERS"),
    installOrientation: 0,
    displayShape: yield scall("android/view/DisplayShape", "createDefaultDisplayShape", "(IIZ)Landroid/view/DisplayShape;", width, height, 0),
    hdrSdrRatio: NaN, thermalRefreshRateThrottling: yield newObj("android/util/SparseArray", "()V"), thermalBrightnessThrottlingDataId: "default",
  };
  for (const [name, value] of Object.entries(values)) info[mangleField(INFO, name)] = value;
  return info as unknown as JObj;
});
const BRIGHTNESS = 0.39763778;

// OverlayProperties: hardware composition the display offers. The AVD composes everything on the
// GPU, so it supports no format/dataspace combination and no mixed color spaces; the default, which
// a client builds without a display, allows mixed color spaces and names no combination either.
interface Overlay { mixed: boolean }
rt.registerJnis("android/hardware/OverlayProperties", {
  "nCreateDefault()J": () => handle({ mixed: true } satisfies Overlay),
  "nGetDestructor()J": () => FINALIZER,
  "nSupportMixedColorSpaces(J)Z": (h: bigint) => +deref<Overlay>(h).mixed,
  "nIsCombinationSupported(JII)Z": () => 0,
  // gui::OverlayProperties: its combinations (none), then whether color spaces may mix
  "nWriteOverlayPropertiesToParcel(JLandroid/os/Parcel;)V": (h: bigint, parcel: JObj) => {
    const p = nativeParcel(parcel);
    writeInt(p, 0); writeInt(p, +deref<Overlay>(h).mixed);
  },
  "nReadOverlayPropertiesFromParcel(Landroid/os/Parcel;)J": (parcel: JObj) => {
    const p = nativeParcel(parcel);
    readInt(p);
    return handle({ mixed: !!readInt(p) } satisfies Overlay);
  },
});

const EVENT_DISPLAY_CHANGED = 2;
const callbacks = new Set<JObj>();
/** DisplayManagerService.sendDisplayEventLocked: the display's geometry or rate changed */
export function notifyDisplayChanged(): void {
  for (const callback of callbacks) {
    detached(() => vcall(callback, "onDisplayEvent", "(II)V", 0, EVENT_DISPLAY_CHANGED), binderEscape());
  }
}
const register = (callback: JObj | null) => {
  if (!callback) throw rt.mkThrowable("java/lang/IllegalArgumentException", "listener must not be null");
  callbacks.add(callback);
};

hostService("display", "webdroid/DisplayManagerService", "android/hardware/display/IDisplayManager$Stub", {
  "getDisplayInfo(I)Landroid/view/DisplayInfo;": (id: number) => id === 0 ? displayInfo() : null,
  "getDisplayIds(Z)[I": () => Int32Array.of(0),
  "getPreferredWideGamutColorSpaceId()I": () => 0,
  "getOverlaySupport()Landroid/hardware/OverlayProperties;": async () =>
    newObj("android/hardware/OverlayProperties", "(J)V", handle({ mixed: false } satisfies Overlay)),
  "getStableDisplaySize()Landroid/graphics/Point;": () =>
    newObj("android/graphics/Point", "(II)V", Math.min(device.width, device.height), Math.max(device.width, device.height)),
  "getBrightness(I)F": () => BRIGHTNESS,
  // no Wi-Fi display adapter, as on the reference AVD: the feature is unavailable
  "getWifiDisplayStatus()Landroid/hardware/display/WifiDisplayStatus;": () => newObj("android/hardware/display/WifiDisplayStatus"),
  "registerCallback(Landroid/hardware/display/IDisplayManagerCallback;)V": register,
  "registerCallbackWithEventMask(Landroid/hardware/display/IDisplayManagerCallback;J)V": register,
  ...noops("disableConnectedDisplay(I)V"),
});
