# Quai base image: the supervisor plus every runtime it can host.
# Measured in the prototype at ~495 MB with all four runtimes present.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates unzip procps iproute2 iptables xfsprogs quota openssh-server \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs python3 python3-venv \
  && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/quai
COPY package.json tsconfig.json ./
COPY src/ ./src/

ENV QUAI_HOMES=/srv/quai/homes
ENV QUAI_PORT=8080
EXPOSE 8080

# The supervisor runs as PID 1 so it owns the lifecycle of every project process.
CMD ["bun", "run", "src/supervisor/main.ts"]

