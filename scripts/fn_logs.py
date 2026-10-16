#!/usr/bin/env python3
"""Holt die letzten Edge-Function-Logs über die Management API (für Berichte; ohne Geheimnisse)."""
import datetime as dt, json, os, sys, urllib.parse, urllib.request

REF = os.environ["PROJECT_REF"]
TOKEN = os.environ["SUPABASE_ACCESS_TOKEN"]
minutes = int(sys.argv[1]) if len(sys.argv) > 1 else 20
start = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")


def query(sql):
    url = f"https://api.supabase.com/v1/projects/{REF}/analytics/endpoints/logs?" + urllib.parse.urlencode({"sql": sql, "iso_timestamp_start": start})
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode()[:500]}


def show(title, sql, cols):
    print(f"== {title} (letzte {minutes} Min.)")
    res = query(sql)
    rows = res.get("result") if isinstance(res, dict) else res
    if isinstance(rows, list):
        for r in rows[:60]:
            print(" | ".join(str(r.get(c, ""))[:220].replace("\n", " ") for c in cols))
        if not rows:
            print("(keine Einträge)")
    else:
        print(json.dumps(res)[:800])


show("Edge-Function-Logs",
     "select timestamp, source, event_message from logs where source in ('function_logs','function_edge_logs') order by timestamp desc limit 80",
     ["timestamp", "source", "event_message"])
