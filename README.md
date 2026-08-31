# Quai

Push a folder, get a URL.

Quai is a single container you deploy in Coolify that hosts small projects — a
static site, an HTTP function, a long-running service — without creating a
project, a repository and a Docker image for each one.

Unlike hosted platforms, a service that calls `app.listen(8080)` runs
unchanged: every project gets its own network stack, so its 8080 is nobody
else's.

```
cd my-site
quai
→ https://my-site.quai.example.com
```

## Install

    curl -fsSL https://github.com/atinseau/quai/releases/latest/download/install.sh | sh
    quai login root@your-host quai.your-domain

The binary is standalone and checked against the published checksums before it
lands on your PATH. Pin a version with
`.../releases/download/v0.1.1/install.sh`; there is deliberately no install
from a branch.

Afterwards the CLI maintains itself with `quai update` and `quai uninstall`.

## Deploy something

A directory with an `index.html` is a static site. A lone `api.js` is a
function. A `package.json` is a service. None of these need configuration:

    quai              # deploy the current directory
    quai dev          # run it locally, the way the server will
    quai logs -f      # watch it
    quai rm           # delete it and everything it owns

Where detection would have to guess — a `package.json` next to a
`requirements.txt` — Quai refuses and asks for one line rather than deploying
the wrong thing.

## Documentation

- **[Writing a function](docs/functions.md)** — the handler shapes each runtime
  accepts, timeouts, failures, and when a service is the better fit
- **[Deploying an instance](docs/deploying.md)** — what the host must provide,
  the Compose file, and how to check it works
- **[Operating an instance](docs/operating.md)** — crashes, logs, backups,
  limits

## quai.toml

Optional, and only the parts you need. Editors that understand JSON Schema can
complete and check it from [schema/quai.schema.json](schema/quai.schema.json);
`quai init` writes the pointer into the file it generates.

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

The manifest is validated on deploy and every problem is reported at once, with
the offending key named — a typo that silently does nothing is the hardest kind
of mistake to find.

## Commands

| | |
|---|---|
| `quai` | deploy the current directory |
| `quai --prod` | deploy to the production domain |
| `quai dev [--port N]` | run locally, as the server would |
| `quai init` | write a quai.toml |
| `quai list` | every project on the instance |
| `quai status` | the limits actually enforced |
| `quai logs [-f]` | recent output |
| `quai open` | open this project in a browser |
| `quai env ls|add|rm|pull` | environment variables |
| `quai backup` / `quai restore` | instance state |
| `quai rm` | delete the project |
| `quai update` / `quai uninstall` | maintain the CLI |

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

Every one of these is verified against a real container on a real XFS volume,
because isolation is enforced by the kernel and cannot be proven any other way.

## Types

    npm install --save-dev quai-types

```ts
import { defineHandler } from "quai-types";

export default defineHandler((request, response) => {
  response.end(JSON.stringify({ path: request.url }));
});
```

The helpers return their argument untouched: they exist for the type checker,
so the code that runs on the server is exactly the code you wrote.

## Development

    bun run check        # lint, format, types and unit tests
    bun test             # 548 unit tests, no container needed

    docker build -t quai:integration .
    bash test/integration.sh quai:integration

The unit tests verify decisions; the integration suite verifies guarantees.
Both run in CI on every push, because an isolation regression is invisible to
the unit tests alone.

## Releases

Tagging `v*` publishes a multi-architecture image to `ghcr.io/atinseau/quai`,
standalone CLI binaries, and the types package — all from the same build, so
the `quai` on a laptop and the image on the server are never out of step.

    git tag v0.1.0 && git push origin v0.1.0

Publishing the types package needs an `NPM_TOKEN` on the `production`
environment, and it has to be a granular access token with *bypass 2FA*
enabled — an account with two-factor publishing rejects a classic token. The
job is skipped rather than failed when the token is absent, so the image and
the CLI ship either way.

## Limits worth knowing

Quai is a single host: no clustering, no scale-to-zero, no preview environment
per branch. A static project costs nothing when idle, but a service holds its
process.

The isolation is a real boundary for ordinary code and a reasonable one for
untrusted code, but the kernel is shared. Hosting genuinely hostile code would
call for micro-VMs, which the `Runner` interface is shaped to allow later.

