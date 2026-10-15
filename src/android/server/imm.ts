// InputMethodManagerService and the one input method, for AOSP's InputMethodManager: the browser
// keyboard (the page's text control, ime.ts) in the role of InputMethodService. An editor's
// startInput binds it with an IInputMethodSession that hears the editor's selection and text; the
// page's edits reach the editor through its IRemoteInputConnection; showSoftInput and hideSoftInput
// focus or blur that control and report the ime() insets source to the windows (wm.ts).
import { once } from "../../jvm/suspend";
import { rt, JObj, noops, stubs, getDeclared, driven, type Gen } from "../../jvm/runtime";
import { after, scall, staticField, newObj, vcall } from "../../jvm/natives/jentry";
import { logUncaught, detached } from "../../jvm/natives/jthrowable";
import { newArrayList } from "../../jvm/natives/jcoll";
import { hostStub } from "../binder";
import { postMain } from "../mainloop";
import { type ImeSession, serveInput, showInput, extractedInput, mirrorInput } from "../ime";
import { setImeShown } from "./wm";

const CLIENT = "Lcom/android/internal/inputmethod/IInputMethodClient;";
const BIND = "com/android/internal/inputmethod/InputBindResult";
const HEADER = "com/android/internal/inputmethod/InputConnectionCommandHeader";
const EDITOR = "Landroid/view/inputmethod/EditorInfo;Lcom/android/internal/inputmethod/IRemoteInputConnection;";
const START = `(I${CLIENT}Landroid/os/IBinder;III${EDITOR}Lcom/android/internal/inputmethod/IRemoteAccessibilityInputConnection;IILandroid/window/ImeOnBackInvokedDispatcher;`;
const IME_ID = "webdroid/.BrowserKeyboard";
const SUCCESS_WITH_IME_SESSION = 0, GET_EXTRACTED_TEXT_MONITOR = 1;

interface Session extends ImeSession { window: JObj; id: number; header: JObj | null }
let session: Session | null = null;
let bindSequence = 0;
const editorField = (info: JObj, name: string) => getDeclared<number>(info, "android/view/inputmethod/EditorInfo", name);

/** InputMethodService.onStartInput: serve the editor, and read its text as an IME does, keeping it
 *  monitored so the editor reports each change (updateExtractedText) */
function startInput(window: JObj, info: JObj, connection: JObj, id: number): Session {
  const s: Session = {
    window, id, header: null, text: "", offset: 0, compStart: -1, compEnd: -1,
    start: Math.max(0, editorField(info, "initialSelStart")), end: Math.max(0, editorField(info, "initialSelEnd")),
    imeOptions: editorField(info, "imeOptions"), actionId: editorField(info, "actionId"),
    // an IME's RemoteInputConnection reports a command sent while its session is current
    call: (name, args, ...values) => rt.drive(function* (): Gen<boolean> {
      s.header ??= yield newObj(HEADER, "(I)V", s.id);
      yield vcall(connection, name, `(L${HEADER};${args})V`, s.header, ...values);
      return session === s;
    }()),
  };
  session = s;
  serveInput(s);
  postMain(() => rt.drive(function* (): Gen<void> {
    const request = yield newObj("android/view/inputmethod/ExtractedTextRequest");
    const future = yield newObj("com/android/internal/infra/AndroidFuture");
    yield s.call("getExtractedText", "Landroid/view/inputmethod/ExtractedTextRequest;ILcom/android/internal/infra/AndroidFuture;", request, GET_EXTRACTED_TEXT_MONITOR, future);
    const extracted = yield vcall(future, "getNow", "(Ljava/lang/Object;)Ljava/lang/Object;", null);
    if (extracted && session === s) yield extractedInput(s, extracted);
  }()));
  return s;
}
function finishInput(): void {
  if (!session) return;
  session = null;
  serveInput(null);
  showSoftInput(false);
}
const RESULT_UNCHANGED_SHOWN = 0, RESULT_UNCHANGED_HIDDEN = 1, RESULT_SHOWN = 2, RESULT_HIDDEN = 3;
/** InputMethodService's window shows or hides: the page's text control takes or gives up focus, and
 *  the windows hear the ime() source's visibility. Whether it changed, as ResultReceiver codes. */
function showSoftInput(visible: boolean): number {
  if (!visible && !shown) return RESULT_UNCHANGED_HIDDEN;
  if (visible && shown) return RESULT_UNCHANGED_SHOWN;
  shown = visible;
  showInput(visible);
  detached(() => setImeShown(visible), logUncaught);
  return visible ? RESULT_SHOWN : RESULT_HIDDEN;
}
let shown = false;
/** showSoftInput and hideSoftInput from the client: only the window being served may show it */
function softInput(window: JObj, visible: boolean, receiver: JObj | null): unknown {
  if (visible && session?.window !== window) return 0;
  const result = showSoftInput(visible);
  return after(receiver && vcall(receiver, "send", "(ILandroid/os/Bundle;)V", result, null), () => 1);
}

const SOFT_INPUT_MASK_STATE = 0xf, SOFT_INPUT_STATE_VISIBLE = 4, SOFT_INPUT_STATE_ALWAYS_VISIBLE = 5, SOFT_INPUT_IS_FORWARD_NAVIGATION = 0x100;
function* startInputOrWindowGainedFocus(window: JObj, info: JObj | null, connection: JObj | null, softInputMode: number): Gen<JObj> {
  if (!info || !connection) { finishInput(); return yield staticField(BIND, "NULL_EDITOR_INFO"); }
  startInput(window, info, connection, 0);
  // DefaultImeVisibilityApplier: an always-visible window shows the keyboard for its editor, a
  // visible one only when navigated forward to
  const state = softInputMode & SOFT_INPUT_MASK_STATE;
  if (state === SOFT_INPUT_STATE_ALWAYS_VISIBLE || state === SOFT_INPUT_STATE_VISIBLE && (softInputMode & SOFT_INPUT_IS_FORWARD_NAVIGATION)) showSoftInput(true);
  return yield newObj(BIND, "(ILcom/android/internal/inputmethod/IInputMethodSession;Landroid/util/SparseArray;Landroid/view/InputChannel;Ljava/lang/String;IZ)V",
    SUCCESS_WITH_IME_SESSION, yield methodSession(), null, null, IME_ID, ++bindSequence, 0);
}

// IInputMethodSession: what the client tells the input method about the editor it serves
rt.register({ name: "webdroid/InputMethodSession", ctor: class extends JObj {}, sup: "com/android/internal/inputmethod/IInputMethodSession$Stub", methods: {
  "updateSelection(IIIIII)V": (_os: number, _oe: number, start: number, end: number, compStart: number, compEnd: number) => {
    if (!session) return;
    session.start = start; session.end = end;
    session.compStart = compStart < 0 ? -1 : compStart - session.offset; session.compEnd = compStart < 0 ? -1 : compEnd - session.offset;
    mirrorInput();
  },
  "updateExtractedText(ILandroid/view/inputmethod/ExtractedText;)V": (_token: number, text: JObj) => session && extractedInput(session, text),
  [`invalidateInput(${EDITOR}I)V`]: (info: JObj, connection: JObj, id: number) => { if (session) startInput(session.window, info, connection, id); },
  "finishInput()V": finishInput,
  ...noops("viewClicked(Z)V", "updateCursor(Landroid/graphics/Rect;)V", "displayCompletions([Landroid/view/inputmethod/CompletionInfo;)V",
    "appPrivateCommand(Ljava/lang/String;Landroid/os/Bundle;)V", "finishSession()V", "removeImeSurface()V",
    "updateCursorAnchorInfo(Landroid/view/inputmethod/CursorAnchorInfo;)V"),
} });
// a proxy, as an input method in its own process gives: IInputMethodSessionInvoker posts each call to
// a local session with the editor's arguments unparceled, and the editor reuses its ExtractedText
const methodSession = once(() => after(newObj("webdroid/InputMethodSession"), (session) =>
  newObj("com/android/internal/inputmethod/IInputMethodSession$Stub$Proxy", "(Landroid/os/IBinder;)V", session)));

const emptyInfoList = () => after(newArrayList(), list => scall("com/android/internal/inputmethod/InputMethodInfoSafeList", "create",
  "(Ljava/util/List;)Lcom/android/internal/inputmethod/InputMethodInfoSafeList;", list));
rt.register({ name: "webdroid/InputMethodManagerService", ctor: class extends JObj {}, sup: "com/android/internal/view/IInputMethodManager$Stub", methods: {
  [`startInputOrWindowGainedFocus${START})L${BIND};`]:
    (_reason: number, _client: JObj, window: JObj, _flags: number, mode: number, _windowFlags: number, info: JObj | null, connection: JObj | null) =>
      rt.drive(startInputOrWindowGainedFocus(window, info, connection, mode)),
  [`startInputOrWindowGainedFocusAsync${START}I)V`]:
    driven(function* (_reason: number, client: JObj, window: JObj, _flags: number, mode: number, _windowFlags: number, info: JObj | null, connection: JObj | null, _a11y: JObj, _sdk: number, _user: number, _back: JObj, seq: number) {
      yield vcall(client, "onStartInputResult", `(L${BIND};I)V`, yield* startInputOrWindowGainedFocus(window, info, connection, mode), seq);
    }),
  "getEnabledInputMethodList(I)Lcom/android/internal/inputmethod/InputMethodInfoSafeList;": emptyInfoList,
  "getInputMethodList(II)Lcom/android/internal/inputmethod/InputMethodInfoSafeList;": emptyInfoList,
  "getEnabledInputMethodListLegacy(I)Ljava/util/List;": () => newArrayList(),
  "getInputMethodListLegacy(II)Ljava/util/List;": () => newArrayList(),
  "getEnabledInputMethodSubtypeList(Ljava/lang/String;ZI)Ljava/util/List;": () => newArrayList(),
  [`showSoftInput(${CLIENT}Landroid/os/IBinder;Landroid/view/inputmethod/ImeTracker$Token;IILandroid/os/ResultReceiver;I)Z`]:
    (_client: JObj, window: JObj, _token: JObj, _flags: number, _tool: number, receiver: JObj | null) => softInput(window, true, receiver),
  [`hideSoftInput(${CLIENT}Landroid/os/IBinder;Landroid/view/inputmethod/ImeTracker$Token;ILandroid/os/ResultReceiver;I)Z`]:
    (_client: JObj, window: JObj, _token: JObj, _flags: number, receiver: JObj | null) => softInput(window, false, receiver),
  // the browser keyboard takes no handwriting, so no editor accepts a delegation (IMMS answers false)
  [`acceptStylusHandwritingDelegationAsync(${CLIENT}ILjava/lang/String;Ljava/lang/String;ILcom/android/internal/inputmethod/IBooleanListener;)V`]:
    (_client: JObj, _user: number, _delegate: string, _delegator: string, _flags: number, callback: JObj) => vcall(callback, "onResult", "(Z)V", 0),
  ...stubs(0, `getInputMethodWindowVisibleHeight(${CLIENT})I`, "isImeTraceEnabled()Z", "isStylusHandwritingAvailableAsUser(IZ)Z",
    `acceptStylusHandwritingDelegation(${CLIENT}ILjava/lang/String;Ljava/lang/String;I)Z`),
  ...stubs(null, "getCurrentInputMethodInfoAsUser(I)Landroid/view/inputmethod/InputMethodInfo;",
    "getCurrentInputMethodSubtype(I)Landroid/view/inputmethod/InputMethodSubtype;", "getLastInputMethodSubtype(I)Landroid/view/inputmethod/InputMethodSubtype;",
    "getImeTrackerService()Lcom/android/internal/inputmethod/IImeTracker;"),
  ...noops(`addClient(${CLIENT}Lcom/android/internal/inputmethod/IRemoteInputConnection;I)V`, "removeImeSurface()V",
    "removeImeSurfaceFromWindowAsync(Landroid/os/IBinder;)V", "reportPerceptibleAsync(Landroid/os/IBinder;Z)V",
    `showInputMethodPickerFromClient(${CLIENT}I)V`, `prepareStylusHandwritingDelegation(${CLIENT}ILjava/lang/String;Ljava/lang/String;)V`),
} });
hostStub("input_method", "webdroid/InputMethodManagerService");
