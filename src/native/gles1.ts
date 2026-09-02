// OpenGL ES 1.1 fixed-function pipeline over WebGL (one uniform-switched program), plus the native
// EGL entry points (the real surface/context live Java-side in src/android/glview.ts).
import { hostLib } from "./host";

export function gles1Init(): void {
  hostLib("libEGL.so", {});
  hostLib("libGLESv1_CM.so", {});
  hostLib("libGLESv2.so", {});
}
