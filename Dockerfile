FROM node:22-slim

RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg git && \
    pip3 install --break-system-packages yt-dlp yt-dlp-ejs bgutil-ytdlp-pot-provider && \
    rm -rf /var/lib/apt/lists/*

# Clone and build the PO token provider's HTTP server
RUN git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil && \
    cd /opt/bgutil/server && \
    npm ci && \
    npx tsc

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["sh", "start.sh"]