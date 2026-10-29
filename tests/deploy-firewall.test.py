import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

import oci
from oci.core.models import IngressSecurityRule

spec = importlib.util.spec_from_file_location("firewall", Path(__file__).parents[1] / "scripts/deploy-firewall.py")
firewall = importlib.util.module_from_spec(spec)
spec.loader.exec_module(firewall)


class AccessTest(unittest.TestCase):
    def test_lease_lifecycle_preserves_other_rules_and_retries_conflicts(self):
        admin = IngressSecurityRule(protocol="6", source="8.8.8.8/32")
        stale = IngressSecurityRule(description=firewall.MARKER, protocol="6", source="1.1.1.1/32")
        concurrent = IngressSecurityRule(protocol="6", source="9.9.9.9/32")
        state = SimpleNamespace(data=SimpleNamespace(ingress_security_rules=[admin, stale]), headers={"etag": "1"})
        client = Mock()
        client.get_security_list.return_value = state

        def update(_id, details, if_match):
            if if_match == "1":
                state.data.ingress_security_rules.append(concurrent)
                state.headers["etag"] = "2"
                raise oci.exceptions.ServiceError(412, "conflict", {}, "changed")
            state.data.ingress_security_rules = details.ingress_security_rules
            self.assertIsNone(details.egress_security_rules)

        client.update_security_list.side_effect = update
        firewall.update_access(client, "firewall", "8.8.4.4")
        rules = state.data.ingress_security_rules
        self.assertEqual(rules[:2], [admin, concurrent])
        self.assertEqual((rules[2].source, rules[2].protocol), ("8.8.4.4/32", "6"))
        self.assertEqual((rules[2].tcp_options.destination_port_range.min, rules[2].tcp_options.destination_port_range.max), (22, 22))
        firewall.update_access(client, "firewall")
        self.assertEqual(state.data.ingress_security_rules, [admin, concurrent])
        calls = client.update_security_list.call_count
        firewall.update_access(client, "firewall")
        self.assertEqual(client.update_security_list.call_count, calls)


if __name__ == "__main__":
    unittest.main()
