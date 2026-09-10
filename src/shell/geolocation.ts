export type LocationFix = {
  latitude: number; longitude: number; accuracy: number; altitude: number | null;
  altitudeAccuracy: number | null; speed: number | null; heading: number | null;
  timestamp: number; monotonic: number; highAccuracy: boolean;
};
export type LocationEvent = { kind: "fix"; fix: LocationFix } | { kind: "error"; code: number };
export class BrowserLocation {
  private subscriptions = new Map<string, { pid: number; highAccuracy: boolean; active: boolean; receive: (event: LocationEvent) => void }>();
  private watch: number | null = null;
  private highAccuracy = false;
  private generation = 0;
  private denied = false;
  last: LocationFix | null = null;
  get available() { return typeof navigator !== "undefined" && !!navigator.geolocation; }
  get enabled() { return this.available && !this.denied; }
  subscribe(pid: number, id: number, highAccuracy: boolean, active: boolean, receive: (event: LocationEvent) => void) {
    this.subscriptions.set(pid + ":" + id, { pid, highAccuracy, active, receive }); this.update();
  }
  remove(pid: number, id?: number) {
    if (id !== undefined) this.subscriptions.delete(pid + ":" + id);
    else for (const [key, sub] of this.subscriptions) if (sub.pid === pid) this.subscriptions.delete(key);
    this.update();
  }
  private update() {
    if (!this.available) return;
    const active = [...this.subscriptions.values()].some(s => s.active);
    const highAccuracy = [...this.subscriptions.values()].some(s => s.active && s.highAccuracy);
    if (this.watch !== null && active && highAccuracy === this.highAccuracy) return;
    const generation = ++this.generation;
    if (this.watch !== null) { navigator.geolocation.clearWatch(this.watch); this.watch = null; }
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
      this.denied = error.code === 1;
      if (this.denied) {
        this.last = null;
        if (this.watch !== null) navigator.geolocation.clearWatch(this.watch);
        this.watch = null; this.generation++;
      }
      this.emit({ kind: "error", code: error.code });
    }, { enableHighAccuracy: highAccuracy, maximumAge: 0 });
  }
  private emit(event: LocationEvent) { for (const sub of this.subscriptions.values()) sub.receive(event); }
}
