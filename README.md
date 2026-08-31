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
    quai list                 # every project on the instance
    quai open                 # open this project in a browser
    quai rm                   # delete the project and everything it owns

The common case needs no configuration. A folder with an `index.html` deploys as
a static site; a lone `api.js` deploys as a function. Where detection would have
to guess — a `package.json` next to a `requirements.txt` — Quai refuses and asks
for one line rather than deploying the wrong thing.

## Working on a project

    quai dev              # run it locally, exactly the way the server will
    quai dev --port 4000

A function runs under the same host the supervisor uses, so a handler that
answers locally answers once deployed. A static project is served straight from
disk, with no process, as in production.

For typed handlers and a checked manifest:

    npm install --save-dev quai-types

```ts
import { defineHandler } from "quai-types";

export default defineHandler((request, response) => {
  response.end(JSON.stringify({ path: request.url }));
});
```

The helpers return their argument untouched: they exist for the type checker,
so the code that runs on the server is exactly the code you wrote. See
[packages/quai](packages/quai).

Editors that understand JSON Schema can complete and check `quai.toml` from
[schema/quai.schema.json](schema/quai.schema.json); `quai init` writes the
pointer into the file it generates.

The manifest is also validated when you deploy, and every problem is reported
at once rather than one per attempt:

```
quai: quai.toml is not valid:

  name: name must be lowercase letters, digits and hyphens, e.g. "my-site"
  runtime: runtime must be one of: "node", "bun", "python"
  limits.cpu: cpu must be a number of cores, e.g. "0.5" or "2"
  limits.memroy is not a setting Quai knows about
```

An unknown key is named rather than ignored: a typo that silently does nothing
is the hardest kind of mistake to find.

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

Publishing the types package needs an `NPM_TOKEN` on the `production`
environment, and it has to be a granular access token with *bypass 2FA*
enabled — an account with two-factor publishing rejects a classic token. The
job is skipped rather than failed when the token is absent, so the image and
the CLI ship either way.

## Development

    bun run check                         # lint, format, types and unit tests
    bun test                              # 545 unit tests, no container needed
    bun run lint
    bun run format

    docker build -t quai:integration .
    bash test/integration.sh quai:integration

The unit tests verify decisions; the integration suite verifies guarantees. The
isolation Quai promises is enforced by the kernel, so it is proven against a real
container on a real XFS volume — 28 checks covering file, network, memory, PID,
disk and syscall isolation, survival across a container recreation, and what a
deploy key is allowed to do.

Both run in CI on every push, because an isolation regression is invisible to
the unit tests alone.

## Operating an instance

A crashed service is restarted on its own, with a widening delay so a project
that is definitively broken does not burn the machine. After enough failures in
a row it is given up on and reported, and a redeploy brings it back — an
incident and a broken project deserve different treatment.

Logs are written to the state volume as well as kept in memory, so output from
before a restart is still readable. They are bounded, and rotation keeps the
recent end: the lines explaining a crash are the last ones written.

    quai backup            # write the instance state to a file
    quai restore <file>    # bring it back on a fresh instance

A backup carries projects, uids, variables and domains. The uids matter most:
files on the quota volume are owned by number, so a project restored under a
fresh uid could not read its own deploy. Restoring re-creates the records;
redeploy each project to bring its content back.

## Limits worth knowing

Quai is a single host: there is no clustering, no scale-to-zero, and no preview
environment per branch. A static project costs nothing when idle, but a service
holds its process.

The isolation is a real boundary for ordinary code and a reasonable one for
untrusted code, but the kernel is shared. Hosting genuinely hostile code would
call for micro-VMs, which the `Runner` interface is shaped to allow later.

