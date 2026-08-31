# Deploying a Quai instance

Quai is one container. It needs three things from the host that a normal
container does not, and it refuses to start without them rather than offer
isolation it cannot enforce.

## What the host must provide

**An XFS volume with project quotas.** This is the only mechanism that stops
one project from filling the disk every other project depends on. overlayfs
carries no quotas at all, so a plain bind mount will not do.

    mkfs.xfs /dev/<device>
    mount -o prjquota /dev/<device> /srv/quai-homes

**A shared cgroup namespace** (`cgroup: host`) and a writable
`/sys/fs/cgroup`. Without the first, a memory cap is written without any error
and enforces nothing — the process never enters the capped group. `privileged:
true` does *not* substitute for the mount.

**`NET_ADMIN` and `SYS_ADMIN`**, for the per-project network namespaces and
the confinement.

The supervisor checks all of this at startup, including actually attempting the
cgroup delegation, and names what to change when something is missing.

## Deploying it

Paste [deploy/compose.yaml](../deploy/compose.yaml) into Coolify as a Raw
Compose deployment. Point `*.quai.<your-domain>` at the service; Coolify
terminates TLS with a single wildcard certificate for every project.

Then add a deploy key. Every key is pinned to a forced command, so it can
deploy and administer projects and nothing else — no shell is ever granted:

    docker compose exec quai sh -c 'echo "ssh-ed25519 AAAA... you@host" \
      >> /srv/quai/state/authorized_keys'
    docker compose restart quai

## Checking it works

    curl https://quai.<your-domain>/health

A healthy instance reports `"status":"healthy"` with no failing requirement.
`"unhealthy"` names exactly which guarantee is missing.

To verify the guarantees themselves rather than trust them, run the integration
suite against your own host:

    bash test/integration.sh ghcr.io/atinseau/quai:latest

Twenty-eight checks covering file, network, memory, PID, disk and syscall
isolation, survival across a container recreation, and what a deploy key is
allowed to do. It is the same suite that runs in CI.

## Environment

| Variable | Default | What it does |
|---|---|---|
| `QUAI_ZONE` | `quai.localhost` | The wildcard zone projects are served under |
| `QUAI_HOMES` | `/srv/quai/homes` | Project content; must be the XFS volume |
| `QUAI_STATE` | `/srv/quai/state` | Database, logs, SSH keys |
| `QUAI_PORT` | `8080` | Where the router listens |
| `QUAI_DEPLOY_TOKEN` | generated | Guards the administrative endpoints |

The token is generated and kept on the state volume when unset, so a fresh
instance is never left accepting no credential at all.

