import * as pulumi from "@pulumi/pulumi";
import * as oci from "@pulumi/oci";
import * as cloudflare from "@pulumi/cloudflare";
import { isIPv4 } from "node:net";
import { readFileSync } from "node:fs";
import { freeTierInventory, COMPUTE, DISK_GB, EGRESS_MBIT } from "./free-tier.ts";
import { bootstrap } from "./bootstrap.ts";

const config = new pulumi.Config(), oracle = new pulumi.Config("oci");
const tenancy = oracle.require("tenancyOcid"), region = oracle.require("region");
const owner = `${pulumi.getProject()}/${pulumi.getStack()}`;
const profile = config.get("compute") ?? "arm";
if (profile !== "arm" && profile !== "micro") throw new Error("Only Always Free arm and micro compute profiles are supported");
const compute = COMPUTE[profile];
const inventory = await freeTierInventory(tenancy, region, owner, profile);
pulumi.log.info(`Always Free allocation after apply: ${inventory.allocation}`);
const compartmentId = config.get("compartmentId") ?? tenancy;
const availabilityDomain = config.get("availabilityDomain") ?? inventory.domains[0].name;
const accountId = config.require("cloudflareAccountId"), project = config.get("pagesProject") ?? "webdroid";
const appOrigin = `https://${project}.pages.dev`;
const sshCidr = config.require("sshCidr");
if (!sshCidr.endsWith("/32") || !isIPv4(sshCidr.slice(0, -3))) throw new Error("sshCidr must be the administrator's IPv4 /32");
const tags = { "webdroid-stack": owner };
const vcn = new oci.core.Vcn("network", { compartmentId, cidrBlocks: ["10.42.0.0/24"], freeformTags: tags });
const gateway = new oci.core.InternetGateway("internet", { compartmentId, vcnId: vcn.id, enabled: true });
const routes = new oci.core.RouteTable("routes", { compartmentId, vcnId: vcn.id,
  routeRules: [{ destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", networkEntityId: gateway.id }] });
const firewall = new oci.core.SecurityList("firewall", { compartmentId, vcnId: vcn.id,
  ingressSecurityRules: [
    ...[80, 443].map(port => ({ protocol: "6", source: "0.0.0.0/0", tcpOptions: { min: port, max: port } })),
    { protocol: "6", source: sshCidr, tcpOptions: { min: 22, max: 22 } },
    { protocol: "1", source: "0.0.0.0/0", icmpOptions: { type: 3, code: 4 } },
  ],
  egressSecurityRules: [{ protocol: "all", destination: "0.0.0.0/0" }],
});
export const securityListId = firewall.id;
const subnet = new oci.core.Subnet("subnet", { compartmentId, vcnId: vcn.id, cidrBlock: "10.42.0.0/24",
  routeTableId: routes.id, securityListIds: [firewall.id] });
const images = await oci.core.getImages({ compartmentId, operatingSystem: "Canonical Ubuntu", operatingSystemVersion: "24.04",
  shape: compute.shape, sortBy: "TIMECREATED", sortOrder: "DESC" });
const image = images.images.find(i => !i.compartmentId);
if (!image) throw new Error("No free Ubuntu platform image is available; refusing a marketplace or custom image");
const instance = new oci.core.Instance("backend", {
  compartmentId, availabilityDomain, displayName: "webdroid-backend", shape: compute.shape,
  shapeConfig: profile === "arm" ? { ocpus: compute.ocpus, memoryInGbs: compute.memoryGb } : undefined,
  sourceDetails: { sourceType: "image", sourceId: image.id, bootVolumeSizeInGbs: String(DISK_GB), bootVolumeVpusPerGb: "10" },
  createVnicDetails: { subnetId: subnet.id, assignPublicIp: "true" },
  metadata: { ssh_authorized_keys: readFileSync(config.require("sshPublicKeyPath"), "utf8").trim(), user_data: Buffer.from(bootstrap(compute.arch)).toString("base64") },
  freeformTags: tags,
  preserveBootVolume: false,
}, { deleteBeforeReplace: true, protect: true, ignoreChanges: ["sourceDetails.sourceId"] });
export const publicIp = instance.publicIp;
export const backendOrigin = pulumi.interpolate`https://webdroid.${instance.publicIp}.sslip.io`;
export const frontendOrigin = appOrigin;
export const instanceId = instance.id;
export const freeTier = { shape: compute.shape, ocpus: compute.ocpus, memoryGb: compute.memoryGb, diskGb: DISK_GB, egressMbps: EGRESS_MBIT };
const environment = { compatibilityDate: "2026-10-28", envVars: { BACKEND_ORIGIN: { type: "plain_text", value: backendOrigin } }, serviceBindings: {} };
const pagesProvider = new cloudflare.Provider("default", {});
new cloudflare.PagesProject("frontend", { accountId, name: project, productionBranch: "main",
  deploymentConfigs: { production: environment, preview: environment },
}, { protect: true, provider: pagesProvider });
