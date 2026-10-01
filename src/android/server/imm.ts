// IInputMethodManager, under AOSP's InputMethodManager: as a device with no input method enabled
// answers, so an editor gets no IME connection and the soft keyboard never shows.
import { rt, JObj, noops, stubs } from "../../jvm/runtime";
import { scall, linkInit } from "../../jvm/natives/jlang";
import { mangleStaticField } from "../../jvm/abi";
import { newArrayList } from "../../jvm/natives/jcoll";
import { hostStub } from "../binder";

const CLIENT = "Lcom/android/internal/inputmethod/IInputMethodClient;";
const BIND = "com/android/internal/inputmethod/InputBindResult";
const emptyInfoList = () => scall("com/android/internal/inputmethod/InputMethodInfoSafeList", "create",
  "(Ljava/util/List;)Lcom/android/internal/inputmethod/InputMethodInfoSafeList;", newArrayList());
rt.register({ name: "webdroid/InputMethodManagerService", ctor: class extends JObj {}, sup: "com/android/internal/view/IInputMethodManager$Stub", methods: {
  [`startInputOrWindowGainedFocus(I${CLIENT}Landroid/os/IBinder;IIILandroid/view/inputmethod/EditorInfo;Lcom/android/internal/inputmethod/IRemoteInputConnection;Lcom/android/internal/inputmethod/IRemoteAccessibilityInputConnection;IILandroid/window/ImeOnBackInvokedDispatcher;)L${BIND};`]:
    async () => ((await linkInit(BIND)).ctor as Record<string, unknown>)[mangleStaticField("NO_IME")],
  "getEnabledInputMethodList(I)Lcom/android/internal/inputmethod/InputMethodInfoSafeList;": emptyInfoList,
  "getInputMethodList(II)Lcom/android/internal/inputmethod/InputMethodInfoSafeList;": emptyInfoList,
  "getEnabledInputMethodListLegacy(I)Ljava/util/List;": () => newArrayList(),
  "getInputMethodListLegacy(II)Ljava/util/List;": () => newArrayList(),
  "getEnabledInputMethodSubtypeList(Ljava/lang/String;ZI)Ljava/util/List;": () => newArrayList(),
  ...stubs(0, `showSoftInput(${CLIENT}Landroid/os/IBinder;Landroid/view/inputmethod/ImeTracker$Token;IILandroid/os/ResultReceiver;I)Z`,
    `hideSoftInput(${CLIENT}Landroid/os/IBinder;Landroid/view/inputmethod/ImeTracker$Token;ILandroid/os/ResultReceiver;I)Z`,
    `getInputMethodWindowVisibleHeight(${CLIENT})I`, "isImeTraceEnabled()Z", "isStylusHandwritingAvailableAsUser(IZ)Z"),
  ...stubs(null, "getCurrentInputMethodInfoAsUser(I)Landroid/view/inputmethod/InputMethodInfo;",
    "getCurrentInputMethodSubtype(I)Landroid/view/inputmethod/InputMethodSubtype;", "getLastInputMethodSubtype(I)Landroid/view/inputmethod/InputMethodSubtype;",
    "getImeTrackerService()Lcom/android/internal/inputmethod/IImeTracker;"),
  ...noops(`addClient(${CLIENT}Lcom/android/internal/inputmethod/IRemoteInputConnection;I)V`, "removeImeSurface()V",
    "removeImeSurfaceFromWindowAsync(Landroid/os/IBinder;)V", "reportPerceptibleAsync(Landroid/os/IBinder;Z)V",
    `showInputMethodPickerFromClient(${CLIENT}I)V`,
    `startInputOrWindowGainedFocusAsync(I${CLIENT}Landroid/os/IBinder;IIILandroid/view/inputmethod/EditorInfo;Lcom/android/internal/inputmethod/IRemoteInputConnection;Lcom/android/internal/inputmethod/IRemoteAccessibilityInputConnection;IILandroid/window/ImeOnBackInvokedDispatcher;I)V`),
} });
hostStub("input_method", "webdroid/InputMethodManagerService");
