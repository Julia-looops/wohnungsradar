#!/usr/bin/env python3
"""Holt die letzten Edge-Function-Logs über die Management API (für Berichte; ohne Geheimnisse)."""
import json, os, sys, urllib.parse, urllib.request

REF = os.environ["PROJECT_REF"]
TOKEN = os.environ["SUPABASE_ACCESS_TOKEN"]
minutes = int(sys.argv[1]) if len(sys.argv) > 1 else 20


def query(sql):
    url = f"https://api.supabase.com/v1/projects/{REF}/analytics/endpoints/logs.all?" + urllib.parse.urlencode({"sql": sql})
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode()[:500]}


print(f"== function_logs (letzte {minutes} Min.)")
res = query(f"select timestamp, event_message, metadata.function_id as fn, metadata.level as level from function_logs "
            f"where timestamp > timestamp_sub(current_timestamp(), interval {minutes} minute) order by timestamp desc limit 60")
rows = res.get("result", res)
if isinstance(rows, list):
    for r in rows[:60]:
        print(r.get("timestamp"), r.get("level"), str(r.get("event_message", ""))[:300].replace("\n", " "))
else:
    print(json.dumps(res)[:800])

print(f"== function_edge_logs (Status, letzte {minutes} Min.)")
res = query(f"select timestamp, event_message, response.status_code as status, request.method as method, request.url as url "
            f"from function_edge_logs cross join unnest(metadata) as m cross join unnest(m.response) as response cross join unnest(m.request) as request "
            f"where timestamp > timestamp_sub(current_timestamp(), interval {minutes} minute) order by timestamp desc limit 40")
rows = res.get("result", res)
if isinstance(rows, list):
    for r in rows[:40]:
        print(r.get("timestamp"), r.get("status"), r.get("method"), str(r.get("url", ""))[:120])
else:
    print(json.dumps(res)[:800])
