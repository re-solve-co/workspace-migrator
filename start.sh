#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

PORT=3050

# Check if server is already running
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "⚡ Workspace Migration Studio is already running on port $PORT."
else
    echo "🚀 Starting Workspace Migration Studio..."
    nohup node "$DIR/server.js" > "$DIR/server.log" 2>&1 &
    sleep 1.5
fi

echo "🌐 Opening Migration Dashboard in browser..."
open "http://localhost:$PORT"

if [[ "$1" == "--tunnel" || "$1" == "--cloudflare" ]]; then
    echo "🔒 Launching secure Cloudflare Tunnel..."
    cloudflared tunnel --url "http://localhost:$PORT"
fi
