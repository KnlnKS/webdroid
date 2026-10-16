export type LocationFix = {
  latitude: number; longitude: number; accuracy: number; altitude: number | null;
  altitudeAccuracy: number | null; speed: number | null; heading: number | null;
  timestamp: number; monotonic: number; highAccuracy: boolean;
};
/** how often GNSS reports a fix */
const REPEAT_MS = 1000;
export type LocationEvent = { kind: "fix"; fix: LocationFix } | { kind: "error"; code: number } | { kind: "enabled" };
export class BrowserLocation {
  private subscriptions = new Map<string, { pid: number; highAccuracy: boolean; active: boolean; receive: (event: LocationEvent) => void }>();
  private watch: number | null = null;
  private repeat: ReturnType<typeof setInterval> | null = null;
  private highAccuracy = false;
  private generation = 0;
  private denied = false;
  private observingPermission = false;
  last: LocationFix | null = null;
  /** the location switch moved (LocationManagerService writes Secure.LOCATION_MODE) */
  enabledChanged = () => {};
  get available() { return typeof navigator !== "undefined" && !!navigator.geolocation; }
  get enabled() { return this.available && !this.denied; }
  subscribe(pid: number, id: number, highAccuracy: boolean, active: boolean, receive: (event: LocationEvent) => void) {
    this.subscriptions.set(pid + ":" + id, { pid, highAccuracy, active, receive });
    if (this.denied) receive({ kind: "error", code: 1 });
    this.update();
  }
  remove(pid: number, id?: number) {
    if (id !== undefined) this.subscriptions.delete(pid + ":" + id);
    else for (const [key, sub] of this.subscriptions) if (sub.pid === pid) this.subscriptions.delete(key);
    this.update();
  }
  private update() {
    if (!this.available) return;
    let active = false, highAccuracy = false;
    for (const sub of this.subscriptions.values()) if (sub.active) { active = true; highAccuracy ||= sub.highAccuracy; }
    if (active && !this.observingPermission && navigator.permissions) {
      this.observingPermission = true;
      void navigator.permissions.query({ name: "geolocation" }).then(status => {
        const changed = () => {
          if (status.state === "denied") this.deny();
          else {
            if (this.denied && status.state === "granted") { this.denied = false; this.enabledChanged(); this.emit({ kind: "enabled" }); }
            this.update();
          }
        };
        status.onchange = changed; changed();
      }).catch(() => {});
    }
    if (this.watch !== null && active && highAccuracy === this.highAccuracy) return;
    const generation = ++this.generation;
    this.stopWatch();
    if (!active) return;
    this.highAccuracy = highAccuracy;
    this.watch = navigator.geolocation.watchPosition(position => {
      if (generation !== this.generation) return;
      const c = position.coords;
      this.denied = false;
      this.last = { latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy, altitude: c.altitude,
        altitudeAccuracy: c.altitudeAccuracy, speed: c.speed, heading: c.heading, timestamp: position.timestamp,
        highAccuracy, monotonic: performance.timeOrigin + performance.now() - Math.max(0, Date.now() - position.timestamp) };
      this.emit({ kind: "fix", fix: this.last });
    }, error => {
      if (generation !== this.generation) return;
      if (error.code === 1) this.deny();
      else this.emit({ kind: "error", code: error.code });
    }, { enableHighAccuracy: highAccuracy, maximumAge: 0 });
    // A provider reports each second while it runs, but a watch only when the position changes:
    // the position it holds then stands as of now.
    this.repeat = setInterval(() => {
      const last = this.last, now = performance.timeOrigin + performance.now();
      if (!last || now - last.monotonic < REPEAT_MS) return;
      this.last = { ...last, timestamp: Date.now(), monotonic: now };
      this.emit({ kind: "fix", fix: this.last });
    }, REPEAT_MS);
  }
  private stopWatch() {
    if (this.watch !== null) navigator.geolocation.clearWatch(this.watch);
    if (this.repeat !== null) clearInterval(this.repeat);
    this.watch = this.repeat = null;
  }
  private deny() {
    const changed = !this.denied;
    this.denied = true; this.last = null;
    this.stopWatch(); this.generation++;
    if (changed) { this.enabledChanged(); this.emit({ kind: "error", code: 1 }); }
  }
  private emit(event: LocationEvent) { for (const sub of this.subscriptions.values()) sub.receive(event); }
}
