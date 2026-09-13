#!/usr/bin/env python3
"""Reconstruct DeepSeek HTTP exchanges from an Edge net-export jsonl log.

Usage: python extract_netlog.py new.jsonl outdir [--filter substr]
Writes outdir/index.txt (chronological summary) and outdir/<n>-<slug>.txt per exchange.
"""
import base64
import json
import os
import re
import sys


def main():
    path = sys.argv[1]
    outdir = sys.argv[2]
    filt = 'deepseek.com'
    if '--filter' in sys.argv:
        filt = sys.argv[sys.argv.index('--filter') + 1]
    os.makedirs(outdir, exist_ok=True)

    with open(path, encoding='utf-8', errors='replace') as fh:
        first = fh.readline()
        consts = json.loads(first.rstrip(',\n'))['constants']
        et = consts['logEventTypes']
        T = {name: et[name] for name in (
            'URL_REQUEST_START_JOB', 'HTTP_TRANSACTION_SEND_REQUEST_HEADERS',
            'HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS',
            'HTTP_TRANSACTION_SEND_REQUEST_BODY',
            'HTTP_TRANSACTION_READ_RESPONSE_HEADERS',
            'URL_REQUEST_JOB_FILTERED_BYTES_READ',
            'URL_REQUEST_JOB_BYTES_READ') if name in et}
        want = set(T.values())
        start_job = T['URL_REQUEST_START_JOB']
        sendh = T.get('HTTP_TRANSACTION_SEND_REQUEST_HEADERS')
        sendh2 = T.get('HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS')
        sendbody = T.get('HTTP_TRANSACTION_SEND_REQUEST_BODY')
        readh = T.get('HTTP_TRANSACTION_READ_RESPONSE_HEADERS')
        fbytes = T.get('URL_REQUEST_JOB_FILTERED_BYTES_READ')

        reqs = {}   # source id -> dict
        order = []

        for line in fh:
            line = line.strip().rstrip(',')
            if not line.startswith('{"type":"event"'):
                continue
            if '"type":' not in line:
                continue
            try:
                ev = json.loads(line)['event']
            except Exception:
                continue
            ty = ev.get('type')
            if ty not in want:
                continue
            sid = ev['source']['id']
            p = ev.get('params') or {}

            if ty == start_job:
                url = p.get('url', '')
                if filt not in url:
                    continue
                reqs[sid] = {'url': url, 'time': ev.get('time'), 'sid': sid,
                             'req_headers': None, 'method': p.get('method'),
                             'body': None, 'status': None, 'resp_headers': None,
                             'chunks': []}
                order.append(sid)
                continue

            r = reqs.get(sid)
            if r is None:
                continue

            if ty in (sendh, sendh2):
                hdrs = p.get('headers')
                if isinstance(hdrs, dict):
                    hdrs = ['%s: %s' % (k, v) for k, v in hdrs.items()]
                r['req_headers'] = hdrs or []
                if p.get('line'):
                    r['req_line'] = p['line'].strip()
            elif ty == sendbody:
                # body bytes may be present as 'bytes' (base64) when capture mode allows
                b = p.get('bytes')
                if b:
                    try:
                        r['body'] = base64.b64decode(b)
                    except Exception:
                        pass
                r['body_len'] = p.get('length')
                r['body_elided'] = p.get('did_merge')
            elif ty == readh:
                hdrs = p.get('headers') or []
                if isinstance(hdrs, dict):
                    hdrs = ['%s: %s' % (k, v) for k, v in hdrs.items()]
                r['resp_headers'] = hdrs
                for h in hdrs:
                    if h.startswith('HTTP/') or h.startswith(':status'):
                        r['status'] = h
                        break
            elif ty == fbytes:
                b = p.get('bytes')
                if b:
                    try:
                        r['chunks'].append(base64.b64decode(b))
                    except Exception:
                        pass

    index = []
    n = 0
    for sid in order:
        r = reqs[sid]
        n += 1
        body = b''.join(r['chunks'])
        url = r['url']
        slug = re.sub(r'[^a-zA-Z0-9]+', '_', url.split('deepseek.com', 1)[-1])[:60].strip('_')
        fname = '%04d-%s.txt' % (n, slug or 'root')
        with open(os.path.join(outdir, fname), 'w', encoding='utf-8', errors='replace') as out:
            out.write('URL: %s\n' % url)
            out.write('TIME: %s  SOURCE: %s\n' % (r['time'], sid))
            if r.get('req_line'):
                out.write('REQUEST LINE: %s\n' % r['req_line'])
            out.write('\n--- REQUEST HEADERS ---\n')
            for h in (r['req_headers'] or []):
                out.write(h + '\n')
            out.write('\n--- REQUEST BODY (len=%s) ---\n' % r.get('body_len'))
            if r['body']:
                out.write(r['body'].decode('utf-8', 'replace'))
            out.write('\n\n--- RESPONSE HEADERS ---\n')
            for h in (r['resp_headers'] or []):
                out.write(h + '\n')
            out.write('\n--- RESPONSE BODY (len=%d) ---\n' % len(body))
            out.write(body.decode('utf-8', 'replace'))
        index.append('%s  %s  %s  respbytes=%d  file=%s' % (
            r['time'], (r['status'] or '?')[:24], url[:110], len(body), fname))

    with open(os.path.join(outdir, 'index.txt'), 'w', encoding='utf-8') as out:
        out.write('\n'.join(index) + '\n')
    print('exchanges: %d' % n)
    print('\n'.join(index[:400]))


main()
