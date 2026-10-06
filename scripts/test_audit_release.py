#!/usr/bin/env python3
"""Regressions for dependency-scoped auditing without advisory allowlists."""
import copy
import unittest
from audit_release import evaluate, findings, selected_packages, tree_packages


def fixture():
    packages = [{"id": name, "name": name, "version": "0.16.4" if name == "lru" else "0.1.0"} for name in ["atmusic-server", "atmusic-atproto", "lru"]]
    metadata = {"packages": packages, "resolve": {"nodes": [
        {"id": "atmusic-server", "deps": [{"pkg": "atmusic-atproto", "dep_kinds": [{"kind": None}]}]},
        {"id": "atmusic-atproto", "deps": []}, {"id": "lru", "deps": []}]}}
    warning = {"kind": "unsound", "package": {"name": "lru", "version": "0.16.4"}, "advisory": {"id": "RUSTSEC-2026-0253"}}
    report = {"vulnerabilities": {"count": 0, "found": False, "list": []}, "warnings": {"unsound": [warning]}}
    return report, metadata


class ReleaseAuditTests(unittest.TestCase):
    def test_unselected_dependency_is_reported_outside_release_graph(self):
        report, metadata = fixture()
        active, excluded = evaluate(report, metadata)
        self.assertEqual(active, [])
        self.assertEqual(excluded, report["warnings"]["unsound"])
        self.assertEqual(report, fixture()[0], "scoping must preserve the original failing full report")

    def test_lru_on_selected_release_target_blocks(self):
        report, metadata = fixture()
        metadata["resolve"]["nodes"][1]["deps"].append({"pkg": "lru", "dep_kinds": [{"kind": None}]})
        active, excluded = evaluate(report, metadata)
        self.assertEqual(active, report["warnings"]["unsound"])
        self.assertEqual(excluded, [])

    def test_build_dependency_blocks_and_dev_only_dependency_is_reported(self):
        for kind in ["build", "dev"]:
            report, metadata = fixture()
            metadata["resolve"]["nodes"][0]["deps"].append({"pkg": "lru", "dep_kinds": [{"kind": kind}]})
            active, excluded = evaluate(report, metadata)
            self.assertEqual(len(active), int(kind == "build"))
            self.assertEqual(len(excluded), int(kind == "dev"))

    def test_host_conditional_build_dependency_blocks(self):
        report, musl = fixture()
        host = copy.deepcopy(musl)
        host["resolve"]["nodes"][0]["deps"].append({"pkg":"lru","dep_kinds":[{"kind":"build"}]})
        active, excluded = evaluate(report, musl, host)
        self.assertEqual(active, report["warnings"]["unsound"])
        self.assertEqual(excluded, [])

    def test_disabled_optional_dependency_is_excluded_but_enabled_blocks(self):
        for name,version,advisory in [("lru","0.16.4","RUSTSEC-2026-0253"),("rsa","0.9.10","RUSTSEC-2023-0071")]:
            report,metadata=fixture()
            metadata["packages"][2].update(id=name,name=name,version=version)
            metadata["resolve"]["nodes"][2]["id"]=name
            metadata["resolve"]["nodes"][1]["deps"].append({"pkg":name,"dep_kinds":[{"kind":None}]})
            report["warnings"]["unsound"][0]["package"]={"name":name,"version":version}
            report["warnings"]["unsound"][0]["advisory"]={"id":advisory}
            disabled={("atmusic-server","0.1.0"),("atmusic-atproto","0.1.0")}
            self.assertEqual(evaluate(report,metadata,compiled_packages=disabled)[0],[])
            active,excluded=evaluate(report,metadata,compiled_packages=disabled|{(name,version)})
            self.assertEqual(len(active),1)
            self.assertEqual(excluded,[])

    def test_tree_identity_validation_fails_closed(self):
        self.assertEqual(tree_packages("atmusic-server v0.1.0 (/fixture)\nlru v0.16.4 (*)\n"),{("atmusic-server","0.1.0"),("lru","0.16.4")})
        for invalid in ["","unexpected text","lru"]:
            with self.assertRaises(ValueError): tree_packages(invalid)
        report,metadata=fixture()
        with self.assertRaises(ValueError): evaluate(report,metadata,compiled_packages={("atmusic-server","0.1.0"),("lru","0.99.0")})

    def test_active_vulnerability_blocks_even_with_unselected_warning(self):
        report, metadata = fixture()
        advisory = {"package": {"name": "atmusic-atproto", "version": "0.1.0"}, "advisory": {"id": "RUSTSEC-2026-0119"}}
        report["vulnerabilities"] = {"count": 1, "found": True, "list": [advisory]}
        active, excluded = evaluate(report, metadata)
        self.assertEqual(active, [advisory])
        self.assertEqual(len(excluded), 1)

    def test_malformed_or_incomplete_results_fail_closed(self):
        report, metadata = fixture()
        invalid = copy.deepcopy(report)
        invalid["vulnerabilities"]["count"] = 1
        with self.assertRaises(ValueError): findings(invalid)
        with self.assertRaises(ValueError): selected_packages({"packages":metadata["packages"],"resolve":None})
        invalid = copy.deepcopy(metadata)
        invalid["resolve"]["nodes"][0]["deps"][0]["pkg"] = "missing"
        with self.assertRaises(ValueError): selected_packages(invalid)
        invalid = copy.deepcopy(metadata)
        invalid["resolve"]["nodes"][0]["deps"][0]["dep_kinds"] = []
        with self.assertRaises(ValueError): selected_packages(invalid)


if __name__ == "__main__":
    unittest.main(verbosity=2)
