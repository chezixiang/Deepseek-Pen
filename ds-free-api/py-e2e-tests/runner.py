#!/usr/bin/env python3
"""统一端到端测试入口 —— 加载 scenarios/ 下的 JSON 场景文件并执行

用法：
  uv run python runner.py scenarios/basic                    # 全部 basic（两端点）
  uv run python runner.py scenarios/basic --endpoint openai   # 仅 OpenAI
  uv run python runner.py scenarios/repair                    # 全部 repair
  uv run python runner.py scenarios/basic --filter 流式       # 按名称过滤
"""

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
import tomllib
from openai import OpenAI
from anthropic import Anthropic

def load_config() -> dict:
    """加载 e2e 配置，计算安全并发数和端口"""
    config_path = Path(__file__).parent / "config.toml"
    if not config_path.exists():
        print("[警告] 未找到 config.toml，默认配置")
        return {"accounts": 1, "safe_concurrency": 1, "api_key": "sk-test", "port": 22217}
    with open(config_path, "rb") as f:
        config = tomllib.load(f)
    accounts = len(config.get("accounts", []))
    safe = max(1, accounts // 2)
    api_keys = config.get("api_keys", [])
    api_key = api_keys[0]["key"] if api_keys else "sk-test"
    port = config.get("server", {}).get("port", 22217)
    return {"accounts": accounts, "safe_concurrency": safe, "api_key": api_key, "port": port}


def load_scenarios(scenario_dir: str, endpoint: str | None, filter_names: list[str] | None) -> list[dict]:
    """加载场景 JSON 文件"""
    base = Path(scenario_dir)
    if not base.exists():
        print(f"[错误] 场景目录不存在: {scenario_dir}")
        sys.exit(1)

    if base.name == "basic":
        dirs = []
        if endpoint in (None, "openai"):
            dirs.append(base / "openai")
        if endpoint in (None, "anthropic"):
            dirs.append(base / "anthropic")
    else:
        dirs = [base]

    scenarios: list[dict] = []
    for d in dirs:
        if not d.exists():
            continue
        for fpath in sorted(d.glob("*.json")):
            with open(fpath) as f:
                sc = json.load(f)
            if filter_names and not any(f.lower() in sc.get("name", "").lower() for f in filter_names):
                continue
            scenarios.append(sc)

    if not scenarios:
        print(f"[错误] 未找到匹配的场景")
        sys.exit(1)
    return scenarios


def _resolve_scenario(scenario: dict, model: str) -> dict[str, Any]:
    """将场景定义解析为 OpenAI API 参数"""
    # messages 可在顶层或 request 内
    messages = scenario.get("messages") or scenario["request"]["messages"]
    system = scenario.get("system", "")
    if system:
        messages = [{"role": "system", "content": system}, *messages]

    kwargs: dict[str, Any] = dict(model=model, messages=messages)
    # 合并 request 中除 stream 外的参数
    req = scenario.get("request", {})
    kwargs.update({k: v for k, v in req.items() if k != "stream"})

    if "tools" in scenario:
        kwargs["tools"] = scenario["tools"]
    if "tool_choice" in scenario:
        kwargs["tool_choice"] = scenario["tool_choice"]

    return kwargs


def run_openai(client: OpenAI, scenario: dict, model: str) -> dict[str, Any]:
    """执行一次 OpenAI 端点场景"""
    name = scenario["name"]
    req_conf = scenario.get("request", {})
    stream = req_conf.get("stream", False)

    start = time.time()
    result: dict[str, Any] = {
        "name": name, "model": model, "endpoint": "openai",
        "passed": False, "duration": 0.0, "error": None,
    }

    try:
        kwargs = _resolve_scenario(scenario, model)

        if stream:
            collected = _openai_stream_collect(client, **kwargs)
            choice = collected["choices"][0]
        else:
            resp = client.chat.completions.create(**kwargs)
            choice = resp.choices[0]

        result["duration"] = time.time() - start
        result["finish_reason"] = choice.finish_reason
        msg = choice.message
        result["content"] = msg.content or ""
        result["tool_calls"] = [
            {"name": tc.function.name, "arguments": tc.function.arguments}
            for tc in (msg.tool_calls or [])
        ]
        result["has_tool_calls"] = len(result["tool_calls"]) > 0

        # 执行 checks
        checks = scenario.get("checks", {})
        errors = _check_openai(checks, result)
        if errors:
            result["error"] = "; ".join(errors)
        else:
            result["passed"] = True

    except Exception as e:
        result["duration"] = time.time() - start
        result["error"] = str(e)

    return result


def _openai_stream_collect(client: OpenAI, **kwargs: Any) -> dict:
    """流式请求：收集所有 chunks 并组装为 quasi-Response dict"""
    kwargs["stream"] = True
    stream = client.chat.completions.create(**kwargs)

    content_parts: list[str] = []
    tool_call_acc: dict[int, dict] = {}
    finish_reason: str | None = None

    for chunk in stream:
        if not chunk.choices:
            continue
        choice = chunk.choices[0]
        if choice.finish_reason:
            finish_reason = choice.finish_reason
        if choice.delta.content:
            content_parts.append(choice.delta.content)
        if choice.delta.tool_calls:
            for tc in choice.delta.tool_calls:
                idx = tc.index
                if idx not in tool_call_acc:
                    tool_call_acc[idx] = {
                        "id": tc.id or "",
                        "function": {"name": "", "arguments": ""},
                    }
                if tc.id:
                    tool_call_acc[idx]["id"] = tc.id
                if tc.function:
                    if tc.function.name:
                        tool_call_acc[idx]["function"]["name"] += tc.function.name
                    if tc.function.arguments:
                        tool_call_acc[idx]["function"]["arguments"] += tc.function.arguments

    tool_calls_list = sorted(tool_call_acc.values(), key=lambda x: list(tool_call_acc.keys())[list(tool_call_acc.values()).index(x)])
    class FakeChoice:
        def __init__(self, finish: str | None, content: str | None, tcs: list):
            self.finish_reason = finish
            self.message = type("Msg", (), {
                "content": content,
                "tool_calls": [type("TC", (), {"function": type("Fn", (), tc["function"])}) for tc in tcs] if tcs else None,
            })()
    return {"choices": [FakeChoice(finish_reason, "".join(content_parts) or None, tool_calls_list)]}


def _check_openai(checks: dict, result: dict) -> list[str]:
    errors: list[str] = []
    if checks.get("content_not_empty") and not result.get("content"):
        errors.append("内容为空")
    if checks.get("has_tool_calls") and not result.get("has_tool_calls"):
        errors.append("未触发工具调用")
    if checks.get("finish_reason") and result.get("finish_reason") != checks["finish_reason"]:
        errors.append(f"finish_reason={result.get('finish_reason')}, 期望={checks['finish_reason']}")
    if checks.get("tool_names"):
        actual = {tc["name"] for tc in result.get("tool_calls", [])}
        expected = set(checks["tool_names"])
        if not expected.issubset(actual):
            errors.append(f"工具名不匹配: 期望{expected}, 实际{actual}")
    return errors


def run_anthropic(client: Anthropic, scenario: dict, model: str) -> dict[str, Any]:
    """执行一次 Anthropic 端点场景"""
    name = scenario["name"]
    req_conf = scenario.get("request", {})

    start = time.time()
    result: dict[str, Any] = {
        "name": name, "model": model, "endpoint": "anthropic",
        "passed": False, "duration": 0.0, "error": None,
    }

    try:
        # Anthropic 的 messages 始终在 request 内
        kwargs: dict[str, Any] = dict(
            model=model,
            **{k: v for k, v in req_conf.items() if k != "stream"},
        )
        stream = req_conf.get("stream", False)

        if stream:
            msg = _anthropic_stream_collect(client, **kwargs)
        else:
            msg = client.messages.create(**kwargs)

        result["duration"] = time.time() - start
        result["stop_reason"] = msg.stop_reason

        text_blocks = []
        tool_uses = []
        for block in msg.content:
            if block.type == "text":
                text_blocks.append(block.text)
            elif block.type == "tool_use":
                tool_uses.append({"name": block.name, "input": block.input})

        result["content"] = "".join(text_blocks)
        result["tool_uses"] = tool_uses
        result["has_tool_use"] = len(tool_uses) > 0

        checks = scenario.get("checks", {})
        errors = _check_anthropic(checks, result)
        if errors:
            result["error"] = "; ".join(errors)
        else:
            result["passed"] = True

    except Exception as e:
        result["duration"] = time.time() - start
        result["error"] = str(e)

    return result


def _anthropic_stream_collect(client: Anthropic, **kwargs: Any) -> Any:
    """流式请求：收集 Anthropic stream events"""
    kwargs = {k: v for k, v in kwargs.items() if v is not None}
    with client.messages.stream(**kwargs) as stream:
        return stream.get_final_message()


def _check_anthropic(checks: dict, result: dict) -> list[str]:
    errors: list[str] = []
    if checks.get("content_not_empty") and not result.get("content"):
        errors.append("内容为空")
    if checks.get("has_tool_use") and not result.get("has_tool_use"):
        errors.append("未触发工具调用")
    if checks.get("stop_reason") and result.get("stop_reason") != checks["stop_reason"]:
        errors.append(f"stop_reason={result.get('stop_reason')}, 期望={checks['stop_reason']}")
    if checks.get("tool_names"):
        actual = {tu["name"] for tu in result.get("tool_uses", [])}
        expected = set(checks["tool_names"])
        if not expected.issubset(actual):
            errors.append(f"工具名不匹配: 期望{expected}, 实际{actual}")
    return errors


def _print_output(result: dict) -> None:
    """打印模型输出内容（用于 --show-output）"""
    content = (result.get("content") or "")[:300].replace("\n", "\\n")
    if content:
        print(f"    ├ 回复: {content}")
    if result.get("has_tool_calls") or result.get("has_tool_use"):
        calls = result.get("tool_calls") or result.get("tool_uses") or []
        for tc in calls:
            name = tc.get("name", "?")
            args = tc.get("arguments") or tc.get("input") or {}
            args_str = json.dumps(args, ensure_ascii=False)[:120]
            print(f"    ├ 工具: {name}({args_str})")
    fr = result.get("finish_reason") or result.get("stop_reason") or ""
    if fr:
        print(f"    └ 结束: {fr}")
    if result.get("error"):
        print(f"    └ 错误: {result['error']}")


def format_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f}s"
    return f"{seconds / 60:.1f}m"


def print_report(results: list[dict[str, Any]], suite_name: str, parallel: int):
    total = len(results)
    passed = sum(1 for r in results if r["passed"])
    duration = sum(r["duration"] for r in results)

    print(f"\n{'=' * 60}")
    print(f"  {suite_name}")
    print(f"  时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  并行: {parallel}")
    print(f"{'=' * 60}")
    print(f"  总计: {total}  |  通过: {passed}  |  失败: {total - passed}  |  总耗时: {format_duration(duration)}")

    ep_label = {"openai": "OAI", "anthropic": "ANT"}
    for r in sorted(results, key=lambda x: (x["name"], x.get("endpoint", ""), x["model"])):
        status = "✓" if r["passed"] else "✗"
        ep = ep_label.get(r.get("endpoint", ""), "?")
        err = f" | {r['error'][:60]}" if r["error"] else ""
        print(f"    {status} {ep} | {r['name']} | {r['model']} | {r['duration']:6.1f}s{err}")

    if total - passed > 0:
        print(f"\n  {'─' * 48}")
        print(f"  失败详情:")
        for r in results:
            if not r["passed"]:
                print(f"  [{r['endpoint']}] {r['name']} ({r['model']}): {r['error']}")

    print(f"{'=' * 60}\n")
    return {"total": total, "passed": passed, "failed": total - passed, "duration": duration}


def main():
    config = load_config()
    safe_concurrency = config["safe_concurrency"]
    api_key = config["api_key"]

    parser = argparse.ArgumentParser(description="端到端测试统一入口")
    parser.add_argument("scenario_dir", help="场景目录 (如 scenarios/basic 或 scenarios/repair)")
    parser.add_argument("--endpoint", choices=["openai", "anthropic"], default=None, help="端点过滤")
    parser.add_argument("--model", type=str, default=None, help="模型过滤")
    parser.add_argument("--filter", type=str, nargs="*", default=None, help="场景名称关键字过滤（多个用空格分隔）")
    parser.add_argument("--parallel", type=int, default=safe_concurrency, help=f"并行数 (默认: {safe_concurrency})")
    parser.add_argument("--report", type=str, default=None, help="输出 JSON 报告路径")
    parser.add_argument("--show-output", action="store_true", help="显示模型输出内容")
    args = parser.parse_args()

    scenarios = load_scenarios(args.scenario_dir, args.endpoint, args.filter)
    models = [args.model] if args.model else list(dict.fromkeys(m for s in scenarios for m in s.get("models", ["deepseek-default"])))

    port = config["port"]
    oai_client = OpenAI(base_url=f"http://127.0.0.1:{port}/v1", api_key=api_key)
    anth_client = Anthropic(
        base_url=f"http://127.0.0.1:{port}/anthropic", api_key=api_key,
        default_headers={"Authorization": f"Bearer {api_key}"},
        http_client=httpx.Client(timeout=120),
    )

    suite_name = f"{Path(args.scenario_dir).name} 测试"
    print(f"\n{suite_name}")
    print(f"  场景: {len(scenarios)} 个, 模型: {', '.join(models)}, 并行: {args.parallel}")

    tasks: list[tuple[str, str, dict]] = []
    for model in models:
        for sc in scenarios:
            tasks.append((sc["endpoint"], model, sc))

    all_results: list[dict[str, Any]] = [None] * len(tasks)  # type: ignore[list-item]

    # 记录每个任务的标签用于进度展示
    ep_label = {"openai": "OAI", "anthropic": "ANT"}
    task_labels: dict[int, str] = {}
    for i, (ep, model, sc) in enumerate(tasks):
        task_labels[i] = f"{ep_label.get(ep, '?')} | {sc['name']} | {model}"

    with ThreadPoolExecutor(max_workers=args.parallel) as executor:
        def run_task(endpoint: str, model: str, sc: dict) -> tuple[int, dict]:
            if endpoint == "openai":
                return (0, run_openai(oai_client, sc, model))
            return (0, run_anthropic(anth_client, sc, model))

        future_map = {}
        for i, (ep, model, sc) in enumerate(tasks):
            future = executor.submit(run_task, ep, model, sc)
            future_map[future] = i

        done = 0
        passed = 0
        for future in as_completed(future_map):
            idx = future_map[future]
            _, result = future.result()
            all_results[idx] = result
            done += 1
            if result["passed"]:
                passed += 1
            label = task_labels[idx]
            status = "✓" if result["passed"] else "✗"
            err = f" | {result['error'][:60]}" if result["error"] else ""
            print(f"  [{done}/{len(tasks)}] {status} | {label} | {result['duration']:.1f}s{err}")
            if args.show_output:
                _print_output(result)

    report = print_report(all_results, suite_name, args.parallel)

    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump({
                "suite": suite_name,
                "started_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "config": {"parallel": args.parallel, "accounts": config["accounts"]},
                "summary": report,
                "results": all_results,
            }, f, ensure_ascii=False, indent=2)
        print(f"  报告已输出: {args.report}")

    sys.exit(0 if report["failed"] == 0 else 1)


if __name__ == "__main__":
    main()
