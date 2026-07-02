#!/usr/bin/env bash
# BetterTrack factory — per-issue token & cost report. Run on the HOST.
#
#   ./factory/usage-report.sh [ledger-path]
#
# Reads the JSONL ledger written by run.sh (default: factory/usage/ledger.jsonl,
# the host side of the compose bind-mount) and prints a per-issue breakdown —
# tokens by kind, total cost, and per-role spend WITH retries/failures folded in —
# plus a grand total. Cost is whatever run.sh recorded per run: total_cost_usd from
# the claude CLI when present, else tokens × the fallback pricing table in run.sh.
set -uo pipefail

LEDGER=${1:-"$(cd "$(dirname "$0")" && pwd)/usage/ledger.jsonl"}

command -v jq >/dev/null 2>&1 || { echo "This report needs 'jq' on PATH. Install it (brew install jq)."; exit 1; }

if [ ! -s "$LEDGER" ]; then
  echo "No usage ledger found at: $LEDGER"
  echo "(It is created once the factory has run at least one role with usage data.)"
  exit 0
fi

# Count valid records (tolerating any stray/garbled line).
records=$(jq -R 'fromjson?' "$LEDGER" 2>/dev/null | jq -s 'length' 2>/dev/null || echo 0)
echo "BetterTrack factory — usage & cost report"
echo "Ledger: $LEDGER  ($records records)"
echo

# fromjson? drops any non-JSON line so one bad append can't sink the whole report.
jq -R 'fromjson?' "$LEDGER" 2>/dev/null | jq -rs '
  def usd: (.*100|round) as $c
         | "$" + ($c/100|floor|tostring) + "." + ((($c%100)+100|tostring)[1:]);
  def commafy:
    def c: if . >= 1000
           then ((./1000|floor)|c) + "," + ((.%1000 + 1000|tostring)[1:])
           else tostring end;
    (floor|c);
  def pad($w): tostring | . + (($w - length) as $p | if $p>0 then " "*$p else "" end);
  def row($i;$c;$in;$out;$cr;$cw;$r;$roles):
    ($i|pad(9)) + ($c|pad(10)) + ($in|pad(13)) + ($out|pad(12))
    + ($cr|pad(15)) + ($cw|pad(13)) + ($r|pad(6)) + $roles;

  (group_by(.issue)
   | map({
       issue: .[0].issue,
       cost:  (map(.cost_usd)|add),
       it:    (map(.input_tokens)|add),
       ot:    (map(.output_tokens)|add),
       crt:   (map(.cache_read_tokens)|add),
       cwt:   (map(.cache_creation_tokens)|add),
       runs:  length,
       roles: (group_by(.role)
               | map({role:.[0].role, c:(map(.cost_usd)|add), n:length})
               | sort_by(-.c)
               | map(.role + (if .n>1 then "×\(.n)" else "" end) + " " + (.c|usd))
               | join(", "))
     })
   | sort_by(.issue | (tonumber? // 1e18))) as $rows
  | ( row("Issue";"Cost";"Input";"Output";"Cache-rd";"Cache-wr";"Runs";"Roles (cost incl. retries/fails)"),
      row("─────";"────";"─────";"──────";"────────";"────────";"────";"───────────────────────────────"),
      ( $rows[]
        | row(( if (.issue|test("^[0-9]+$")) then "#"+.issue else .issue end );
              (.cost|usd); (.it|commafy); (.ot|commafy);
              (.crt|commafy); (.cwt|commafy); (.runs|tostring); .roles) ),
      row("─────";"────";"─────";"──────";"────────";"────────";"────";"───────────────────────────────"),
      row("TOTAL";
          (($rows|map(.cost)|add // 0)|usd);
          (($rows|map(.it)|add // 0)|commafy);
          (($rows|map(.ot)|add // 0)|commafy);
          (($rows|map(.crt)|add // 0)|commafy);
          (($rows|map(.cwt)|add // 0)|commafy);
          (($rows|map(.runs)|add // 0)|tostring);
          "") )
'

echo
echo "Rows with a non-numeric issue (e.g. \"-\") are factory overhead not tied to one issue (planner)."
