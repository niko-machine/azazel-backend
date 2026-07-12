#!/bin/sh
# Start the PO token provider server in the background
node /opt/bgutil/server/build/main.js &

# Give it a moment to come up before yt-dlp starts hitting it
sleep 2

# Start the actual Express server in the foreground
node index.js