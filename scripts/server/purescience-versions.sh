#!/bin/bash
# 在服务器上把下载目录扫成一份 versions.json，供官网下载页直接读取。
# 这样发版只需要把安装包放进 downloads/<tag>/，页面永远显示最新版本 —— 版本号不再写死在 HTML 里。
#
# 完整性判据（2026-11-21 加）：目录里出现的版本必须**每一个 SHA256SUMS.txt 列出的文件都在**、
# 没有 *.part 残档、且（若镜像时写过 .sizes.json）尺寸与 GitHub 声明一致，才算「可下载」。
# 起因：v2.32.0 的 .deb 还在同步时，页面就把 v2.32.0 设成 latest，那个 deb 链接点了是 404。
set -uo pipefail
ROOT=/var/www/purescience/downloads
OUT="$ROOT/versions.json"

python3 - "$ROOT" "$OUT" <<'PY'
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


def released_at(tag):
    path = os.path.join(root, tag)
    stamps = [os.path.getmtime(os.path.join(path, name)) for name in os.listdir(path)]
    return datetime.fromtimestamp(max(stamps or [os.path.getmtime(path)]), tz=timezone.utc)


def inspection(tag):
    """返回 (assets, missing)。missing 非空即「还不能挂在页面上」。"""
    directory = os.path.join(root, tag)
    files = sorted(os.listdir(directory))
    assets = {}
    for platform, pattern in PLATFORMS:
        match = next((name for name in files if pattern.search(name)), None)
        if match is None:
            continue
        assets[platform] = {
            'file': match,
            'bytes': os.path.getsize(os.path.join(directory, match)),
            'url': f'/download/{tag}/{match}',
        }
    sums = os.path.join(directory, 'SHA256SUMS.txt')
    if os.path.isfile(sums):
        assets['sha256sums'] = {'file': 'SHA256SUMS.txt', 'url': f'/download/{tag}/SHA256SUMS.txt'}

    missing = []
    # 1) 还有残档在写 -> 一定没完
    missing.extend(name for name in files if name.endswith('.part'))
    # 2) 发布页列出的每个文件都得在（这是唯一能自动知道「这一版总共该有哪些文件」的来源）
    if os.path.isfile(sums):
        with open(sums, encoding='utf-8') as handle:
            for line in handle:
                parts = line.split()
                if len(parts) < 2:
                    continue
                name = parts[1].lstrip('*')
                if not os.path.isfile(os.path.join(directory, name)):
                    missing.append(name)
    else:
        missing.append('SHA256SUMS.txt')
    # 3) 镜像时记下的 GitHub 声明尺寸，用来抓「文件在但被截断」
    sizes_path = os.path.join(directory, '.sizes.json')
    if os.path.isfile(sizes_path):
        try:
            with open(sizes_path, encoding='utf-8') as handle:
                declared = json.load(handle)
        except (OSError, ValueError):
            declared = {}
        for name, size in declared.items():
            full = os.path.join(directory, name)
            if os.path.isfile(full) and os.path.getsize(full) != size:
                missing.append(f'{name} (size {os.path.getsize(full)} != {size})')
    return assets, missing


tags = []
for entry in os.listdir(root):
    path = os.path.join(root, entry)
    key = version_key(entry)
    if key and os.path.isdir(path):
        tags.append((key, entry))

versions = []
pending = []
for key, tag in sorted(tags, reverse=True):
    assets, missing = inspection(tag)
    if missing:
        pending.append({'tag': tag, 'missing': missing})
        continue
    versions.append({
        'tag': tag,
        'releasedAt': released_at(tag).isoformat(),
        'assets': assets,
    })

payload = {
    'schemaVersion': 2,
    'latest': versions[0]['tag'] if versions else None,
    'generatedAt': datetime.now(tz=timezone.utc).isoformat(),
    'versions': versions,
    # 同步中/不完整的版本单独列出来：页面上不出现，但排障时一眼能看到卡在哪。
    'pending': pending,
}
with open(out, 'w', encoding='utf-8') as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
print(f'wrote {out}: latest={payload["latest"]} versions={len(versions)} pending={len(pending)}')
PY

chown nginx:nginx "$OUT" 2>/dev/null || true
chmod 644 "$OUT"
