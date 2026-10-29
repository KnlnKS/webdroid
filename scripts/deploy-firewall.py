import argparse
import ipaddress
import os

import oci
from oci.core.models import IngressSecurityRule, PortRange, TcpOptions, UpdateSecurityListDetails


MARKER = "webdroid GitHub Actions SSH"


def update_access(client, security_list_id, address=None):
    rule = None
    if address is not None:
        ip = ipaddress.IPv4Address(address)
        if not ip.is_global:
            raise ValueError("SSH access requires the runner's public IPv4 address")
        rule = IngressSecurityRule(
            description=MARKER, protocol="6", source=f"{ip}/32", source_type="CIDR_BLOCK",
            is_stateless=False, tcp_options=TcpOptions(destination_port_range=PortRange(min=22, max=22)),
        )
    for attempt in range(5):
        current = client.get_security_list(security_list_id)
        # Serial releases replace any lease left by a lost runner; unrelated rules stay intact.
        rules = [r for r in current.data.ingress_security_rules if r.description != MARKER]
        if rule is not None:
            rules.append(rule)
        if rules == current.data.ingress_security_rules:
            return
        try:
            client.update_security_list(
                security_list_id, UpdateSecurityListDetails(ingress_security_rules=rules),
                if_match=current.headers["etag"],
            )
            return
        except oci.exceptions.ServiceError as error:
            if error.status != 412 or attempt == 4:
                raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Temporarily allow a release runner through OCI SSH ingress")
    parser.add_argument("address", nargs="?", help="Public IPv4 to allow; omit to remove release access")
    args = parser.parse_args()
    config = oci.config.from_file(os.environ.get("OCI_CONFIG_FILE", oci.config.DEFAULT_LOCATION))
    if key_file := os.environ.get("OCI_KEY_FILE"):
        config["key_file"] = key_file
    client = oci.core.VirtualNetworkClient(config, retry_strategy=oci.retry.DEFAULT_RETRY_STRATEGY)
    update_access(client, os.environ["OCI_SECURITY_LIST_ID"], args.address)
    print("Release SSH access enabled" if args.address else "Release SSH access removed")
