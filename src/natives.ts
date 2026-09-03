// Every native module, in dependency order. The browser shell and scripts/audit.ts import
// THIS, never their own copy of the list — a drifted copy makes audit report implemented
// classes as missing. smoke.ts, jsrc.ts and nrun.ts deliberately load a partial list instead:
// a registered native shadows the dex class, and those three exist to compile or dump the
// app's own bytecode.
import "./jvm/natives/jlang";
import "./jvm/natives/jutil";
import "./jvm/natives/jjson";
import "./jvm/natives/jmath";
import "./jvm/natives/jio";
import "./jvm/natives/jconc";
import "./jvm/natives/jtime";
import "./jvm/natives/jtext";
import "./jvm/natives/jreflect";
import "./jvm/natives/jnio";
import "./jvm/natives/jsec";
import "./jvm/natives/jcrypto";
import "./jvm/natives/jnet";
import "./jvm/natives/jzip";
import "./android/gl";
import "./android/glview";
import "./android/os";
import "./android/graphics";
import "./android/fonts";
import "./android/path";
import "./android/text";
import "./android/drawable";
import "./android/resnative";
import "./android/view";
import "./android/widget";
import "./android/inflate";
import "./android/pm";
import "./android/net";
import "./android/app";
import "./android/popup";
import "./android/security";
import "./android/transition";
import "./android/sqlite";
import "./android/compat";
import "./android/dialog";
import "./android/pickers";
import "./android/listview";
import "./android/preference";
import "./android/animator";
import "./android/media";
import "./android/webkit";
import "./android/hardware";
import "./android/location";
import "./android/job";
import "./android/service";
import "./android/documents";
import "./android/provider";
import "./android/ime";
import "./android/notification";
import "./android/base64";
import "./android/conscrypt";
// last of the android modules: the delegates read the classes the ones above define, and
// they register JNI implementations rather than native classes, so nothing shadows anything
import "./android/delegates";
import "./native/loader";
