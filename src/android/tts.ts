import { rt, JObj, noops, stubs } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { onMain } from "./mainloop";
import { reportUncaught } from "./os";

rt.register({
  name: "android/speech/tts/UtteranceProgressListener", ctor: class extends JObj {},
  methods: { ...noops("<init>()V", "onStart(Ljava/lang/String;)V", "onDone(Ljava/lang/String;)V",
    "onError(Ljava/lang/String;)V", "onError(Ljava/lang/String;I)V", "onStop(Ljava/lang/String;Z)V",
    "onBeginSynthesis(Ljava/lang/String;III)V", "onAudioAvailable(Ljava/lang/String;[B)V", "onRangeStart(Ljava/lang/String;III)V") },
});
rt.markers("android/speech/tts/TextToSpeech$OnInitListener");
rt.markers("android/speech/RecognitionListener");

function initTextToSpeech(_context: unknown, listener: unknown) {
  if (!listener) rt.npe();
  setTimeout(() => void onMain(() => vcall(listener, "onInit", "(I)V", -1)).catch(reportUncaught), 0);
}

rt.register({
  name: "android/speech/tts/TextToSpeech", ctor: class extends JObj {},
  statics: { SUCCESS: 0, ERROR: -1, QUEUE_FLUSH: 0, QUEUE_ADD: 1,
    LANG_AVAILABLE: 0, LANG_COUNTRY_AVAILABLE: 1, LANG_COUNTRY_VAR_AVAILABLE: 2,
    LANG_MISSING_DATA: -1, LANG_NOT_SUPPORTED: -2 },
  methods: {
    "<init>(Landroid/content/Context;Landroid/speech/tts/TextToSpeech$OnInitListener;)V": initTextToSpeech,
    "<init>(Landroid/content/Context;Landroid/speech/tts/TextToSpeech$OnInitListener;Ljava/lang/String;)V": initTextToSpeech,
    ...stubs(-1, "setOnUtteranceProgressListener(Landroid/speech/tts/UtteranceProgressListener;)I",
      "isLanguageAvailable(Ljava/util/Locale;)I", "setLanguage(Ljava/util/Locale;)I",
      "speak(Ljava/lang/CharSequence;ILandroid/os/Bundle;Ljava/lang/String;)I",
      "playSilentUtterance(JILjava/lang/String;)I", "stop()I"),
    ...noops("shutdown()V"),
  },
});
