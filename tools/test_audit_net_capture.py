import json
import tempfile
import unittest
from pathlib import Path
from audit_net_capture import audit, signals


class NetCaptureAuditTests(unittest.TestCase):
    def test_edit_rate_limit_and_login_mute_are_different(self):
        sse = 'event: hint\ndata: {"type":"error","finish_reason":"edit_rate_limit","content":"PRIVATE_CHAT"}\n\n'
        self.assertEqual(signals(sse), {'hint': 'edit_rate_limit'})
        self.assertEqual(signals('event: update_session\ndata: {"content":"user_is_muted"}\n\n'), {})
        self.assertEqual(signals('{"code":40003,"msg":"PRIVATE_TOKEN","data":null}'), {'code':40003})
        self.assertEqual(signals('{"data":{"biz_data":{"user":{"chat":{"is_muted":1,"mute_until":null}}}}}')['is_muted'], 1)

    def test_restart_ids_are_not_joined_and_secrets_do_not_leave_report(self):
        rows = []
        for day, body in [(27,'event: close\ndata: {}\n\n'), (28,'event: hint\ndata: {"finish_reason":"edit_rate_limit"}\n\n')]:
            ts = f'2026-09-{day}T12:00:00+08:00'
            rows.extend([
                {'phase':'session','ts':ts,'version':'test','id':0},
                {'phase':'request','ts':ts,'id':1,'dir':'out','method':'POST',
                 'url':'https://test/api/v0/chat/edit_message?token=PRIVATE_QUERY',
                 'headers':{'authorization':'PRIVATE_TOKEN','cookie':'smidV2=PRIVATE_SMID'},
                 'body':'PRIVATE_PROMPT'},
                {'phase':'response_body','ts':ts,'id':1,'body':body}])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'test.jsonl'
            path.write_text('\n'.join(json.dumps(x) for x in rows), encoding='utf-8')
            result = audit(path)
        self.assertEqual(result['generation_count'], 2)
        self.assertEqual(result['last_success']['generation'], 0)
        self.assertEqual(result['timeline'][0]['generation'], 1)
        self.assertNotIn('PRIVATE_', json.dumps(result))

    def test_tagged_requests_survive_rotation_without_session_marker(self):
        rows = []
        for tag, hint in [('run-a', False), ('run-b', True)]:
            ts = '2026-09-30T12:00:00+08:00'
            rows.extend([
                {'phase':'request','session_id':tag,'ts':ts,'id':1,'dir':'out',
                 'url':'https://test/api/v0/chat/edit_message','method':'POST'},
                {'phase':'response_body','session_id':tag,'ts':ts,'id':1,
                 'body': 'event: hint\ndata: {"finish_reason":"edit_rate_limit"}\n\n' if hint else 'event: close\ndata: {}\n\n'}])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'rotated.jsonl'
            path.write_text('\n'.join(json.dumps(x) for x in rows), encoding='utf-8')
            result = audit(path)
        self.assertEqual(result['generation_count'], 2)
        self.assertEqual(result['last_success']['generation'], 0)
        self.assertEqual(result['timeline'][0]['generation'], 1)


if __name__ == '__main__':
    unittest.main()
