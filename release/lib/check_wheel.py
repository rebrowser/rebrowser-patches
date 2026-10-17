#!/usr/bin/env python3
"""Inspect a built rebrowser_playwright wheel (used by release/build-python.mjs).

usage: check_wheel.py <wheel> <patched-coreBundle.js> <driver-version> <py-version>

Prints a JSON report; exits non-zero (and prints the failed assertions) when a check fails.
"""
import hashlib
import json
import sys
import zipfile

wheel, core_bundle, driver_version, py_version = sys.argv[1:5]
failures = []
report = {"wheel": wheel}

with zipfile.ZipFile(wheel) as z:
    names = z.namelist()
    report["entries"] = len(names)

    # 1. the embedded driver is the patched rebrowser-playwright-core
    bundle_name = "rebrowser_playwright/driver/package/lib/coreBundle.js"
    if bundle_name not in names:
        failures.append(f"{bundle_name} missing")
    else:
        data = z.read(bundle_name)
        with open(core_bundle, "rb") as f:
            expected = f.read()
        report["coreBundle_sha256"] = hashlib.sha256(data).hexdigest()
        if data != expected:
            failures.append("coreBundle.js in the wheel differs from the patched tarball's")

    pkg_json = "rebrowser_playwright/driver/package/package.json"
    if pkg_json not in names:
        failures.append(f"{pkg_json} missing")
    else:
        pj = json.loads(z.read(pkg_json))
        report["driver_package"] = f"{pj.get('name')}@{pj.get('version')}"
        if pj.get("version") != driver_version:
            failures.append(f"driver package.json version {pj.get('version')} != DRIVER_VERSION {driver_version}")
        if pj.get("name") != "rebrowser-playwright-core":
            failures.append(f"driver package is {pj.get('name')}, expected rebrowser-playwright-core")

    # 2. a Node.js binary ships with the driver
    if not any(n in names for n in ("rebrowser_playwright/driver/node", "rebrowser_playwright/driver/node.exe")):
        failures.append("no node binary under rebrowser_playwright/driver/")

    # 3. the python package is renamed, nothing is left under playwright/
    leftovers = [n for n in names if n.startswith("playwright/")]
    if leftovers:
        failures.append(f"{len(leftovers)} entries under playwright/, e.g. {leftovers[0]}")
    for required in ("rebrowser_playwright/__init__.py", "rebrowser_playwright/sync_api/__init__.py", "rebrowser_playwright/py.typed"):
        if required not in names:
            failures.append(f"{required} missing")
    ver_file = "rebrowser_playwright/_repo_version.py"
    if ver_file not in names or f'version = "{py_version}"' not in z.read(ver_file).decode():
        failures.append(f"{ver_file} missing or not version = \"{py_version}\"")

    # 4. metadata
    metas = [n for n in names if n.endswith(".dist-info/METADATA")]
    if len(metas) != 1:
        failures.append(f"expected one METADATA, found {metas}")
    else:
        meta = z.read(metas[0]).decode()
        fields = dict(line.split(": ", 1) for line in meta.splitlines() if ": " in line and not line.startswith(" "))
        report["name"] = fields.get("Name")
        report["version"] = fields.get("Version")
        if fields.get("Name", "").replace("-", "_").lower() != "rebrowser_playwright":
            failures.append(f"METADATA Name is {fields.get('Name')}")
        if fields.get("Version") != py_version:
            failures.append(f"METADATA Version is {fields.get('Version')}, expected {py_version}")

    bad = z.testzip()
    if bad:
        failures.append(f"corrupt zip member {bad}")

report["failures"] = failures
print(json.dumps(report))
if failures:
    print("\n".join("FAIL: " + f for f in failures), file=sys.stderr)
    sys.exit(1)
