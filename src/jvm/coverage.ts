let enabled = false;
const methods = new Set<string>();

export function configureJvmCoverage(value: boolean): void {
  enabled = value;
  methods.clear();
}

export function coverageProbeSource(method: string): string {
  return enabled ? `R.cv(${JSON.stringify(method)});` : "";
}

export const jvmCoverage = {
  get enabled(): boolean { return enabled; },
  hit(method: string): void { methods.add(method); },
  reset(): void { methods.clear(); },
  snapshot(): { enabled: boolean; methods: string[] } {
    return { enabled, methods: [...methods].sort() };
  },
};
