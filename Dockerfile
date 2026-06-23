FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates \
    chromium chromium-sandbox \
    proxychains4 wireguard-tools \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_PATH=/app/node_modules

WORKDIR /app

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Default proxychains config — overridden at runtime via PROXY_URL
RUN echo "strict_chain" > /etc/proxychains4.conf && \
    echo "proxy_dns" >> /etc/proxychains4.conf && \
    echo "tcp_read_time_out 15000" >> /etc/proxychains4.conf && \
    echo "tcp_connect_time_out 8000" >> /etc/proxychains4.conf && \
    echo "[ProxyList]" >> /etc/proxychains4.conf && \
    echo "# PROXY_URL placeholder — replaced at runtime by entrypoint" >> /etc/proxychains4.conf

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
