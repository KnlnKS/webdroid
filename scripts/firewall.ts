// The release's SSH access to the backend VM: one marked TCP/22 rule in its OCI security list for the releasing machine's public IPv4,
// added for a backend deployment and removed after it. A runner lost mid-release leaves its rule, which the next release replaces;
// `node scripts/firewall.ts` removes it.
import { readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { ConfigFileReader, Region, SimpleAuthenticationDetailsProvider } from "oci-common";
import { models, VirtualNetworkClient } from "oci-core";
import { isPublicHost } from "../src/native/net-address.ts";

const MARKER = "webdroid GitHub Actions SSH";
type Rules = models.IngressSecurityRule[];
export interface SecurityLists {
  getSecurityList(request: { securityListId: string }): Promise<{ securityList: { ingressSecurityRules: Rules }; etag?: string }>;
  updateSecurityList(request: { securityListId: string; ifMatch?: string; updateSecurityListDetails: { ingressSecurityRules: Rules } }): Promise<unknown>;
}

/** lets `address` alone through the marked rule, or without one removes it; every other rule stays as it is */
export async function sshAccess(lists: SecurityLists, securityListId: string, address?: string): Promise<void> {
  if (address !== undefined && !(isIPv4(address) && isPublicHost(address))) throw new Error(`SSH access needs a public IPv4 address, not ${address}`);
  for (let attempt = 1; ; attempt++) {
    const { securityList, etag } = await lists.getSecurityList({ securityListId }), current = securityList.ingressSecurityRules;
    const rules = current.filter((rule) => rule.description !== MARKER);
    if (address) rules.push({ description: MARKER, protocol: "6", source: `${address}/32`, sourceType: models.IngressSecurityRule.SourceType.CidrBlock,
      isStateless: false, tcpOptions: { destinationPortRange: { min: 22, max: 22 } } });
    else if (rules.length === current.length) return;
    try {
      return void await lists.updateSecurityList({ securityListId, ifMatch: etag, updateSecurityListDetails: { ingressSecurityRules: rules } });
    } catch (error) {
      // the list changed since it was read
      if ((error as { statusCode?: number }).statusCode !== 412 || attempt === 5) throw error;
    }
  }
}

/** the network client of the OCI profile (OCI_CONFIG_FILE), signing with OCI_KEY_FILE in place of its key_file when that is set */
function securityLists(): VirtualNetworkClient {
  const profile = ConfigFileReader.parseDefault(null), get = (name: string) => profile.get(name) ?? "";
  const key = readFileSync(process.env.OCI_KEY_FILE ?? ConfigFileReader.expandUserHome(get("key_file")), "utf8");
  return new VirtualNetworkClient({ authenticationDetailsProvider: new SimpleAuthenticationDetailsProvider(
    get("tenancy"), get("user"), get("fingerprint"), key, profile.get("pass_phrase") ?? null, Region.fromRegionId(get("region"))) });
}

/** `deploy` with this machine let through the security list OCI_SECURITY_LIST_ID names, when it names one */
export async function withSshAccess(deploy: () => Promise<void>): Promise<void> {
  const id = process.env.OCI_SECURITY_LIST_ID;
  if (!id) return deploy();
  const lists = securityLists(), address = (await (await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(30_000) })).text()).trim();
  await sshAccess(lists, id, address);
  try { await deploy(); } finally { await sshAccess(lists, id); }
}

if (import.meta.main) {
  if (!process.env.OCI_SECURITY_LIST_ID) throw new Error("Set OCI_SECURITY_LIST_ID to the backend's security list");
  await sshAccess(securityLists(), process.env.OCI_SECURITY_LIST_ID);
  console.log("Release SSH access removed");
}
