#!/bin/bash
# 在服务器上把下载目录扫成一份 versions.json，供官网下载页直接读取。
# 这样发版只需要把安装包放进 downloads/<tag>/，页面永远显示最新版本 —— 版本号不再写死在 HTML 里。
set -uo pipefail
ROOT=/var/www/purescience/downloads
OUT="$ROOT/versions.json"

python3 - "$ROOT" "$OUT" <<'PY'
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

root, out = sys.argv[1], sys.argv[2]
VERSION = re.compile(r'^v(\d+)\.(\d+)\.(\d+)$')

PLATFORMS = [
    ('mac-arm64', re.compile(r'-mac-arm64\.dmg$')),
    ('mac-x64', re.compile(r'-mac-x64\.dmg$')),
    ('win-x64', re.compile(r'-win-x64-setup\.exe$')),
    ('linux-appimage', re.compile(r'-linux-x86_64\.AppImage$')),
    ('linux-deb', re.compile(r'_amd64\.deb$')),
]

def version_key(name):
    match = VERSION.match(name)
    return tuple(int(part) for part in match.groups()) if match else None

tags = []
for entry in os.listdir(root):
    path = os.path.join(root, entry)
    key = version_key(entry)
    if key and os.path.isdir(path):
        tags.append((key, entry))

versions = []
for key, tag in sorted(tags, reverse=True):
    files = sorted(os.listdir(os.path.join(root, tag)))
    assets = {}
    for platform, pattern in PLATFORMS:
        match = next((name for name in files if pattern.search(name)), None)
        if match is None:
            continue
        full = os.path.join(root, tag, match)
        assets[platform] = {
            'file': match,
            'bytes': os.path.getsize(full),
            'url': f'/download/{tag}/{match}',
        }
    sums = os.path.join(root, tag, 'SHA256SUMS.txt')
    if os.path.isfile(sums):
        assets['sha256sums'] = {'file': 'SHA256SUMS.txt', 'url': f'/download/{tag}/SHA256SUMS.txt'}
    # 只收至少有 Windows 与 macOS 产品的版本：只下到一半的目录不该出现在页面上
    if not {'mac-arm64', 'win-x64'} <= set(assets):
        continue
    versions.append({'tag': tag, 'releasedAt': datetime.fromtimestamp(
        os.path.getmtime(os.path.join(root, tag)), tz=timezone.utc).isoformat(), 'assets': assets})

payload = {
    'schemaVersion': 1,
    'latest': versions[0]['tag'] if versions else None,
    'generatedAt': datetime.now(tz=timezone.utc).isoformat(),
    'versions': versions,
}
with open(out, 'w', encoding='utf-8') as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
print(f'wrote {out}: latest={payload["latest"]} versions={len(versions)}')
PY

chown nginx:nginx "$OUT" 2>/dev/null || true
chmod 644 "$OUT"
