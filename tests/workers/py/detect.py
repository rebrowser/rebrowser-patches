"""Python twin of workers/lib-active.mjs: drives a page while fixtures/poc2.html probes run on it.

usage: python detect.py <module> <chromePath> <url>
  module = rebrowser_playwright (patched wheel) or playwright (unpatched control)
The patch mode comes from REBROWSER_PATCHES_RUNTIME_FIX_MODE (inherited by the driver process).
Exit code 1 on failure; prints one JSON line.
"""
import importlib
import json
import os
import sys
import time

module, chrome, url = sys.argv[1:4]
api = importlib.import_module(module + ".sync_api")

steps = 0
failed = False
try:
    with api.sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=chrome,
            headless=False,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        page = browser.new_context(no_viewport=True).new_page()
        page.expose_function("exposedFn", lambda: 1)
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        deadline = time.time() + 30
        finished = False
        i = 0
        while time.time() < deadline:
            page.evaluate("() => document.title")
            page.eval_on_selector("pre", "el => el.tagName")
            steps += 2
            if i == 3:
                page.wait_for_function("() => document.readyState === 'complete'", timeout=5000)
                steps += 1
            finished = page.evaluate("() => (document.getElementById('out')?.textContent || '').length > 0")
            if finished and i >= 9:
                break
            i += 1
            time.sleep(0.6)
        if not finished:
            raise RuntimeError("the probe page did not finish within 30 s")
        browser.close()
except Exception as e:  # noqa: BLE001
    failed = True
    print("FAILED", module, str(e).splitlines()[0][:400] if str(e) else repr(e), file=sys.stderr)

print(json.dumps({"module": module, "mode": os.environ.get("REBROWSER_PATCHES_RUNTIME_FIX_MODE", "default"), "steps": steps, "failed": failed}))
sys.exit(1 if failed else 0)
