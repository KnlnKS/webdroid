import { SYSTEM_PACKAGES } from "./system-packages";
import { packageArchive } from "../android/packagearchive";
import { packedArchives, systemPackage } from "./packedarchive";
import { installedPath, registerPackage } from "../android/pm";
import { attr, attrStr, TV } from "../android/axml";
import { resString } from "../android/res";
import { vfs } from "./vfs";
import { packages, signaturePermissions, componentState } from "../android/packages";
import { mkComponentName, newIntent, putExtra } from "../android/intent";
import { vcall } from "../jvm/natives/jentry";
import { awaited, rt, type Gen } from "../jvm/runtime";
import { asSystem } from "../android/binder";
import { serviceTransport } from "../android/server/activeservices";
import { hexBytes } from "../jvm/abi";

let ready: Promise<void> | null = null;
export function provisionPackages(): Promise<void> {
  return ready ??= Promise.all(SYSTEM_PACKAGES.map(async (spec) => {
    const packed = await systemPackage(spec), index = packed.index;
    const archive = packageArchive(packed.zip, index.certificates.map(hexBytes));
    if (archive.pkg !== spec.pkg) throw new Error(`System package identity mismatch: ${spec.file}`);
    const record = registerPackage(archive);
    record.system = true;
    for (const name of spec.disabledComponents) {
      if (!Object.values(record.components).some(components => components.has(name))) throw new Error("Provisioned component unavailable: " + name);
      const component = { pkg: record.pkg, cls: name };
      if (globalThis.localStorage?.getItem(componentState.key(component)) === null) componentState.set(component, 2);
    }
    for (const permission of spec.grants) { record.grants.add(permission); signaturePermissions.add(permission); }
    for (const permission of spec.defaultGrants) record.grants.add(permission);
    const metadata = record.application?.children.find((n) => n.name === "meta-data" && attrStr(n, "name") === spec.signatureMetadata);
    const value = metadata && attr(metadata, "value");
    const signature = value?.type === TV.REFERENCE ? resString(record.res, value.data) : value?.str;
    if (!signature || !/^(?:[a-f\d]{2})+$/i.test(signature)) throw new Error(`Invalid compatibility signature: ${spec.file}`);
    record.compatibilityCertificates = [hexBytes(signature)];
    packedArchives.set(installedPath(record.pkg), packed);
    vfs.mount(installedPath(record.pkg), packed);
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
    yield serviceTransport.start(owner, owner.process(component), intent, false);
  }
}()));
