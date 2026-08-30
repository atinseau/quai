FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates procps sudo iptables iproute2 \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

COPY probe.sh /usr/local/bin/probe.sh
COPY hog.js /opt/hog.js
COPY net/ /opt/net/
RUN chmod +x /usr/local/bin/probe.sh /opt/net/probe-net.sh && chmod 0644 /opt/hog.js

CMD ["/usr/local/bin/probe.sh"]
