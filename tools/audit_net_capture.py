"""离线审计本项目 net-capture JSONL；只导出结构、计数和已知错误标志，不导出凭据/正文。"""
import argparse
import collections
import datetime as dt
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlsplit


def path_only(url):
    u = urlsplit(url)
    path = re.sub(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", "[session]", u.path)
    return u.netloc + path


def signals(body):
    if not isinstance(body, str):
        return {}
    out = {}
    try:
        value = json.loads(body)
    except ValueError:
        value = None
    if isinstance(value, dict):
        if isinstance(value.get('code'), (int, float)):
            out['code'] = value['code']
        data = value.get('data') or value
        if isinstance(data, dict):
            if isinstance(data.get('biz_code'), (int, float)):
                out['biz_code'] = data['biz_code']
            biz = data.get('biz_data') or data
            if isinstance(biz, dict):
                chat = (biz.get('user') or {}).get('chat') or biz.get('chat') or biz
                if isinstance(chat, dict) and 'is_muted' in chat:
                    out['is_muted'] = chat['is_muted']
                    until = chat.get('mute_until')
                    if isinstance(until, (int, float)) and until > 0:
                        out['mute_until'] = dt.datetime.fromtimestamp(
                            until, dt.timezone(dt.timedelta(hours=8))).isoformat()
    for block in body.replace('\r\n', '\n').split('\n\n'):
        name = next((x[6:].strip() for x in block.splitlines() if x.startswith('event:')), '')
        if name == 'close':
            out['stream_closed'] = True
        if name != 'hint':
            continue
        data = '\n'.join(x[5:].strip() for x in block.splitlines() if x.startswith('data:'))
        try:
            val = json.loads(data)
        except ValueError:
            continue
        reason = val.get('finish_reason', '')
        # 只允许已知协议标志；不导出任意模型内容或未知错误文本。
        if reason in ('edit_rate_limit', 'rate_limit_reached', 'user_is_muted', 'input_exceeds_limit'):
            out['hint'] = reason
    return out


def peak_count(timestamps, seconds):
    values = sorted(dt.datetime.fromisoformat(x).timestamp() for x in timestamps)
    left = peak = 0
    for right, now in enumerate(values):
        while values[left] <= now - seconds:
            left += 1
        peak = max(peak, right - left + 1)
    return peak


def audit(path):
    phases = collections.Counter()
    pairs = {}
    sessions = []
    generation = -1
    tagged_generations = {}
    next_generation = 0
    first = last = None
    malformed = []
    with path.open(encoding='utf-8') as source:
        for line_no, line in enumerate(source, 1):
            try:
                event = json.loads(line)
            except ValueError:
                malformed.append(line_no)
                continue
            phases[event.get('phase')] += 1
            first = first or event.get('ts')
            last = event.get('ts')
            tag = event.get('session_id')
            if isinstance(tag, str) and tag:
                if tag not in tagged_generations:
                    tagged_generations[tag] = next_generation
                    next_generation += 1
                generation = tagged_generations[tag]
            if event.get('phase') == 'session':
                if not tag:
                    generation = next_generation
                    next_generation += 1
                sessions.append({'generation': generation, 'line': line_no,
                                 'time': event.get('ts'), 'version': event.get('version')})
                continue
            event['_line'] = line_no
            pairs.setdefault((generation, event.get('id')), {})[event.get('phase')] = event
    endpoints = collections.Counter()
    outcomes = collections.Counter()
    timelines = []
    generations = []
    ids = set()
    accounts = set()
    smids = set()
    for (generation, rid), pair in pairs.items():
        q = pair.get('request')
        if not q:
            continue
        endpoint = path_only(q.get('url', ''))
        direction = q.get('dir')
        endpoints[(direction, q.get('method'), endpoint)] += 1
        if direction != 'out':
            continue
        outcomes[(urlsplit(q.get('url', '')).netloc, pair.get('response', {}).get('status', 'transport_error'))] += 1
        response = pair.get('response_body', {})
        state = signals(response.get('body'))
        row = {'generation': generation, 'id': rid, 'line': q['_line'], 'time': q.get('ts'),
               'end_time': response.get('ts'), 'endpoint': endpoint,
               'http_status': pair.get('response', {}).get('status'), **state}
        if endpoint.endswith('/users/login'):
            raw = q.get('body')
            try:
                v = json.loads(raw) if isinstance(raw, str) else {}
            except ValueError:
                v = {}
            ids.add(v.get('device_id'))
            accounts.add((v.get('email'), v.get('mobile')))
            timelines.append(row)
        elif state.get('code') or state.get('biz_code') or state.get('hint') or state.get('is_muted'):
            timelines.append(row)
        if endpoint.endswith(('/chat/completion', '/chat/edit_message')):
            h = q.get('headers', {})
            row['leim_present'] = 'x-hif-leim' in h
            row['dliq_present'] = 'x-hif-dliq' in h
            row['referer_has_session'] = '/a/chat/s/' in h.get('referer', '')
            generations.append(row)
        for value in re.findall(r'(?:^|;\s*)smidV2=([^;]+)', q.get('headers', {}).get('cookie', '')):
            smids.add(value)
    success = [r for r in generations if r.get('stream_closed') and not r.get('hint')]
    last_success = max(success, key=lambda x: x['end_time']) if success else None
    muted = next((x for x in sorted(timelines, key=lambda x: x['time']) if x.get('is_muted')), None)
    flags = {p: {'count': len(rows), 'without_leim': sum(not x['leim_present'] for x in rows),
                 'without_session_referer': sum(not x['referer_has_session'] for x in rows)}
             for p in ('completion', 'edit_message')
             if (rows := [x for x in generations if x['endpoint'].endswith('/' + p)])}
    return {'source': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'range': [first, last], 'phases': dict(phases), 'malformed_lines': malformed,
            'sessions': sessions, 'unique_login_accounts': len(accounts), 'unique_login_device_ids': len(ids),
            'recorded_smid_values': len(smids),
            'cookie_note': '旧抓取不包含 jar 自动注入的 Cookie；记录中缺失不代表线上未发送',
            'endpoints': [{'direction': k[0], 'method': k[1], 'endpoint': k[2], 'count': v}
                          for k, v in endpoints.most_common()],
            'outcomes': [{'host': k[0], 'status': k[1], 'count': v} for k, v in outcomes.items()],
            'generation_count': len(generations), 'generation_headers': flags,
            'peaks': {str(w): peak_count([x['time'] for x in generations], w) for w in (10, 60, 600, 3600)},
            'timeline': sorted(timelines, key=lambda x: x['time']), 'last_success': last_success,
            'first_observed_mute': muted,
            'gap_seconds': (dt.datetime.fromisoformat(muted['end_time']) - dt.datetime.fromisoformat(last_success['end_time'])).total_seconds()
                           if muted and last_success else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.capture)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: result[k] for k in ('range', 'generation_count', 'generation_headers', 'peaks', 'timeline', 'last_success', 'gap_seconds')}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
