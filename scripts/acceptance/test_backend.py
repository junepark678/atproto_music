#!/usr/bin/env python3
import subprocess
import sys
import unittest
from pathlib import Path
from backend import TARGETS, required_cases


class AcceptanceRunnerTests(unittest.TestCase):
    def test_unrun_gate(self):
        omitted=next(iter(TARGETS))
        result=subprocess.run([sys.executable,str(Path(__file__).with_name("backend.py")),"/missing-static-binary","--skip-target",omitted],capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn("unrun_gate",result.stderr)
        self.assertIn(omitted,result.stderr)
        self.assertNotIn("PASS",result.stdout)

    def test_filtered_or_omitted_cases_cannot_pass(self):
        for output in ["test result: ok. 0 passed; 0 failed; 0 ignored; 5 filtered out;","test ignored_case ... ignored\ntest result: ok. 1 passed; 0 failed; 1 ignored;"]:
            with self.assertRaises(ValueError): required_cases(output,["required_case"])
        self.assertEqual(required_cases("test required_case ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored;",["required_case"]),1)


if __name__ == "__main__": unittest.main(verbosity=2)
