# Quai base image: the supervisor plus every runtime it can host.
FROM debian:bookworm-slim

ARG NODE_MAJOR=22
ARG BUN_VERSION=1.4.0

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates unzip procps iproute2 iptables xfsprogs quota openssh-server \
  && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
  && apt-get install -y --no-install-recommends nodejs python3 python3-venv \
  && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/quai
COPY package.json tsconfig.json ./
COPY src/ ./src/

# The deploy key is pinned to this command, so it can never yield a shell.
RUN printf '#!/bin/sh\nexec bun run /opt/quai/src/ingest/forced-command.ts\n' \
      > /usr/local/bin/quai-forced-command \
  && chmod +x /usr/local/bin/quai-forced-command

ENV QUAI_HOMES=/srv/quai/homes
ENV QUAI_STATE=/srv/quai/state
ENV QUAI_PORT=8080
EXPOSE 8080

CMD ["bun", "run", "src/supervisor/main.ts"]

