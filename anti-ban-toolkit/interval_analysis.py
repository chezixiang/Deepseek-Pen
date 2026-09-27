#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""net-capture.jsonl 请求间隔分析 —— 延迟禁言排查 P0 工具。

数据源：ds-free-api `server.net_capture = true` 落盘的双向抓包
（$dataDir/logs/net-capture.jsonl，事件含毫秒 ISO 时间戳）。
只统计出站业务请求（dir=="out" && phase=="request"），输出：
  - 按端点类别的请求间隔统计（均值/中位/分位/标准差/变异系数）
  - 滑动窗口密度峰值（60s / 300s）
  - burst 段落（默认 10s 内 ≥5 次）
  - 间隔分布直方图
  - 可选 --mute-at：封禁时刻前 12h 与之后的对比画像

纯离线，无任何网络请求。输出不含 URL 查询串与请求体，只有端点类别与时间，
不落任何凭据/Cookie/设备标识。

用法：
  python interval_analysis.py path/to/net-capture.jsonl
  python interval_analysis.py net-capture.jsonl --mute-at "2026-09-26T08:30:00+08:00"
  python interval_analysis.py net-capture.jsonl --burst-window 10 --burst-count 5
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

# 端点类别：user_driven = 用户驱动（节奏分析主对象）；
# periodic = 设计内周期行为（单列，不参与业务节奏统计）；app = 客户端行为对齐项。
CLASS_OF = [
    ("chat/completion", "completion", "user_driven"),
    ("chat_session/create", "session_create", "user_driven"),
    ("chat_session/delete", "session_delete", "user_driven"),
    ("users/login", "login", "user_driven"),
    ("file/upload", "upload", "user_driven"),
    ("client/settings", "settings", "app"),
    ("fetch_page", "fetch_page", "app"),
    ("deviceprofile", "shumei_mint", "periodic"),
    ("hif", "hif", "periodic"),
]
BUCKETS = [1, 5, 15, 60, 300, 1800, 7200]  # 秒，直方图上边界


def classify(url: str) -> tuple[str, str]:
    for needle, name, kind in CLASS_OF:
        if needle in url:
            return name, kind
    return "other", "other"


def parse_ts(ts: str) -> datetime:
    # net_capture 格式：%Y-%m-%dT%H:%M:%S%.3f%:z（如 2026-09-26T08:00:00.123+08:00）
    try:
        return datetime.fromisoformat(ts)
    except ValueError:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def load_events(path: Path) -> list[tuple[datetime, str, str, str]]:
    """返回 (时间, 类别, kind, method+路径摘要) 列表，按时间升序。"""
    out: list[tuple[datetime, str, str, str]] = []
    with path.open(encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                print(f"  ! 第 {lineno} 行不是合法 JSON，跳过", file=sys.stderr)
                continue
            if ev.get("dir") != "out" or ev.get("phase") != "request":
                continue
            url = ev.get("url", "")
            name, kind = classify(url)
            # 摘要去掉查询串，避免任何 token 进输出
            path_part = url.split("?", 1)[0]
            brief = f"{ev.get('method', '?')} …/{path_part.rsplit('/', 2)[-2]}/{path_part.rsplit('/', 1)[-1]}"
            out.append((parse_ts(ev["ts"]), name, kind, brief))
    out.sort(key=lambda r: r[0])
    return out


def gaps(times: list[datetime]) -> list[float]:
    return [(b - a).total_seconds() for a, b in zip(times, times[1:])]


def stats(gs: list[float]) -> dict:
    if not gs:
        return {"n": 0}
    gs_sorted = sorted(gs)
    n = len(gs)
    mean = sum(gs) / n
    var = sum((g - mean) ** 2 for g in gs) / n
    cv = math.sqrt(var) / mean if mean > 0 else float("nan")
    return {
        "n": n,
        "mean": mean,
        "median": gs_sorted[n // 2],
        "p10": gs_sorted[max(0, n // 10)],
        "p90": gs_sorted[min(n - 1, n * 9 // 10)],
        "min": gs_sorted[0],
        "max": gs_sorted[-1],
        "std": math.sqrt(var),
        "cv": cv,
    }


def fmt_stats(s: dict) -> str:
    if s.get("n", 0) == 0:
        return "无样本"
    return (
        f"n={s['n']} 均值={s['mean']:.1f}s 中位={s['median']:.1f}s "
        f"p10={s['p10']:.1f}s p90={s['p90']:.1f}s 最小={s['min']:.2f}s "
        f"最大={s['max']:.0f}s 标准差={s['std']:.1f}s CV={s['cv']:.2f}"
    )


def max_window(times: list[datetime], secs: float) -> tuple[int, datetime | None]:
    """滑动窗口内的最大请求数及窗口起点。"""
    if not times:
        return 0, None
    best, best_start = 0, None
    lo = 0
    for hi in range(len(times)):
        while (times[hi] - times[lo]).total_seconds() > secs:
            lo += 1
        cnt = hi - lo + 1
        if cnt > best:
            best, best_start = cnt, times[lo]
    return best, best_start


def bursts(times: list[datetime], secs: float, threshold: int) -> list[tuple[datetime, int]]:
    """返回所有满足 [t, t+secs) 内 ≥ threshold 次请求的段（按窗口起点去重合并）。"""
    found: list[tuple[datetime, int]] = []
    lo = 0
    for hi in range(len(times)):
        while (times[hi] - times[lo]).total_seconds() > secs:
            lo += 1
        cnt = hi - lo + 1
        if cnt >= threshold:
            start = times[lo]
            if not found or (start - found[-1][0]).total_seconds() > secs:
                # 计算该 burst 的实际持续请求数
                end = start + timedelta(seconds=secs)
                total = sum(1 for t in times if start <= t < end + timedelta(seconds=0))
                found.append((start, cnt))
    return found


def histogram(gs: list[float]) -> list[str]:
    labels = ["<1s", "1-5s", "5-15s", "15-60s", "1-5min", "5-30min", "30min-2h", ">2h"]
    counts = [0] * (len(BUCKETS) + 1)
    for g in gs:
        idx = len(BUCKETS)
        for i, b in enumerate(BUCKETS):
            if g < b:
                idx = i
                break
        counts[idx] += 1
    total = max(1, len(gs))
    return [
        f"  {lab:>10} | {'#' * min(60, round(c * 60 / total)):60s} {c}"
        for lab, c in zip(labels, counts)
    ]


def print_profile(rows: list[tuple[datetime, str, str, str]], title: str, args) -> None:
    print(f"\n=== {title} ===")
    if not rows:
        print("  无出站请求")
        return
    print(f"  时间范围: {rows[0][0]:%Y-%m-%d %H:%M:%S} ~ {rows[-1][0]:%Y-%m-%d %H:%M:%S}")
    by_class: dict[str, list[datetime]] = defaultdict(list)
    for t, name, _kind, _b in rows:
        by_class[name].append(t)

    kinds = {name: kind for _t, name, kind, _b in rows}
    print("\n-- 按端点类别 --")
    for name in sorted(by_class, key=lambda k: -len(by_class[k])):
        ts = sorted(by_class[name])
        kind = kinds[name]
        tag = {"user_driven": "用户驱动", "app": "客户端行为", "periodic": "设计内周期", "other": "其他"}[kind]
        print(f"  [{tag}] {name:14s} {fmt_stats(stats(gaps(ts))) if len(ts) >= 2 else f'{len(ts)} 次请求（间隔无法统计）'}")

    user_ts = sorted(t for t, _n, k, _b in rows if k == "user_driven")
    all_business = sorted(t for t, _n, k, _b in rows if k in ("user_driven", "app"))
    print("\n-- 业务节奏（用户驱动类合并）--")
    gs_user = gaps(user_ts)
    print(f"  用户驱动: {fmt_stats(stats(gs_user))}")
    if gs_user:
        print("  间隔分布:")
        for line in histogram(gs_user):
            print(line)

    print("\n-- 窗口密度 --")
    for secs in (60, 300):
        n, start = max_window(all_business, secs)
        when = f"{start:%H:%M:%S}" if start else "-"
        print(f"  {secs}s 窗口峰值: {n} 次（起于 {when}）")

    b = bursts(all_business, args.burst_window, args.burst_count)
    if b:
        print(f"\n-- burst（{args.burst_window}s 内 ≥{args.burst_count} 次）--")
        for start, cnt in b[:10]:
            print(f"  {start:%Y-%m-%d %H:%M:%S}  {cnt} 次")
    else:
        print(f"\n-- burst：未发现 {args.burst_window}s 内 ≥{args.burst_count} 次的爆发段 --")

    cv_overall = stats(gs_user).get("cv") if gs_user else None
    if cv_overall is not None:
        if cv_overall > 1.5:
            hint = "变异系数较高，间隔重尾明显，未见明显机器规律"
        elif cv_overall > 0.6:
            hint = "变异系数中等"
        else:
            hint = "变异系数偏低：间隔偏规律，进入人工审查（对照 burst 段与 sleep 路径）"
        print(f"\n  判读: {hint}（仅统计描述，不构成因果结论）")


def main() -> int:
    ap = argparse.ArgumentParser(description="net-capture.jsonl 请求间隔分析（离线）")
    ap.add_argument("capture", type=Path, help="net-capture.jsonl 路径")
    ap.add_argument("--mute-at", help="禁言发现时刻（ISO，如 2026-09-26T08:30:00+08:00）")
    ap.add_argument("--burst-window", type=float, default=10.0, help="burst 窗口秒数（默认 10）")
    ap.add_argument("--burst-count", type=int, default=5, help="burst 阈值次数（默认 5）")
    args = ap.parse_args()

    rows = load_events(args.capture)
    if not rows:
        print("没有找到出站请求事件。确认：① config [server] net_capture = true；② 文件是后端实际写入的 logs/net-capture.jsonl", file=sys.stderr)
        return 2

    if not args.mute_at:
        print_profile(rows, "全时段画像", args)
        return 0

    mute = parse_ts(args.mute_at)
    pre = [r for r in rows if mute - timedelta(hours=12) <= r[0] < mute]
    post = [r for r in rows if r[0] >= mute]
    print(f"封禁参照时刻: {mute:%Y-%m-%d %H:%M:%S %z}（其前 12h 内出站请求 {len(pre)} 条，之后 {len(post)} 条）")
    print_profile(pre, f"封禁前 12h（{mute - timedelta(hours=12):%m-%d %H:%M} ~ {mute:%m-%d %H:%M}）", args)
    print_profile(post, "封禁发现之后", args)
    print("\n提醒：封禁\"发现时间\"≠\"生效时间\"；五要素记录见 docs/deepseek-delayed-mute-audit-2026-09-25.md §6。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
