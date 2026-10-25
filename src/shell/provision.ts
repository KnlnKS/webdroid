import { SYSTEM_PACKAGES } from "./system-packages.ts";
import { packageArchive } from "../android/packagearchive.ts";
import { systemPackage } from "./packedarchive.ts";
import { attr, attrStr, TV } from "../android/axml.ts";
import { Resources, resString } from "../android/res.ts";
import { deviceQualifiers } from "../android/configuration.ts";
import { packages, componentState } from "../android/packages.ts";
import { registerPackage } from "../android/installpackage.ts";
import { mkComponentName, newIntent, putExtra } from "../android/intent.ts";
import { vcall } from "../jvm/natives/jentry.ts";
import { awaited, rt, type Gen } from "../jvm/runtime.ts";
import { asSystem } from "../android/binder.ts";
import { startRemoteService } from "../android/server/activeservices.ts";
import { hexBytes } from "../jvm/abi.ts";

let ready: Promise<void> | null = null;
export function provisionPackages(): Promise<void> {
  return ready ??= Promise.all(SYSTEM_PACKAGES.map(async (spec) => {
    const packed = await systemPackage(spec), index = packed.index;
    const archive = packageArchive(packed.zip, index.certificates.map(hexBytes));
    if (archive.pkg !== spec.pkg) throw new Error(`System package identity mismatch: ${spec.file}`);
    const application = archive.root.children.find((n) => n.name === "application");
    const metadata = application?.children.find((n) => n.name === "meta-data" && attrStr(n, "name") === spec.signatureMetadata);
    const value = metadata && attr(metadata, "value");
    // the signature is the package's own string, read before its record exists
    const signature = value?.type === TV.REFERENCE ? resString(new Resources([archive.apk], deviceQualifiers()), value.data) : value?.str;
    if (!signature || !/^(?:[a-f\d]{2})+$/i.test(signature)) throw new Error(`Invalid compatibility signature: ${spec.file}`);
    const record = registerPackage(archive, { source: packed, system: true, grants: [...spec.grants, ...spec.defaultGrants], signatures: [hexBytes(signature)] });
    for (const name of spec.disabledComponents) {
      if (!Object.values(record.components).some(components => components.has(name))) throw new Error("Provisioned component unavailable: " + name);
      const component = { pkg: record.pkg, cls: name };
      if (componentState.get(component) === null) componentState.set(component, 2);
    }
  })).then(() => {});
}
/** the system starting each package's provisioning service */
export const provisionServices = (options: { attestationEnabled: boolean }): Promise<void> => asSystem(() => rt.drive(function* (): Gen<void> {
  for (const spec of SYSTEM_PACKAGES) {
    if (!spec.provision) continue;
    const owner = packages.get(spec.pkg)!, component = owner.components.service.get(spec.provision.component);
    if (!component) throw new Error("Provisioning service unavailable: " + spec.pkg);
    const intent = yield* awaited(newIntent());
    yield vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", yield* awaited(mkComponentName(spec.pkg, spec.provision.component)));
    const extras = { ...spec.provision.extras,
      ...(options.attestationEnabled && "attestationExtras" in spec.provision ? spec.provision.attestationExtras : {}) };
    for (const [key, value] of Object.entries(extras)) yield putExtra(intent, key, +value, "Z");
    yield startRemoteService(owner.pkg, owner.process(component), intent, false);
  }
}()));
