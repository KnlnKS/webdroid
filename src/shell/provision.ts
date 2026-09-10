import { SYSTEM_PACKAGES } from "./system-packages";
import { parsePackageArchive } from "../android/packagearchive";
import { installedPath, registerPackage } from "../android/pm";
import { attr, attrStr, TV } from "../android/axml";
import { resString } from "../android/res";
import { vfs } from "../jvm/natives/jio";
import { signaturePermissions } from "../android/packages";

let ready: Promise<void> | null = null;
export function provisionPackages(): Promise<void> {
  return ready ??= Promise.all(SYSTEM_PACKAGES.map(async (spec) => {
    const response = await fetch("/system-packages/" + spec.file);
    if (!response.ok) throw new Error(`System package unavailable: ${spec.file}: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    if (Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") !== spec.sha256) throw new Error(`System package digest mismatch: ${spec.file}`);
    const archive = await parsePackageArchive(bytes);
    if (archive.pkg !== spec.pkg) throw new Error(`System package identity mismatch: ${spec.file}`);
    const record = registerPackage(archive);
    record.system = true;
    for (const permission of spec.grants) { record.grants.add(permission); signaturePermissions.add(permission); }
    const metadata = record.application?.children.find((n) => n.name === "meta-data" && attrStr(n, "name") === spec.signatureMetadata);
    const value = metadata && attr(metadata, "value");
    const signature = value?.type === TV.REFERENCE ? resString(record.res, value.data) : value?.str;
    if (!signature || !/^(?:[a-f\d]{2})+$/i.test(signature)) throw new Error(`Invalid compatibility signature: ${spec.file}`);
    record.compatibilityCertificates = [Uint8Array.from(signature.match(/../g)!, (byte) => parseInt(byte, 16))];
    vfs.write(installedPath(record.pkg), bytes);
  })).then(() => {});
}
