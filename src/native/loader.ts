// The System.loadLibrary hook for lib/{armeabi,armeabi-v7a}/lib<name>.so: registers the host
// libraries once, loads + relocates the module, runs its init arrays and JNI_OnLoad.
export async function loadNativeLib(_name: string, _bytes: Uint8Array, _abi: string): Promise<void> {
  throw new Error("TODO loadNativeLib");
}
