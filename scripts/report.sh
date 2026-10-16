#!/usr/bin/env bash
# Schreibt einen Deploy-/Testbericht als Kommentar in das Issue „Deploy-Log" (für die Nachkontrolle ohne Actions-Logs).
# Aufruf: scripts/report.sh "<Titel>" <Datei>
set -euo pipefail
title="$1"; file="$2"
num=$(gh issue list --label deploy-log --state open --json number --jq '.[0].number' 2>/dev/null || true)
if [ -z "$num" ]; then
  gh label create deploy-log --description "Automatische Deploy-Berichte" --color 0e8a16 2>/dev/null || true
  num=$(gh issue create --title "Deploy-Log" --label deploy-log --body "Automatische Berichte der Deploy-Workflows. Keine Geheimnisse." --json number --jq .number 2>/dev/null || gh issue create --title "Deploy-Log" --label deploy-log --body "Automatische Berichte der Deploy-Workflows." | grep -o '[0-9]*$')
fi
{
  echo "### $title"
  echo "Run: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID · $(date -u +%Y-%m-%dT%H:%MZ)"
  echo
  echo '```'
  head -c 60000 "$file"
  echo
  echo '```'
} > /tmp/report.md
gh issue comment "$num" -F /tmp/report.md >/dev/null
echo "Bericht in Issue #$num"
