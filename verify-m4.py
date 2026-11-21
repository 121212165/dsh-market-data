"""M4 真浏览器验收：在 site/index.html 上验证「复制安装命令」与快照标注。

用法：python verify-m4.py
输出：更新 m4-report.json 的 browser 段；截图写到 ../.screenshots/m4-*.png
"""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
SITE = (HERE / "site" / "index.html").as_uri()
SHOTS = HERE.parent / ".screenshots"
SHOTS.mkdir(exist_ok=True)
REPORT = HERE / "m4-report.json"

report = json.loads(REPORT.read_text(encoding="utf-8"))
report.setdefault("browser", {})
errors = []

with sync_playwright() as p:
    try:
        browser = p.chromium.launch(channel="msedge", headless=True)
        engine = "msedge"
    except Exception:
        browser = p.chromium.launch(headless=True)
        engine = "chromium"

    context = browser.new_context(
        viewport={"width": 1280, "height": 900},
        permissions=["clipboard-read", "clipboard-write"],
    )
    page = context.new_page()
    console_errors = []
    page.on("pageerror", lambda e: console_errors.append(str(e)))

    page.goto(SITE, wait_until="load")
    page.wait_for_selector("[data-copy-install]")

    cards = page.locator("[data-group]").count()
    copy_buttons = page.locator("[data-copy-install]").count()
    if cards < 1 or copy_buttons < 1:
        errors.append(f"页面无卡片或复制按钮：cards={cards} buttons={copy_buttons}")

    # Real click -> real clipboard read.
    first = page.locator("[data-copy-install]").first
    expected = first.get_attribute("data-copy-install")
    first.click()
    page.wait_for_timeout(150)
    clipboard = page.evaluate("() => navigator.clipboard.readText()")
    copy_ok = clipboard == expected
    if not copy_ok:
        errors.append(f"复制内容不符：期望 {expected!r}，实际 {clipboard!r}")
    copied_label = first.evaluate("el => el.parentElement.querySelector('.copied').textContent")

    page.screenshot(path=str(SHOTS / "m4-1280-light.png"), full_page=True)

    # Narrow / dark pass: no horizontal overflow.
    page.set_viewport_size({"width": 360, "height": 900})
    page.evaluate("() => { document.documentElement.style.colorScheme = 'dark'; }")
    geom = page.evaluate(
        """() => ({
          inner: window.innerWidth,
          doc: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
        })"""
    )
    overflow_ok = geom["doc"] <= geom["inner"] and geom["body"] <= geom["inner"]
    if not overflow_ok:
        errors.append(f"窄屏横向溢出：{geom}")
    page.screenshot(path=str(SHOTS / "m4-360-dark.png"), full_page=True)

    # 24h stale rule: rewrite only the embedded data timestamp in a temp copy.
    raw = (HERE / "site" / "index.html").read_text(encoding="utf-8")
    old = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    import re
    stale_html = re.sub(r'("generatedAt"\s*:\s*")[^"]+(")', lambda m: m.group(1) + old + m.group(2), raw, count=1)
    tmp = HERE / "site" / ".m4-stale-preview.html"
    tmp.write_text(stale_html, encoding="utf-8")
    try:
        page.goto(tmp.as_uri(), wait_until="load")
        page.wait_for_selector("#generated-at")
        stamp = page.locator("#generated-at")
        stale_ok = "stale" in (stamp.get_attribute("class") or "") and "快照" in stamp.inner_text()
        if not stale_ok:
            errors.append("超过 24h 未标注快照")
    finally:
        tmp.unlink(missing_ok=True)

    if console_errors:
        errors.append("页面脚本异常：" + " | ".join(console_errors))

    browser.close()

report["browser"] = {
    "engine": engine,
    "cardCount": cards,
    "copyButtons": copy_buttons,
    "expectedCommand": expected,
    "clipboardText": clipboard,
    "copyOk": copy_ok,
    "copiedLabel": copied_label,
    "narrowNoOverflow": overflow_ok,
    "geometry": geom,
    "staleBadgeOk": stale_ok,
    "consoleErrors": console_errors,
    "screenshots": ["m4-1280-light.png", "m4-360-dark.png"],
    "errors": errors,
}
report["pass"] = report["pass"] and not errors
REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report["browser"], ensure_ascii=False, indent=2))
print("PASS" if not errors else "FAIL: " + "; ".join(errors))
raise SystemExit(1 if errors else 0)
