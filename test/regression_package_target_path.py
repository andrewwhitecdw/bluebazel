#!/usr/bin/env python3
"""Regression test for package target path generation in bazel-service.ts.

`fetchAllTargetsFromQuery()` synthesizes //pkg/... pseudo-targets from
concrete query labels. Before the fix, the generator interpolated the result
of `String.prototype.split(':')` (an array) into a template literal, which
stringifies to a comma-separated list and produces malformed paths such as
`////src,test_target/...`. The fix uses the package portion only
(`split(':')[0]`) so the generated label is `//src/...`.
"""

import re
import sys
from pathlib import Path


def _ts_array_to_string(value):
    """Mimic TypeScript template-literal coercion of an array."""
    if isinstance(value, list):
        return ",".join(str(item) for item in value)
    return str(value)


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    source_path = repo_root / "src" / "services" / "bazel-service.ts"
    source = source_path.read_text()

    # Static guard: the bug pattern must be gone and both generators must use
    # the package portion of the label.
    bug_pattern = re.compile(r"target\.bazelPath\.split\(':'\)\}/\.\.")
    fixed_pattern = re.compile(r"target\.bazelPath\.split\(':'\)\[0\]\}/\.\.")

    if bug_pattern.search(source):
        print("FAIL: bug pattern found (split(':') without [0])", file=sys.stderr)
        return 1

    fixed_matches = fixed_pattern.findall(source)
    if len(fixed_matches) != 2:
        print(
            f"FAIL: expected 2 fixed generators, found {len(fixed_matches)}",
            file=sys.stderr,
        )
        return 1

    # Behavioral demonstration using the same data the commit verified.
    target = {"bazelPath": "//src:test_target"}

    buggy_line = (
        f"package_test package //"
        f"{_ts_array_to_string(target['bazelPath'].split(':'))}/..."
    )
    if "////src,test_target/..." not in buggy_line:
        print(f"FAIL: unexpected buggy line: {buggy_line}", file=sys.stderr)
        return 1

    fixed_line = (
        f"package_test package {target['bazelPath'].split(':')[0]}/..."
    )
    if fixed_line != "package_test package //src/...":
        print(f"FAIL: unexpected fixed line: {fixed_line}", file=sys.stderr)
        return 1

    print("PASS: package target paths use the package portion only")
    return 0


if __name__ == "__main__":
    sys.exit(main())
