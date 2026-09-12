#!/usr/bin/env python3
"""Engine-layer acceptance for the learnt-skill verification gate (live app, no agent turn).

Fixture: a personal skill whose SKILL.md carries the trust frontmatter the creator writes (that write
is pinned by the creator unit tests). Everything else — reading it back through the registry, the
catalog gate, an explicit allow, provisioning a real runtime, and cleanup — runs the app's own code
through its own channels.

Probe hygiene learned the hard way: a previous cleanup left the id in disabledSkillIds, so a re-run
with the same name started out disabled. Names are unique per run now, and cleanup clears both lists.
"""
import json
import os
import shutil
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

HOME = os.path.expanduser('~')
STORE = os.path.join(HOME, '.purescience-project')
TOKEN = open(os.path.join(STORE, 'web-token'), encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:44100'
AGENT_SKILLS = os.path.join(STORE, 'claude', 'skills')
PERSONAL = os.path.join(STORE, 'skills', 'personal')
NAME = f'gate-probe-csv-{int(time.time()) % 100000}'
failures = []
project_id = None
session_id = None


def rpc(channel, args):
    request = Request(
        f'{BASE}/rpc/{channel}',
        data=json.dumps({'protocolVersion': 1, 'args': args}).encode(),
        headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        return json.loads(urlopen(request, timeout=180).read())
    except HTTPError as error:
        return json.loads(error.read())


def wait_for(predicate, seconds=10, interval=1.0):
    """Settings writes land asynchronously, so a read taken immediately after the call can race it."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


def check(label, condition, detail=''):
    print(f'  [{"PASS" if condition else "FAIL"}] {label}{" — " + detail if detail else ""}')
    if not condition:
        failures.append(label)


def rows():
    return rpc('settings:list-skills', []).get('result') or []


def find():
    return next((entry for entry in rows() if entry.get('id', '').endswith(NAME)), None)


def agent_entries():
    if not os.path.isdir(AGENT_SKILLS):
        return []
    return [entry for entry in os.listdir(AGENT_SKILLS) if NAME in entry]


def settings():
    with open(os.path.join(STORE, 'settings.json'), encoding='utf-8') as handle:
        return json.load(handle)


def provision_runtime():
    """A real runtime sync (what a session start does) — the point where skills reach the agent."""
    global project_id, session_id
    if project_id is None:
        created = rpc('projects:create', [{'name': f'probe-gate-{NAME}'}])
        project_id = (created.get('result') or {}).get('id')
    attached = rpc('acp:create-session', [{'projectName': project_id, 'permissionProfile': 'auto'}])
    session_id = (attached.get('result') or {}).get('sessionId')
    if session_id:
        rpc('acp:resume-session', [{
            'sessionId': session_id,
            'cwd': (attached.get('result') or {}).get('cwd'),
            'projectName': project_id,
            'permissionProfile': 'auto',
        }])
    time.sleep(6)
    return session_id


print(f'== 0. create a personal skill ({NAME}, no trust recorded) ==')
created = rpc('settings:create-skill', [{
    'name': NAME,
    'description': 'CSV loading fails on non-UTF8 files',
    'body': 'Check the encoding before pd.read_csv.',
}])
check('created without error', created.get('ok') is True, json.dumps(created.get('error'))[:160])
baseline = find()
check('visible in the catalog', baseline is not None)
check('ungated while it carries no provenance',
      bool(baseline) and baseline.get('enabled') is True,
      json.dumps(baseline.get('enabled') if baseline else None))
skill_id = baseline.get('id') if baseline else NAME
slug = skill_id.replace('personal-', '', 1)
skill_dir = os.path.join(PERSONAL, slug)
print(f'  skill id = {skill_id}')

print('== 1. stamp the trust frontmatter the creator writes for a learnt draft ==')
skill_md = os.path.join(skill_dir, 'SKILL.md')
with open(skill_md, encoding='utf-8') as handle:
    lines = handle.read().split('\n')
closing = lines.index('---', 1)
lines = lines[:closing] + [
    'trust: "unverified"',
    'trust_kind: "procedure"',
    'trust_evidence: "pd.read_csv on a GBK file -> UnicodeDecodeError"',
] + lines[closing:]
with open(skill_md, 'w', encoding='utf-8') as handle:
    handle.write('\n'.join(lines))
check('frontmatter written', 'trust: "unverified"' in open(skill_md, encoding='utf-8').read())

print('== 2. the catalog reports it as withheld ==')
stamped = find()
check('enabled is false (the gate)', bool(stamped) and stamped.get('enabled') is False,
      json.dumps(stamped.get('enabled') if stamped else None))
check('trust summary is surfaced', bool((stamped or {}).get('trust', {}).get('summary')),
      str((stamped or {}).get('trust', {}).get('summary'))[:130])

print('== 3. a real runtime sync still does not ship it to the agent ==')
check('runtime attached', provision_runtime() is not None)
check('not in the agent skills directory', agent_entries() == [], str(agent_entries()))

print('== 4. enabling it records an explicit allow and materializes it ==')
enabled = rpc('settings:set-skill-enabled', [{'id': skill_id, 'enabled': True}])
check('channel ok', enabled.get('ok') is True, json.dumps(enabled.get('error'))[:160])
after = find()
check('catalog says enabled', bool(after) and after.get('enabled') is True,
      json.dumps(after.get('enabled') if after else None))
check('trustedSkillIds records the allow',
      skill_id in (settings().get('trustedSkillIds') or []),
      json.dumps(settings().get('trustedSkillIds')))
provision_runtime()
check('materialized once allowed', agent_entries() != [], str(agent_entries()))

print('== 5. cleanup restores the baseline ==')
# Race-proof order: an explicit disable always clears the allow, deleting removes the entry, and
# re-enabling (now that the id resolves to nothing) clears the disabled list. A delete-then-clear
# order instead raced the deletion and re-recorded the allow.
rpc('settings:set-skill-enabled', [{'id': skill_id, 'enabled': False}])
rpc('settings:delete-skill', [{'id': skill_id}])
wait_for(lambda: find() is None)
rpc('settings:set-skill-enabled', [{'id': skill_id, 'enabled': True}])
wait_for(lambda: skill_id not in (settings().get('trustedSkillIds') or []))
check('not in disabledSkillIds', skill_id not in (settings().get('disabledSkillIds') or []),
      json.dumps(settings().get('disabledSkillIds')))
check('not in trustedSkillIds', skill_id not in (settings().get('trustedSkillIds') or []),
      json.dumps(settings().get('trustedSkillIds')))
if session_id:
    rpc('sessions:delete-session', [{'projectId': project_id, 'sessionId': session_id}])
if project_id:
    rpc('projects:delete', [{'id': project_id}])
for _ in range(5):
    for entry in agent_entries():
        shutil.rmtree(os.path.join(AGENT_SKILLS, entry), ignore_errors=True)
    if agent_entries() == []:
        break
    time.sleep(2)
shutil.rmtree(skill_dir, ignore_errors=True)
check('skill gone from the catalog', find() is None)
check('no leftover materialized dir', agent_entries() == [], str(agent_entries()))

print()
print('RESULT:', 'ALL PASS' if not failures else f'{len(failures)} FAILED: {failures}')
