export const lexicalFrames = (() => {
  const fn = function frameProbe() { return new Error().stack; };
  Object.defineProperty(fn, "name", { value: "frameRenamed" });
  return !fn()?.includes("frameRenamed");
})();
