#!/usr/bin/env python3
"""R4-U3 ligature/soft-hyphen reading, through the running app's own channel.

Fixture: /tmp/ps-q2/ligature-tounicode.pdf -- a 3x3 table whose cells carry U+FB01 / U+FB00 / U+00AD
steered in by a hand-written ToUnicode CMap (the reader is handed the exact code points the unit is
about; the writer trick that used to hide them is gone).

Reads: candidate shape, per-cell text with explicit code-point dump, and whether the words were split.

Usage: python3 q2-ligature-probe.py <base> <tokenFile>
"""

import hashlib
import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1]
TOKEN = open(sys.argv[2]).read().strip()
PATH = "/tmp/ps-q2/ligature-tounicode.pdf"


def rpc(channel: str, args: list) -> dict:
    body = json.dumps({"protocolVersion": 1, "args": args}).encode()
    request = urllib.request.Request(
        f"{BASE}/rpc/{channel}",
        data=body,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        return {"httpError": error.code, "body": error.read().decode()[:300]}


def codepoints(text: str) -> str:
    return " ".join("U+%04X" % ord(ch) for ch in text)


opened = rpc("pdf:open", [{"projectId": "", "path": PATH}])
doc = (opened.get("result") or {}).get("doc") or {}
doc_id = doc.get("docId")
if not doc_id:
    print(json.dumps({"error": "open failed", "raw": opened}, ensure_ascii=False))
    sys.exit(1)

tables = rpc("pdf:tables", [{"projectId": "", "docId": doc_id}])
result = tables.get("result") or {}
candidates = result.get("candidates") or []
print(
    json.dumps(
        {
            "scannedPages": result.get("scannedPages"),
            "candidateCount": len(candidates),
            "rejectedPages": result.get("rejectedPages"),
            "rotatedPages": result.get("rotatedPages"),
        },
        ensure_ascii=False,
    )
)
for candidate in candidates:
    rows = candidate.get("rows") or []
    flat = "\n".join("|".join(row) for row in rows)
    print(
        json.dumps(
            {
                "page": candidate.get("page"),
                "rows": len(rows),
                "columnCount": candidate.get("columnCount"),
                "confidence": candidate.get("confidence"),
                "columnsPerRow": sorted({len(row) for row in rows}),
                "textHash": hashlib.sha256(flat.encode()).hexdigest()[:16],
            },
            ensure_ascii=False,
        )
    )
    for row in rows:
        for cell in row:
            print("    cell=" + json.dumps(cell, ensure_ascii=False) + "  [" + codepoints(cell) + "]")
