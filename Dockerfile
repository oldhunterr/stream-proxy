FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium chromium-sandbox \
    proxychains4 wireguard-tools iproute2 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_PATH=/app/node_modules

WORKDIR /app

# Copy dependency manifests and install during build
COPY package.json package-lock.json ./
RUN npm install

# Copy the rest of the app code
COPY . .

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN echo "strict_chain" > /etc/proxychains4.conf && \
    echo "proxy_dns" >> /etc/proxychains4.conf && \
    echo "tcp_read_time_out 15000" >> /etc/proxychains4.conf && \
    echo "tcp_connect_time_out 8000" >> /etc/proxychains4.conf && \
    echo "[ProxyList]" >> /etc/proxychains4.conf && \
    echo "# PROXY_URL placeholder" >> /etc/proxychains4.conf

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
