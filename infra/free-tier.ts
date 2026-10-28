import * as oci from "@pulumi/oci";

export const COMPUTE = {
  arm: { shape: "VM.Standard.A1.Flex", ocpus: 1, memoryGb: 6, arch: "arm64" },
  micro: { shape: "VM.Standard.E2.1.Micro", ocpus: 0.125, memoryGb: 1, arch: "x64" },
} as const;
export const DISK_GB = 50;

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
  const arm = instances.filter(i => i.shape === COMPUTE.arm.shape && !owned.includes(i));
  const cores = arm.reduce((sum, i) => sum + i.shapeConfigs[0].ocpus, profile === "arm" ? COMPUTE.arm.ocpus : 0);
  const memory = arm.reduce((sum, i) => sum + i.shapeConfigs[0].memoryInGbs, profile === "arm" ? COMPUTE.arm.memoryGb : 0);
  const storage = volumes.filter(v => !owned.some(i => i.bootVolumeId === v.id)).reduce((sum, v) => sum + Number(v.sizeInGbs), DISK_GB);
  const micro = instances.filter(i => i.shape === COMPUTE.micro.shape && !owned.includes(i)).length + (profile === "micro" ? 1 : 0);
  if (micro > 2) throw new Error(`Always Free micro capacity exceeded: ${micro}/2 instances`);
  if (cores > 2 || memory > 12 || storage > 200)
    throw new Error(`Always Free capacity exceeded: ${cores}/2 OCPUs, ${memory}/12 GB RAM, ${storage}/200 GB disk`);
  return { domains: domains.availabilityDomains, cores, memory, storage, micro };
}
