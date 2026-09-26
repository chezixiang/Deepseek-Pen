"""Offline regression tests for trace counting and credential redaction."""

import json
from pathlib import Path
import tempfile
import unittest

from audit_deepseek_captures import Summary, audit_netlog


class CaptureAuditTests(unittest.TestCase):
    def test_only_structural_data_leaves_the_auditor(self):
        summary = Summary()
        summary.add('POST', 'https://chat.deepseek.com/api/v0/users/login?did=secret-did',
                    {'authorization': 'Bearer secret-token', 'cookie': 'smidV2=secret-smid',
                     'x-hif-leim': 'secret-hif'},
                    body={'email': 'private@example.com', 'password': 'secret-password',
                          'device_id': 'secret-device', 'prompt': 'private conversation'},
                    response={'data': {'biz_code': 0, 'biz_data': {
                        'user': {'token': 'response-secret', 'chat': {'is_muted': 1, 'mute_until': 2000}}}}})
        output = json.dumps(summary.report())
        for secret in ['secret-', 'private@example.com', 'private conversation', 'response-secret']:
            self.assertNotIn(secret, output)
        self.assertEqual(summary.report()['api_timeline'][0]['mute']['is_muted'], 1)

    def test_multiple_network_events_do_not_multiply_a_request(self):
        constants = {'type': 'constants', 'constants': {
            'timeTickOffset': '1700000000000', 'logEventTypes': {
                'URL_REQUEST_START_JOB': 1, 'HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS': 2,
                'HTTP_TRANSACTION_READ_RESPONSE_HEADERS': 3}}}
        def event(kind, params):
            return {'type': 'event', 'event': {'source': {'id': 12}, 'time': '1000',
                                              'type': kind, 'params': params}}
        rows = [constants,
                event(1, {'method': 'POST', 'url': 'https://chat.deepseek.com/api/v0/users/login'}),
                event(2, {'headers': ['authorization: secret-token']}),
                event(3, {'headers': ['HTTP/1.1 200']})]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'trace.jsonl'
            path.write_text('\n'.join(map(json.dumps, rows)), encoding='utf-8')
            report = audit_netlog(path)
        self.assertEqual(report['request_count'], 1)
        self.assertEqual(report['event_count'], 3)
        self.assertEqual(report['range_utc'][0], '2023-11-14T22:13:21+00:00')
        self.assertNotIn('secret-token', json.dumps(report))


if __name__ == '__main__':
    unittest.main()
