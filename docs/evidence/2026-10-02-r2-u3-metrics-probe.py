#!/usr/bin/env python3
"""R2-U3 screening view: real-machine reading through the running app's own channels.

Usage: python3 probe9.py <base> <tokenFile> <mode>
  import  import /tmp/psq9/table.csv, print the per-row outcomes
  read    read references:list-journal-metrics and write the library to /tmp/psq9/library.json
"""

import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1]
TOKEN = open(sys.argv[2], encoding="utf-8").read().strip()
MODE = sys.argv[3]


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
        return {"httpError": error.code, "body": error.read().decode()[:400]}


if MODE == "import":
    text = open("/tmp/psq9/table.csv", encoding="utf-8").read()
    response = rpc("references:import-journal-metrics", [{"text": text, "format": "csv"}])
    if "httpError" in response:
        print("HTTP ERROR " + json.dumps(response, ensure_ascii=False))
        sys.exit(1)
    result = response.get("result") or response
    print(json.dumps({k: result.get(k) for k in ("imported", "skipped", "journalsCreated")}, ensure_ascii=False))
    for outcome in result.get("outcomes") or []:
        print("  line=%s %s" % (outcome.get("line"), outcome.get("status") or outcome.get("reason")))
    sys.exit(0)

if MODE == "read":
    response = rpc("references:list-journal-metrics", [])
    if "httpError" in response:
        print("HTTP ERROR " + json.dumps(response, ensure_ascii=False))
        sys.exit(1)
    library = response.get("result") or response
    with open("/tmp/psq9/library.json", "w", encoding="utf-8") as handle:
        json.dump(library, handle, ensure_ascii=False, indent=1)
    claims = library.get("claims") or []
    print(
        json.dumps(
            {
                "journals": len(library.get("journals") or []),
                "claims": len(claims),
                "kindsPresent": sorted({claim.get("kind") for claim in claims}),
                "sampleClaim": claims[0] if claims else None,
            },
            ensure_ascii=False,
        )
    )
    sys.exit(0)

raise SystemExit(f"unknown mode {MODE}")
