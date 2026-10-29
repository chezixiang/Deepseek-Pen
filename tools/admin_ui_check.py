#!/usr/bin/env python3
"""用无头 Chrome + CDP 检查管理后台页面：真实登录、逐页点击、收集 JS 异常。

用法：python tools/admin_ui_check.py <admin_url> <admin_password> [screenshot_dir]
依赖：websockets（pip install websockets）
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

from websockets.sync.client import connect

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

# 本机回环不走系统代理（环境里可能配了 http_proxy，会把 127.0.0.1 也代理走）
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http_json(url, data=None, cookie=None, method=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, method=method or ("POST" if body else "GET"))
    req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    with _OPENER.open(req, timeout=20) as r:
        return json.loads(r.read().decode())


def main():
    admin_url = sys.argv[1].rstrip("/")
    password = sys.argv[2]
    shot_dir = sys.argv[3] if len(sys.argv) > 3 else tempfile.gettempdir()
    origin = "/".join(admin_url.split("/")[:3])

    # 首次初始化：服务端只接受本机回环
    status = http_json(origin + "/admin/api/auth/status")
    if not status.get("configured"):
        http_json(origin + "/admin/api/auth/setup", {"password": password})
    login = http_json(origin + "/admin/api/auth/login", {"password": password})
    # 登录响应头里的 cookie 用 urllib 拿不到，这里直接用 auth/setup 的 Set-Cookie
    req = urllib.request.Request(origin + "/admin/api/auth/login", data=json.dumps({"password": password}).encode(),
                                 method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=20) as r:
        set_cookie = r.headers.get("Set-Cookie", "")
    token = ""
    for part in set_cookie.split(";"):
        if part.strip().startswith("penai_admin_session="):
            token = part.split("=", 1)[1].strip()
    if not token:
        print("LOGIN_FAILED", set_cookie)
        return 1

    port = 9333
    profile = tempfile.mkdtemp(prefix="chrome-admin-")
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        "--remote-debugging-port=" + str(port), "--user-data-dir=" + profile, "about:blank"
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                targets = json.loads(_OPENER.open("http://127.0.0.1:%d/json/list" % port, timeout=1).read())
                if targets:
                    break
            except Exception:
                time.sleep(0.2)
        else:
            print("CHROME_NOT_READY")
            return 1
        page = [t for t in targets if t.get("type") == "page"][0]
        ws_url = page["webSocketDebuggerUrl"]

        exceptions = []
        console_errors = []
        with connect(ws_url, max_size=20 * 1024 * 1024) as ws:
            seq = [0]

            def send(method, params=None, wait=True):
                seq[0] += 1
                mid = seq[0]
                ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
                if not wait:
                    return None
                while True:
                    msg = json.loads(ws.recv())
                    if msg.get("id") == mid:
                        return msg
                    ev = msg.get("method")
                    if ev == "Runtime.exceptionThrown":
                        d = msg["params"]["exceptionDetails"]
                        exceptions.append((d.get("text"), (d.get("exception") or {}).get("description", ""))[:2])
                    if ev == "Runtime.consoleAPICalled" and msg["params"].get("type") == "error":
                        console_errors.append(" ".join(str(a.get("value", a.get("description", ""))) for a in msg["params"].get("args", [])))

            send("Page.enable")
            send("Runtime.enable")
            send("Network.enable")
            send("Network.setCookie", {"name": "penai_admin_session", "value": token,
                                       "domain": "127.0.0.1", "path": "/"})
            send("Page.navigate", {"url": admin_url})
            time.sleep(2.5)

            def evaluate(expr):
                r = send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
                return ((r or {}).get("result") or {}).get("result", {}).get("value")

            title = evaluate("document.title")
            navs = evaluate("Array.from(document.querySelectorAll('.nav-item')).map(function(b){return b.getAttribute('data-tab')})")
            print("TITLE", title)
            print("NAV", navs)
            print("AUTH_HIDDEN", evaluate("document.getElementById('authMask').className"))

            tabs = ["overview", "monitor", "devices", "control", "quota", "models", "provider", "feedback", "files", "sessions", "audit", "security"]
            for tab in tabs:
                evaluate("(function(){var b=document.querySelector('[data-tab=\"%s\"]'); if(b) b.click(); return !!b})()" % tab)
                time.sleep(0.7)
                text = evaluate("(function(){var el=document.getElementById('tab-%s'); return el ? el.innerText.slice(0,600) : 'MISSING'})()" % tab)
                print("TAB", tab, "LEN", len(text or ""), "HEAD", (text or "").replace("\n", " | ")[:160])

            # 云控页关键控件是否存在
            evaluate("document.querySelector('[data-tab=\"control\"]').click()")
            time.sleep(0.5)
            print("CONTROL_IDS", evaluate("['annList','annAdd','prEnabled','dbgAllow','upFile','upUploadBtn','ctlNoticeId','ctlUpDisclose'].map(function(i){return i+':'+!!document.getElementById(i)}).join(',')"))

            data = evaluate("(function(){try{return JSON.stringify({ann:document.querySelectorAll('[data-ann]').length, files:document.querySelectorAll('#filesTable table tr').length})}catch(e){return String(e)}})()")
            print("DOM_STATE", data)

            # 宽屏 + 点「新增公告」：验证动态渲染不报错
            send("Emulation.setDeviceMetricsOverride",
                 {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
            time.sleep(0.4)
            evaluate("document.getElementById('annAdd').click()")
            time.sleep(0.4)
            print("ANN_AFTER_ADD", evaluate("document.querySelectorAll('[data-ann]').length"))
            print("SIDEBAR", evaluate("getComputedStyle(document.getElementById('side')).transform"))

            shot = os.path.join(shot_dir, "admin-check.png")
            r = send("Page.captureScreenshot", {"format": "png"})
            if r and r.get("result", {}).get("data"):
                open(shot, "wb").write(base64.b64decode(r["result"]["data"]))
                print("SCREENSHOT", shot)

        print("EXCEPTIONS", len(exceptions))
        for e in exceptions[:10]:
            print("  EXC", (e[0] or "")[:100], (e[1] or "").split("\n")[0][:200])
        print("CONSOLE_ERRORS", len(console_errors))
        for e in console_errors[:10]:
            print("  ERR", e[:200])
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
