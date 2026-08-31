# Quai

Push a folder, get a URL. Quai is a single container you deploy in Coolify that
hosts small projects — a static site, an HTTP function, a long-running service —
without creating a project, a repository and a Docker image for each one.

Unlike hosted platforms, a service that calls `app.listen(8080)` runs unchanged:
every project gets its own network stack, so its 8080 is nobody else's.

## Deploying an instance

Quai needs an XFS volume with project quotas, because that is the only way one
project can be stopped from filling the disk every other project depends on:

    mkfs.xfs /dev/<device>
    mount -o prjquota /dev/<device> /srv/quai-homes

Then paste [deploy/compose.yaml](deploy/compose.yaml) into Coolify as a Raw
Compose deployment, point `*.quai.<your-domain>` at the service, and let Coolify
terminate TLS with a single wildcard certificate.

Add your public key so the CLI can reach it:

    docker compose exec quai sh -c 'echo "ssh-ed25519 AAAA... you@host" \
      >> /srv/quai/state/authorized_keys'
    docker compose restart quai

Every key is pinned to a forced command: it can deploy and administer projects,
and nothing else. No shell is ever granted.

The supervisor refuses to start when the host cannot enforce isolation, and says
exactly what to change. That is deliberate — offering isolation it cannot apply
would be worse than failing.

## Installing the CLI

    curl -fsSL https://github.com/atinseau/quai/releases/latest/download/install.sh | sh

Or pin a version:

    curl -fsSL https://github.com/atinseau/quai/releases/download/v0.1.0/install.sh | sh

Both URLs point at a release. There is deliberately no install from a branch:
`main` is whatever was merged last, not something anyone released, and an
install run a year from now should do what it did today.

The binary is standalone, so nothing else has to be installed first, and it is
checked against the published checksums before it lands on your PATH. Set
`QUAI_INSTALL` to choose another directory.

Afterwards the CLI maintains itself:

    quai update          # replace this binary with the newest release
    quai update v0.2.0   # or a specific one
    quai uninstall       # remove the CLI and its login configuration

`quai update` downloads the new build and checks that it runs before anything
is moved, so a failed update leaves a working `quai` behind — which matters
more here than anywhere else, since a broken `quai` cannot repair itself.
`quai uninstall` touches only the binary and its configuration; your projects
and anything already deployed are left alone.

## Using it

    quai login root@your-host quai.your-domain

    cd my-site
    quai                      # deploy the current directory
    quai --prod               # deploy to the production domain
    quai init                 # write a quai.toml when detection is not enough
    quai env add KEY=value    # manage environment variables
    quai env pull             # write them to .env.local
    quai logs -f              # follow recent output
    quai status               # show the limits actually enforced
    quai rm                   # delete the project and everything it owns

The common case needs no configuration. A folder with an `index.html` deploys as
a static site; a lone `api.js` deploys as a function. Where detection would have
to guess — a `package.json` next to a `requirements.txt` — Quai refuses and asks
for one line rather than deploying the wrong thing.

## quai.toml

Optional. Only the parts you need:

```toml
name = "my-api"
type = "service"           # static | function | service
runtime = "node"           # node | python | bun

[build]
command = "npm run build"  # runs on your machine, never on the server
output = "dist"            # only this is uploaded

[service]
internal_port = 8080       # declared, never guessed
start = "node server.js"

[limits]
memory = "256Mi"
cpu = "0.5"
pids = 64
disk = "1Gi"
timeout = "30s"            # functions only

[domains]
custom = ["www.example.com"]

[env]
NODE_ENV = "production"
```

## What isolates a project from its neighbours

| Concern | Mechanism |
|---|---|
| Files | a UNIX account per project, home at 0750 |
| Memory | `memory.max`, swap disabled |
| CPU | `cpu.max` |
| Processes | `pids.max`, which is what stops a fork bomb |
| Disk | XFS project quota |
| Network | a namespace per project, plus egress rules |
| Syscalls | a seccomp filter through nsjail |

Projects reach the public internet but not each other, not the operator's
private network, and not cloud metadata endpoints.

## Releases

Tagging `v*` publishes a multi-architecture image to
`ghcr.io/atinseau/quai` and standalone CLI binaries for Linux and macOS, all
from the same build — so the `quai` on a laptop and the image on the server are
never out of step.

    git tag v0.1.0 && git push origin v0.1.0

## Development

    bun test                              # 435 unit tests, no container needed
    bun run typecheck

    docker build -t quai:integration .
    bash test/integration.sh quai:integration

The unit tests verify decisions; the integration suite verifies guarantees. The
isolation Quai promises is enforced by the kernel, so it is proven against a real
container on a real XFS volume — 28 checks covering file, network, memory, PID,
disk and syscall isolation, survival across a container recreation, and what a
deploy key is allowed to do.

Both run in CI on every push, because an isolation regression is invisible to
the unit tests alone.

## Limits worth knowing

Quai is a single host: there is no clustering, no scale-to-zero, and no preview
environment per branch. A static project costs nothing when idle, but a service
holds its process.

The isolation is a real boundary for ordinary code and a reasonable one for
untrusted code, but the kernel is shared. Hosting genuinely hostile code would
call for micro-VMs, which the `Runner` interface is shaped to allow later.

