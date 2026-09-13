#!/usr/bin/env python3
"""Extract plaintext request bodies (JSON / multipart) from SSL_SOCKET_BYTES_SENT
events in an Edge net-export jsonl, skipping DeepSeek telemetry batches.

Usage: python extract_reqbodies.py new.jsonl > bodies.txt
"""
import base64
import json
import sys


def main():
    path = sys.argv[1]
    with open(path, encoding='utf-8', errors='replace') as fh:
        et = json.loads(fh.readline().rstrip(',\n'))['constants']['logEventTypes']
        want = {et['SSL_SOCKET_BYTES_SENT'], et['SOCKET_BYTES_SENT']}
        inv = {v: k for k, v in et.items()}

        for line in fh:
            line = line.strip().rstrip(',')
            if not line.startswith('{"type":"event"'):
                continue
            try:
                ev = json.loads(line)['event']
            except Exception:
                continue
            if ev.get('type') not in want:
                continue
            b = (ev.get('params') or {}).get('bytes')
            if not b:
                continue
            raw = base64.b64decode(b)
            txt = raw.decode('utf-8', 'replace')
            # skip telemetry uploads (mcs/applog batches)
            if '"events":[{"event"' in txt or '"user_unique_id"' in txt:
                continue
            # find the start of a JSON object / multipart marker
            i = txt.find('{"')
            j = txt.find('----')
            starts = [x for x in (i, j) if x >= 0]
            if not starts:
                continue
            s = min(starts)
            payload = txt[s:]
            if len(payload) < 8:
                continue
            print('===== time=%s src=%s type=%s len=%d' % (
                ev['time'], ev['source']['id'], inv[ev['type']], len(raw)))
            print(payload[:4000])
            print()


main()
