# Subway Surfers compatibility

Starting revision: `d91679c`.

## Acceptance

- [x] Reproduce the black age screen and frozen Unity player with the unchanged Subway Surfers APK.
- [x] Trace the input failure through native execution rather than substituting app behavior.
- [x] Preserve CPU register ownership across pthread startup and asynchronous signal delivery.
- [x] Render GLES3-core ETC2/EAC textures without requiring an earlier extension query from the app.
- [x] Reach and interact with the age gate, loading screen, main menu, and live gameplay in Chrome.
- [x] Complete the final typecheck, unit, smoke, framework, text, E2E, and corpus verification matrix.

## Thermo-nuclear follow-up

- [x] Confirm production compatibility logic contains no package- or app-specific checks.
- [x] Replace repeated CPU ownership conditions and microtask polling with one base-availability invariant.
- [x] Name and centralize the complete GLES3-core ETC2/EAC format policy.
- [x] Repeat the final verification matrix after the structural cleanup.

## Scope

The compatibility changes stay in the native CPU scheduler, pthread startup, and GLES3 bridge.
The two scheduler regressions have focused ARM32/A64 tests. Graphics acceptance uses the unchanged
game because the browser's extension-activation behavior and Unity's upload sequence are the
relevant integration boundary; no app-specific path or synthetic texture substitute is added.
