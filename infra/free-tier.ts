import * as oci from "@pulumi/oci";

export const COMPUTE = {
  arm: { shape: "VM.Standard.A1.Flex", ocpus: 1, memoryGb: 6, arch: "arm64", flex: true },
  micro: { shape: "VM.Standard.E2.1.Micro", ocpus: 0.125, memoryGb: 1, arch: "x64", flex: false },
} as const;
export const DISK_GB = 50, EGRESS_MBIT = 20;
/** the tenancy's Always Free allowance */
export const LIMITS = { ocpus: 2, memoryGb: 12, diskGb: 200, micro: 2 };

export async function freeTierInventory(tenancy: string, region: string, owner: string, profile: keyof typeof COMPUTE) {
  const regions = await oci.identity.getRegionSubscriptions({ tenancyId: tenancy });
  if (!regions.regionSubscriptions.some(r => r.isHomeRegion && r.regionName === region))
    throw new Error("Always Free compute and storage must use the tenancy home region");
  const [compartments, domains] = await Promise.all([
    oci.identity.getCompartments({ compartmentId: tenancy, compartmentIdInSubtree: true, accessLevel: "ANY", state: "ACTIVE" }),
    oci.identity.getAvailabilityDomains({ compartmentId: tenancy }),
  ]);
  const inventory = await Promise.all([tenancy, ...compartments.compartments.map(c => c.id)].map(async compartmentId => {
    const [instances, volumes, boots] = await Promise.all([
      oci.core.getInstances({ compartmentId }), oci.core.getVolumes({ compartmentId }),
      Promise.all(domains.availabilityDomains.map(ad => oci.core.getBootVolumes({ compartmentId, availabilityDomain: ad.name }))),
    ]);
    return { instances: instances.instances.filter(i => i.state !== "TERMINATED"),
      volumes: [...volumes.volumes, ...boots.flatMap(b => b.bootVolumes)].filter(v => v.state !== "TERMINATED") };
  }));
  const instances = inventory.flatMap(i => i.instances), volumes = inventory.flatMap(i => i.volumes);
  const owned = instances.filter(i => i.freeformTags["webdroid-stack"] === owner);
  if (owned.length > 1) throw new Error("Multiple backend instances found; refusing to allocate more resources");
  const attachments = await Promise.all(owned.map(i => oci.core.getBootVolumeAttachments({
    compartmentId: i.compartmentId, availabilityDomain: i.availabilityDomain, instanceId: i.id,
  })));
  const ownedBoots = new Set(attachments.flatMap(a => a.bootVolumeAttachments.filter(b => b.state === "ATTACHED").map(b => b.bootVolumeId)));
  // every other instance, and this stack's as `profile` describes it
  const planned = [...instances.filter(i => !owned.includes(i))
    .map(i => ({ shape: i.shape, ocpus: i.shapeConfigs[0].ocpus, memoryGb: i.shapeConfigs[0].memoryInGbs })), COMPUTE[profile]];
  const arm = planned.filter(i => i.shape === COMPUTE.arm.shape);
  const used = {
    ocpus: arm.reduce((sum, i) => sum + i.ocpus, 0), memoryGb: arm.reduce((sum, i) => sum + i.memoryGb, 0),
    diskGb: volumes.filter(v => !ownedBoots.has(v.id)).reduce((sum, v) => sum + Number(v.sizeInGbs), DISK_GB),
    micro: planned.filter(i => i.shape === COMPUTE.micro.shape).length,
  };
  const allocation = `${used.ocpus}/${LIMITS.ocpus} OCPUs, ${used.memoryGb}/${LIMITS.memoryGb} GB RAM, ${used.diskGb}/${LIMITS.diskGb} GB disk, ${used.micro}/${LIMITS.micro} micro VMs`;
  if (Object.entries(LIMITS).some(([name, limit]) => used[name as keyof typeof LIMITS] > limit)) throw new Error(`Always Free capacity exceeded: ${allocation}`);
  return { domains: domains.availabilityDomains, allocation };
}
