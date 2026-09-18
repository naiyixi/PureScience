#!/usr/bin/env python3
"""Times one RPC channel over the app's own web service and records what came back."""
import json
import sys
import time
import urllib.request

TOKEN = open('/tmp/ps-bench-cold/web-token').read().strip()
BASE = 'http://127.0.0.1:44100/rpc/'


def call(channel, args=None, timeout=180):
    body = json.dumps({'protocolVersion': 1, 'args': args or []}).encode()
    request = urllib.request.Request(
        BASE + channel,
        data=body,
        headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'},
        method='POST',
    )
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
            ms = (time.time() - started) * 1000
            return {'ok': True, 'ms': round(ms, 1), 'bytes': len(payload), 'body': payload}
    except Exception as error:  # noqa: BLE001 - the harness reports whatever happened
        ms = (time.time() - started) * 1000
        detail = ''
        if hasattr(error, 'read'):
            detail = error.read()[:400].decode('utf-8', 'replace')
        return {'ok': False, 'ms': round(ms, 1), 'bytes': 0, 'error': f'{error} {detail}'}


def p95(values):
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(round(0.95 * (len(ordered) - 1)))))
    return ordered[index]


def summarize(label, samples):
    ok = [s for s in samples if s['ok']]
    result = {
        'label': label,
        'calls': len(samples),
        'ok': len(ok),
        'ms': [s['ms'] for s in samples],
        'bytes': [s['bytes'] for s in samples],
        'p95_ms': p95([s['ms'] for s in ok]),
        'max_ms': max([s['ms'] for s in ok]) if ok else None,
        'median_ms': sorted([s['ms'] for s in ok])[len(ok) // 2] if ok else None,
        'errors': [s.get('error') for s in samples if not s['ok']],
    }
    if ok and ok[0]['bytes'] and samples[0]['ok']:
        try:
            parsed = json.loads(samples[0]['body'])
            result['first_shape'] = describe(parsed)
        except Exception:  # noqa: BLE001
            pass
    print(json.dumps(result, ensure_ascii=False))
    return result


def describe(payload):
    """What the response actually carries — counts, not a guess from the type."""
    result = payload.get('result', payload)
    sessions = result.get('sessions') if isinstance(result, dict) else None
    if not isinstance(sessions, list):
        return {'kind': type(result).__name__}
    sample = sessions[0] if sessions and isinstance(sessions[0], dict) else {}
    return {
        'sessions': len(sessions),
        'fields': sorted(sample.keys()),
        'has_messages': 'messages' in sample,
        'messageCount_sample': sample.get('messageCount'),
        'lastAgentMessage_sample': (sample.get('lastAgentMessage') or '')[:60],
        'manifest': result.get('manifest'),
    }


if __name__ == '__main__':
    mode = sys.argv[1]
    out = []
    if mode == 'cold':
        out.append(summarize('list-catalog: cold-start first call', [call('sessions:list-catalog')]))
    elif mode == 'steady':
        samples = [call('sessions:list-catalog') for _ in range(20)]
        out.append(summarize('list-catalog: 20 steady-state calls', samples))
    elif mode == 'doc':
        out.append(summarize('read-document: one session', [call('sessions:read-document', [{'projectId': sys.argv[2], 'sessionId': sys.argv[3]}])]))
    elif mode == 'legacy':
        out.append(summarize('load-all: the full reconcile read (baseline)', [call('sessions:load-all')]))
    with open(f'/tmp/ps-bench-{mode}.json', 'w') as handle:
        json.dump(out, handle, ensure_ascii=False, indent=1)
