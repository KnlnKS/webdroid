// IGameManagerService, under AOSP's GameManager and GameState: a game (its category, or the legacy
// isGame flag) runs in the standard mode; anything else does not support game modes. The states a
// game reports feed only the power HAL, which is not modelled.
import { JObj, rt, noops } from "../jvm/runtime";
import { appHost } from "./apphost";
import { hostStub } from "./binder";
import { FLAG_IS_GAME, getAppInfo } from "./pm";

const GAME_MODE_UNSUPPORTED = 0, GAME_MODE_STANDARD = 1;
function isGame(pkg: string | null): boolean {
  if (!appHost || pkg !== appHost.pkg) throw rt.mkThrowable("java/lang/SecurityException", "Access denied, requires android.permission.MANAGE_GAME_MODE");
  const info = getAppInfo(appHost);
  return info.category === 0 || !!(info.flags & FLAG_IS_GAME);
}
rt.register({ name: "webdroid/GameManagerService", ctor: class extends JObj {}, sup: "android/app/IGameManagerService$Stub", methods: {
  "getGameMode(Ljava/lang/String;I)I": (pkg: string | null) => isGame(pkg) ? GAME_MODE_STANDARD : GAME_MODE_UNSUPPORTED,
  "setGameState(Ljava/lang/String;Landroid/app/GameState;I)V": (pkg: string | null) => { isGame(pkg); },
  ...noops("notifyGraphicsEnvironmentSetup(Ljava/lang/String;I)V"),
  "isAngleEnabled(Ljava/lang/String;I)Z": () => 0,
} });
hostStub("game", "webdroid/GameManagerService");
