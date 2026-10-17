"""A short functional check through the Python sync API (a subset of the Node scenarios).

usage: python scenarios.py <module> <chromePath> <baseUrl>
  baseUrl = the fixture site, e.g. http://127.0.0.1:41234/
The patch mode comes from REBROWSER_PATCHES_RUNTIME_FIX_MODE. Prints one JSON line
{module, mode, results: [{name, status, ms, error?}]}; exit code 0 unless the browser cannot launch (2).
"""
import importlib
import json
import os
import sys
import time

module, chrome, base = sys.argv[1:4]
api = importlib.import_module(module + ".sync_api")
results = []


def scenario(name, fn, page):
    t0 = time.time()
    rec = {"name": name}
    try:
        fn(page)
        rec["status"] = "ok"
    except Exception as e:  # noqa: BLE001
        msg = str(e).splitlines()[0][:400] if str(e) else repr(e)
        rec["status"] = "timeout" if "Timeout" in msg else "fail"
        rec["error"] = msg
    rec["ms"] = int((time.time() - t0) * 1000)
    results.append(rec)


def check(actual, expected, label="value"):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def evaluate_basic(page):
    page.goto(base + "main.html")
    check(page.evaluate("() => 1 + 1"), 2)


def set_content(page):
    page.set_content("<p id=x>hi</p>", timeout=8000)
    check(page.eval_on_selector("#x", "el => el.textContent"), "hi")


def click_and_read(page):
    page.goto(base + "main.html")
    page.click("#btn", timeout=8000)
    check(page.eval_on_selector("#btn", "el => el.getAttribute('data-clicked')"), "yes", "data-clicked")
    check(page.eval_on_selector("#title", "el => el.textContent"), "Hello Scen")


browser = None
try:
    pw = api.sync_playwright().start()
    browser = pw.chromium.launch(executable_path=chrome, headless=False, args=["--no-sandbox", "--disable-dev-shm-usage"])
    context = browser.new_context(no_viewport=True)
except Exception as e:  # noqa: BLE001
    print("LAUNCH FAILED", str(e).splitlines()[0][:400] if str(e) else repr(e), file=sys.stderr)
    print(json.dumps({"module": module, "mode": os.environ.get("REBROWSER_PATCHES_RUNTIME_FIX_MODE", "default"), "launchError": str(e)[:300], "results": []}))
    sys.exit(2)

for name, fn in (("evaluate-basic", evaluate_basic), ("setContent", set_content), ("click-and-read", click_and_read)):
    page = context.new_page()
    scenario(name, fn, page)
    try:
        page.close(run_before_unload=False)
    except Exception:  # noqa: BLE001
        pass

try:
    browser.close()
    pw.stop()
except Exception:  # noqa: BLE001
    pass
print(json.dumps({"module": module, "mode": os.environ.get("REBROWSER_PATCHES_RUNTIME_FIX_MODE", "default"), "results": results}))
sys.exit(0)
