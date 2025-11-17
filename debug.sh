#!/bin/bash
# Debug script to inspect claudebot in-memory state
# Usage: ./debug.sh [command] [args]

BASE_URL="${DEBUG_URL:-http://127.0.0.1:3847}"

function usage() {
  echo "Usage: $0 <command> [args]"
  echo ""
  echo "Commands:"
  echo "  stats              - Show overall statistics"
  echo "  channels           - Show info for all configured channels"
  echo "  channel <id>       - Show detailed info for a specific channel"
  echo "  messages <id> [n]  - Show last n messages (default 50)"
  echo "  boundaries <id>    - Show raw block boundaries"
  echo "  tail <id>          - Show tail messages (last 10)"
  echo "  health             - Check if server is running"
  echo "  help               - Show this help"
  echo ""
  echo "Environment:"
  echo "  DEBUG_URL          - Base URL (default: http://127.0.0.1:3847)"
}

function fetch_json() {
  curl -s "$1" | python3 -m json.tool 2>/dev/null || curl -s "$1"
}

case "${1:-help}" in
  stats)
    fetch_json "$BASE_URL/stats"
    ;;
  channels)
    fetch_json "$BASE_URL/channels"
    ;;
  channel)
    if [ -z "$2" ]; then
      echo "Error: channel id required"
      exit 1
    fi
    fetch_json "$BASE_URL/channel?id=$2"
    ;;
  messages)
    if [ -z "$2" ]; then
      echo "Error: channel id required"
      exit 1
    fi
    limit="${3:-50}"
    fetch_json "$BASE_URL/messages?id=$2&limit=$limit"
    ;;
  boundaries)
    if [ -z "$2" ]; then
      echo "Error: channel id required"
      exit 1
    fi
    fetch_json "$BASE_URL/boundaries?id=$2"
    ;;
  tail)
    if [ -z "$2" ]; then
      echo "Error: channel id required"
      exit 1
    fi
    fetch_json "$BASE_URL/channel?id=$2" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(f\"Tail: {data['tailMessageCount']} messages (~{data['tailTokenEstimate']} tokens)\")
print()
for msg in data.get('recentTailMessages', []):
    print(f\"{msg['author']}: {msg['content']}\")
    print()
" 2>/dev/null || fetch_json "$BASE_URL/channel?id=$2"
    ;;
  health)
    fetch_json "$BASE_URL/health"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo "Unknown command: $1"
    usage
    exit 1
    ;;
esac
