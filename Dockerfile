# Quai base image: the supervisor plus every runtime it can host.
# Measured in the prototype at ~495 MB with all runtimes present.
FROM debian:bookworm-slim AS nsjail-build

# nsjail is not packaged for bookworm, so it is built once here and only the
# resulting binary is carried into the final image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      autoconf bison flex gcc g++ git libprotobuf-dev libnl-route-3-dev \
      libtool make pkg-config protobuf-compiler ca-certificates \
  && git clone --depth 1 https://github.com/google/nsjail.git /tmp/nsjail \
  && make -C /tmp/nsjail -j"$(nproc)"

FROM debian:bookworm-slim

ARG NODE_MAJOR=22
ARG BUN_VERSION=1.4.0

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates unzip procps iproute2 iptables xfsprogs quota openssh-server \
      libprotobuf32 libnl-route-3-200 \
  && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
  && apt-get install -y --no-install-recommends nodejs python3 python3-venv \
  && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

COPY --from=nsjail-build /tmp/nsjail/nsjail /usr/local/bin/nsjail

WORKDIR /opt/quai
COPY package.json tsconfig.json ./
COPY src/ ./src/

# The function hosts must be readable by every project account.
RUN chmod -R a+rX /opt/quai/src/hosts

# The deploy key is pinned to this command, so it can never yield a shell.
# The deploy key is pinned to this command, so it can never yield a shell.
COPY deploy/forced-command.sh /usr/local/bin/quai-forced-command
RUN chmod +x /usr/local/bin/quai-forced-command

ENV QUAI_HOMES=/srv/quai/homes
ENV QUAI_STATE=/srv/quai/state
ENV QUAI_PORT=8080
EXPOSE 8080

CMD ["bun", "run", "src/supervisor/main.ts"]

