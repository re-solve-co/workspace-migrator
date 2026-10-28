#!/bin/bash
set -e

echo "========================================================"
echo "🚀 Setting up Workspace Migration Studio in Cloud Shell"
echo "========================================================"

# Install rclone if not installed
if ! command -v rclone &> /dev/null; then
    echo "📦 Installing rclone engine..."
    curl -fsSL https://rclone.org/install.sh | sudo bash
fi

mkdir -p ~/.config/rclone reports

# Start inside tmux so it never terminates when closing the browser
tmux kill-session -t migrator 2>/dev/null || true
echo "🚀 Starting 24/7 background session..."
tmux new-session -d -s migrator "PORT=8080 node server.js"

sleep 1
echo ""
echo "========================================================"
echo "🎉 Workspace Migration Studio is running 24/7 in Cloud Shell!"
echo ""
echo "👉 To open Dashboard:"
echo "   Click the 'Web Preview' icon (top-right of Cloud Shell)"
echo "   and click 'Preview on port 8080'."
echo "========================================================"
