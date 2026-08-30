# Sizing probe for the Quai base image: static + Node + Python + Bun.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates unzip procps iproute2 iptables xfsprogs quota \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs python3 python3-venv \
  && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
  && rm -rf /var/lib/apt/lists/*

CMD ["bash", "-lc", "node -v; python3 -V; bun -v; echo ---; \
  du -sh /usr/lib/node_modules /usr/bin/node /usr/local/bin/bun /usr/bin/python3.11 2>/dev/null"]
