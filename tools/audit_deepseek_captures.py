#!/usr/bin/env python3
"""Offline, credential-free summary of DeepSeek HAR and Chrome netlog captures.

No network calls or replay. Never emits tokens, cookie values, device IDs,
account identifiers, prompts, response text, or URL query values.
"""

import argparse
import base64
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


def endpoint(url):
    parts = urlsplit(url)
    # Only fixed API paths are reported; other paths may contain identifiers.
    path = parts.path if parts.path.startswith('/api/v0/') else '/[resource]'
    if parts.path in ('/', '/query', '/deviceprofile/v4', '/list', '/webid', '/profile/list'):
        path = parts.path
    return parts.hostname or '', path


def headers(items):
    if isinstance(items, dict):
        return {k.lower(): str(v) for k, v in items.items()}
    result = {}
    for item in items or []:
        if isinstance(item, dict):
            result[item['name'].lower()] = item.get('value', '')
        elif isinstance(item, str) and ': ' in item:
            key, value = item.split(': ', 1)
            result[key.lower()] = value
    return result


def as_json(text):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def utc_millis(value):
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat()


class Summary:
    def __init__(self):
        self.counts = Counter()
        self.times = []
        self.api = []
        self.unique = defaultdict(set)

    def add(self, method, url, hdrs, when=None, status=None, body=None, response=None):
        host, path = endpoint(url)
        self.counts[(method, host, path, str(status))] += 1
        if when is not None:
            self.times.append(when)
        if host != 'chat.deepseek.com' or not path.startswith('/api/v0/'):
            return
        cookies = {}
        for part in hdrs.get('cookie', '').split(';'):
            if '=' in part:
                k, v = part.strip().split('=', 1)
                cookies[k] = v
        for k in ('authorization', 'x-hif-leim', 'x-hif-dliq'):
            if hdrs.get(k):
                self.unique[k].add(hdrs[k])
        if cookies.get('smidV2'):
            self.unique['smidV2'].add(cookies['smidV2'])
        row = {'time_utc': when, 'method': method, 'path': path, 'status': status,
               'header_names': sorted(hdrs),
               'cookie_names': sorted('.thumbcache_[suffix]' if k.startswith('.thumbcache_') else k
                                      for k in cookies)}
        row['client'] = {k: hdrs[k] for k in (
            'user-agent', 'sec-ch-ua-platform', 'sec-ch-ua', 'x-client-version',
            'x-client-platform', 'x-client-timezone-offset') if k in hdrs}
        if isinstance(body, dict):
            row['body_keys'] = sorted(body)
            if body.get('device_id'):
                self.unique['login_device_id'].add(str(body['device_id']))
            if 'chat_session_id' in body:
                self.unique['chat_session_id'].add(str(body['chat_session_id']))
                row['has_parent_message'] = body.get('parent_message_id') is not None
            if 'prompt' in body:
                row['prompt_chars'] = len(str(body['prompt']))
            for k in ('thinking_enabled', 'search_enabled', 'preempt', 'is_regenerate'):
                if isinstance(body.get(k), bool):
                    row[k] = body[k]
        if isinstance(response, dict):
            data = response.get('data')
            if isinstance(data, dict):
                row['biz_code'] = data.get('biz_code')
                biz = data.get('biz_data')
                if isinstance(biz, dict):
                    chat = biz.get('chat', biz.get('user', {}).get('chat', {})
                               if isinstance(biz.get('user'), dict) else {})
                    if 'is_muted' in biz:
                        chat = biz
                    if isinstance(chat, dict) and 'is_muted' in chat:
                        row['mute'] = {k: chat.get(k) for k in ('is_muted', 'mute_until')}
        for key, values in parse_qs(urlsplit(url).query).items():
            if key == 'did':
                self.unique['settings_did'].update(values)
        self.api.append(row)

    def report(self):
        return {
            'range_utc': [min(self.times), max(self.times)] if self.times else [],
            'request_count': sum(self.counts.values()),
            'endpoints': [dict(method=k[0], host=k[1], path=k[2], status=k[3], count=v)
                          for k, v in sorted(self.counts.items())],
            'unique_value_counts_only': {k: len(v) for k, v in sorted(self.unique.items())},
            'api_timeline': self.api,
        }


def audit_har(path):
    summary = Summary()
    doc = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    for entry in doc['log']['entries']:
        request = entry['request']
        response = entry['response']
        content = response.get('content', {})
        text = content.get('text', '')
        if content.get('encoding') == 'base64':
            try:
                text = base64.b64decode(text).decode('utf-8')
            except (ValueError, UnicodeError):
                text = ''
        summary.add(request['method'], request['url'], headers(request.get('headers')),
                    entry.get('startedDateTime'), response.get('status'),
                    as_json(request.get('postData', {}).get('text')), as_json(text))
    return summary.report()


def audit_netlog(path):
    summary = Summary()
    requests = {}
    names = {}
    offset = None
    event_count = 0
    byte_events = Counter()
    with Path(path).open(encoding='utf-8-sig') as stream:
        for line in stream:
            obj = json.loads(line.rstrip(',\n'))
            if obj.get('type') == 'constants':
                const = obj['constants']
                names = {v: k for k, v in const['logEventTypes'].items()}
                offset = float(const['timeTickOffset'])
                continue
            ev = obj.get('event')
            if not isinstance(ev, dict):
                continue
            event_count += 1
            name = names.get(ev.get('type'))
            params = ev.get('params') or {}
            source = ev['source']['id']
            if name == 'URL_REQUEST_START_JOB':
                if params.get('url'):
                    old = requests.pop(source, None)
                    if old:
                        summary.add(**old)
                    requests[source] = dict(method=params.get('method', '?'), url=params['url'],
                        hdrs={}, when=utc_millis(float(ev['time']) + offset))
            elif source in requests:
                if name in ('HTTP_TRANSACTION_SEND_REQUEST_HEADERS',
                            'HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS',
                            'HTTP_TRANSACTION_QUIC_SEND_REQUEST_HEADERS'):
                    requests[source]['hdrs'].update(headers(params.get('headers')))
                elif name == 'HTTP_TRANSACTION_READ_RESPONSE_HEADERS':
                    for item in params.get('headers', []):
                        if isinstance(item, str) and item.startswith(('HTTP/', ':status:')):
                            requests[source]['status'] = item
                elif name in ('URL_REQUEST_JOB_FILTERED_BYTES_READ',
                              'URL_REQUEST_JOB_BYTES_READ', 'HTTP_TRANSACTION_SEND_REQUEST_BODY'):
                    if params.get('bytes'):
                        byte_events[name] += 1
    for request in requests.values():
        summary.add(**request)
    report = summary.report()
    report['event_count'] = event_count
    report['byte_events_with_payload'] = dict(byte_events)
    report['api_timeline'].sort(key=lambda r: r['time_utc'])
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--har', type=Path)
    parser.add_argument('--netlog', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not args.har and not args.netlog:
        parser.error('provide --har and/or --netlog')
    result = {}
    if args.har:
        result['har'] = audit_har(args.har)
    if args.netlog:
        result['netlog'] = audit_netlog(args.netlog)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    for name, report in result.items():
        print(name, json.dumps({k: report[k] for k in ('range_utc', 'request_count',
              'unique_value_counts_only')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
