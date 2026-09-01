# Deploying a Quai instance

Quai is one container. It needs three things from the host that a normal
container does not, and it refuses to start without them rather than offer
isolation it cannot enforce.

There are two ways to give it those things. **If the machine already runs
something you care about, use the [nested deployment](#nested-deployment)** —
it asks the host for one container and nothing else.

## Before you start: DNS and a wildcard certificate

Quai serves one subdomain per project, so two things must exist before the
first deploy — neither of them provided by Quai, and both easy to discover at
the wrong moment.

**A wildcard DNS record.** `*.quai.<your-domain>` pointing at the host.

**A wildcard TLS certificate**, `*.quai.<your-domain>`, obtained through a
**DNS challenge**. This is the part that surprises people: a proxy route that
matches a pattern rather than a fixed hostname has no concrete name to request
a certificate for, so it cannot issue one on demand. The usual HTTP challenge
cannot produce a wildcard at all.

Get this wrong and routing works on the first try while HTTPS fails for every
project — a confusing symptom, since plain HTTP looks fine.

Set it up once, on the proxy, and every project deployed afterwards is covered
without touching it again. Note that a wildcard covers exactly one level:
`*.quai.example.com` matches `my-site.quai.example.com` and not
`a.b.quai.example.com`. Quai's router refuses nested subdomains for the same
reason, so the two rules agree.

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

[deploy/compose.yaml](../deploy/compose.yaml) is an ordinary Compose file:

    QUAI_ZONE=quai.example.com docker compose -f deploy/compose.yaml up -d

Point `*.quai.<your-domain>` at the service. Quai serves plain HTTP on one
port and routes by `Host` header, so TLS belongs to whatever already sits in
front — Caddy, Traefik, nginx, or a PaaS that manages certificates for you. A
single wildcard certificate covers every project.

On a PaaS that accepts raw Compose (Coolify, Dokploy, CapRover), paste the same
file and set `QUAI_ZONE` as an environment variable.

## Putting a proxy in front

Quai speaks plain HTTP on one port and decides which project answers from the
`Host` header. Any proxy that forwards that header unchanged will do.

**That last part is the whole contract.** A proxy that rewrites `Host` sends
every project to the same place, and the failure looks like an ordinary 404
with nothing to suggest the proxy is responsible. Traefik and Caddy forward it
by default; nginx does not.

For Traefik, an overlay is provided. Compose merges files given with repeated
`-f` flags, so the base file stays plain Docker:

    QUAI_ZONE=quai.example.com QUAI_PROXY_NETWORK=my-proxy-net \
      docker compose -f deploy/compose.yaml \
                     -f deploy/overlays/traefik.yaml up -d

For a nested instance, use `deploy/nested/compose.yaml` with
`deploy/overlays/traefik-nested.yaml`. Both overlays declare one router that
matches every subdomain of the zone, so a newly deployed project is routed
without touching the proxy — which is verified against a real Traefik in CI.

With **Caddy**, one site block is enough; `Host` is preserved by default:

    *.quai.example.com {
      tls { dns <your-provider> }   # a wildcard needs the DNS challenge
      reverse_proxy quai:8080
    }

With **nginx**, the header must be set explicitly. Without `proxy_set_header
Host`, nginx sends the upstream name instead and no project is ever found:

    server {
      server_name *.quai.example.com;
      location / {
        proxy_pass http://quai:8080;
        proxy_set_header Host $host;   # without this, nothing routes
      }
    }

Only the Traefik overlay ships as a file, because it is the only one verified
against a running instance. The other two are starting points.

Then add a deploy key. Every key is pinned to a forced command, so it can
deploy and administer projects and nothing else — no shell is ever granted:

    docker compose exec quai sh -c 'echo "ssh-ed25519 AAAA... you@host" \
      >> /srv/quai/state/authorized_keys'
    docker compose restart quai

## Nested deployment

Everything above asks a lot of a machine that is not dedicated to Quai: an XFS
volume formatted and mounted on the host, a shared cgroup namespace, and
`SYS_ADMIN`. On a server that already runs your databases, that is a large
grant for a service that is not the reason the server exists.

[deploy/nested/compose.yaml](../deploy/nested/compose.yaml) gives those
privileges to a Docker daemon that runs nothing but Quai. The host provides one
privileged container and nothing else:

| | On the host | Nested |
|---|---|---|
| `mkfs.xfs`, `mount`, `/etc/fstab` | required | none |
| Shared cgroup namespace | required | none |
| `SYS_ADMIN` on the host | required | none |
| iptables rules beside your own | yes | none |
| Removing it completely | unmount, fstab, cgroups | `docker compose down -v` |

**The isolation is identical.** The full integration suite — memory caps, disk
quotas, network separation, seccomp — passes inside a nested host, and CI runs
it both ways on every push.

What it costs: the outer container is `privileged`, which is a broader grant
than `SYS_ADMIN` alone, but it is confined to a container holding only Quai
rather than spread across the machine. Project storage goes through nested
overlayfs, so disk I/O is slower — invisible for static sites and functions,
measurable for something write-heavy.

    QUAI_ZONE=quai.example.com QUAI_HOMES_SIZE=16 docker compose \
      -f deploy/nested/compose.yaml up -d

`QUAI_HOMES_SIZE` is the GiB reserved for project homes, allocated up front,
and every project quota is carved out of it. Add a deploy key the same way,
through the wrapper:

    docker compose exec quai-host docker exec -i quai \
      sh -c 'echo "ssh-ed25519 AAAA... you@host" >> /srv/quai/state/authorized_keys'
    docker compose exec quai-host docker restart quai

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

For a nested instance, `bash test/nested.sh ghcr.io/atinseau/quai:latest` runs
those same twenty-eight checks inside the wrapper, and confirms the host was
left without a mount or a shared cgroup namespace of its own.

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
