import { SYSTEM_PACKAGES } from "./system-packages";
import { packageArchive } from "../android/packagearchive";
import { PackedArchive, packedArchives, sha256, type PackedArchiveIndex } from "./packedarchive";
import { installedPath, registerPackage } from "../android/pm";
import { attr, attrStr, TV } from "../android/axml";
import { resString } from "../android/res";
import { vfs } from "../jvm/natives/jio";
import { signaturePermissions } from "../android/packages";
import { JIntent, componentState, mkComponentName } from "../android/intent";
import { packages } from "../android/packages";
import { serviceTransport } from "../android/runningservices";
import { box, JBool } from "../jvm/natives/jlang";

let ready: Promise<void> | null = null;
export function provisionPackages(): Promise<void> {
  return ready ??= Promise.all(SYSTEM_PACKAGES.map(async (spec) => {
    const response = await fetch("/vendor/microg/" + spec.file.replace(/\.apk$/, ".json"));
    if (!response.ok) throw new Error(`System package unavailable: ${spec.file}: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (await sha256(bytes) !== spec.indexSha256) throw new Error(`System package index digest mismatch: ${spec.file}`);
    const index: PackedArchiveIndex = JSON.parse(new TextDecoder().decode(bytes));
    if (index.version !== 1 || index.sha256 !== spec.sha256) throw new Error(`System package source mismatch: ${spec.file}`);
    const packed = new PackedArchive(index, "/vendor/microg/");
    await packed.prepare();
    const archive = packageArchive(packed.zip, index.certificates.map((c) => Uint8Array.from(c.match(/../g)!, (b) => parseInt(b, 16))));
    if (archive.pkg !== spec.pkg) throw new Error(`System package identity mismatch: ${spec.file}`);
    const record = registerPackage(archive);
    record.system = true;
    for (const name of spec.disabledComponents) {
      if (!Object.values(record.components).some(components => components.has(name))) throw new Error("Provisioned component unavailable: " + name);
      const component = mkComponentName(record.pkg, name);
      if (globalThis.localStorage?.getItem(componentState.key(component)) === null) componentState.set(component, 2);
    }
    for (const permission of spec.grants) { record.grants.add(permission); signaturePermissions.add(permission); }
    const metadata = record.application?.children.find((n) => n.name === "meta-data" && attrStr(n, "name") === spec.signatureMetadata);
    const value = metadata && attr(metadata, "value");
    const signature = value?.type === TV.REFERENCE ? resString(record.res, value.data) : value?.str;
    if (!signature || !/^(?:[a-f\d]{2})+$/i.test(signature)) throw new Error(`Invalid compatibility signature: ${spec.file}`);
    record.compatibilityCertificates = [Uint8Array.from(signature.match(/../g)!, (byte) => parseInt(byte, 16))];
    packedArchives.set(installedPath(record.pkg), packed);
    vfs.mount(installedPath(record.pkg), packed);
  })).then(() => {});
}
export async function provisionServices(): Promise<void> {
  for (const spec of SYSTEM_PACKAGES) {
    if (!spec.provision) continue;
    const owner = packages.get(spec.pkg)!, component = owner.components.service.get(spec.provision.component);
    if (!component) throw new Error("Provisioning service unavailable: " + spec.pkg);
    const intent = new JIntent(); intent.component = spec.provision.component; intent.componentPkg = spec.pkg;
    for (const [key, value] of Object.entries(spec.provision.extras)) intent.extras.map.set(key, box(JBool, value ? 1 : 0));
    await serviceTransport.start(owner, owner.process(component), intent, false);
  }
}
