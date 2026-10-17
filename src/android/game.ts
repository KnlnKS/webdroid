// IGameManagerService, under AOSP's GameManager and GameState: a game (its category, or the legacy
// isGame flag) runs in the standard mode; anything else does not support game modes. The states a
// game reports feed only the power HAL, which is not modelled.
import { JObj, rt, noops } from "../jvm/runtime.ts";
import { appHost } from "./apphost.ts";
import { hostStub } from "./binder.ts";
import { packages } from "./packages.ts";
import { attr } from "./axml.ts";

const GAME_MODE_UNSUPPORTED = 0, GAME_MODE_STANDARD = 1, CATEGORY_GAME = 0;
function isGame(pkg: string | null): boolean {
  if (!appHost || pkg !== appHost.pkg) throw rt.mkThrowable("java/lang/SecurityException", "Access denied, requires android.permission.MANAGE_GAME_MODE");
  const app = packages.get(pkg)?.application;
  return !!app && (attr(app, "appCategory")?.data === CATEGORY_GAME || !!attr(app, "isGame")?.data);
}
rt.register({ name: "webdroid/GameManagerService", ctor: class extends JObj {}, sup: "android/app/IGameManagerService$Stub", methods: {
  "getGameMode(Ljava/lang/String;I)I": (pkg: string | null) => isGame(pkg) ? GAME_MODE_STANDARD : GAME_MODE_UNSUPPORTED,
  "setGameState(Ljava/lang/String;Landroid/app/GameState;I)V": (pkg: string | null) => { isGame(pkg); },
  ...noops("notifyGraphicsEnvironmentSetup(Ljava/lang/String;I)V"),
  "isAngleEnabled(Ljava/lang/String;I)Z": () => 0,
} });
hostStub("game", "webdroid/GameManagerService");
