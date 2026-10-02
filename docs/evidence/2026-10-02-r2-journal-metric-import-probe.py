#!/usr/bin/env python3
"""R2 journal-metric import: real-machine reading through the running app's own channel.

Usage: python3 probe.py <base> <tokenFile> <mode>

Modes:
  main    import /tmp/psq8/table.csv (positives + one row per named skip reason)
  rerun   import the same table again (must be idempotent: every valid row now a duplicate)
  append  same journal+kind+year+source, a DIFFERENT value, as structured rows (append-only: new row)
  zh      import /tmp/psq8/table-zh.csv (Chinese headers, name-only journal)
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


def request_for(mode: str) -> dict:
    if mode == "main" or mode == "rerun":
        text = open("/tmp/psq8/table.csv", encoding="utf-8").read()
        return {"text": text, "format": "csv"}
    if mode == "append":
        return {
            "rows": [
                {
                    "issn": "0028-0836",
                    "journalName": "Nature",
                    "kind": "impact-factor",
                    "value": "99.9",
                    "year": 2023,
                    "source": "Journal Citation Reports",
                    "note": "the revised number, appended rather than overwriting",
                }
            ]
        }
    if mode == "zh":
        text = open("/tmp/psq8/table-zh.csv", encoding="utf-8").read()
        return {"text": text, "format": "csv"}
    if mode == "badissn":
        # 1234-567 is not a well-formed ISSN (7 characters, not 8) — the shape check must refuse it rather
        # than repair it. (1234-567X, used earlier, IS shape-valid: the code checks shape, not the check digit.)
        return {
            "rows": [
                {
                    "issn": "1234-567",
                    "journalName": "Nowhere Journal",
                    "kind": "impact-factor",
                    "value": "1.0",
                    "year": 2023,
                    "source": "Test Source",
                }
            ]
        }
    if mode == "ambiguous":
        # Run only after a second journal carrying normalizedName 'nature' exists in the database (inserted
        # directly), which is the one state where a name-only row must refuse to pick a journal.
        return {
            "rows": [
                {
                    "journalName": "Nature",
                    "kind": "acceptance-rate",
                    "value": "8%",
                    "year": 2024,
                    "source": "Test Source",
                }
            ]
        }
    if mode == "nokind":
        # A blank kind cell in a table that HAS a kind column: a named row reason, not a request failure.
        return {
            "rows": [
                {
                    "issn": "0028-0836",
                    "journalName": "Nature",
                    "kind": "",
                    "value": "5.0",
                    "year": 2023,
                    "source": "Test Source",
                }
            ]
        }
    if mode == "badheader":
        # No year and no source column: nothing in this table could be imported, so the request must fail
        # naming what it looked for rather than reporting an import that stored nothing.
        return {"text": "ISSN,Journal,Value\n0028-0836,Nature,64.8\n", "format": "csv"}
    raise SystemExit(f"unknown mode {mode}")


response = rpc("references:import-journal-metrics", [request_for(MODE)])
if "httpError" in response:
    print("HTTP ERROR " + json.dumps(response, ensure_ascii=False))
    sys.exit(1)

result = response.get("result") or response
outcomes = result.get("outcomes") or []
print(
    json.dumps(
        {
            "mode": MODE,
            "imported": result.get("imported"),
            "skipped": result.get("skipped"),
            "journalsCreated": result.get("journalsCreated"),
            "outcomeCount": len(outcomes),
            "reasons": [
                o.get("status") if o.get("status") == "imported" else o.get("reason") for o in outcomes
            ],
        },
        ensure_ascii=False,
    )
)
for outcome in outcomes:
    if outcome.get("status") == "imported":
        print(
            "  line={line} IMPORTED kind={kind} value={value} year={year} journal={journalId} "
            "match={journalMatch} created={journalCreated}".format(
                line=outcome.get("line", outcome.get("index")), **{k: v for k, v in outcome.items() if k != "line"}
            )
        )
    else:
        print(
            "  line={line} SKIPPED  reason={reason} detail={detail}".format(
                line=outcome.get("line"), reason=outcome.get("reason"), detail=outcome.get("detail")
            )
        )
