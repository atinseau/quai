# Operating an instance

## When a project crashes

A crashed service is restarted on its own. The delay widens with each failure
so a project that is definitively broken does not burn the machine, and after
enough failures in a row it is given up on rather than restarted forever.

A project that ran a while before dying is treated as having an incident, not
as broken: its record starts fresh. One that dies immediately keeps climbing
the backoff.

`quai status` shows whether a project was given up on. A redeploy is how you
say it is fixed — that clears the record and starts it again.

## Logs

    quai logs        # recent output
    quai logs -f     # follow it

Output is kept in memory for fast reads and written to the state volume, so a
crash that happened overnight is still readable after a restart. Logs are
bounded and rotation keeps the recent end: the lines explaining a crash are the
last ones written, not the first.

A project's logs are removed when the project is.

## Upgrading Quai

Pull the new image and restart. The database is brought forward automatically,
and the schema changes being applied are named in the log:

    applying schema migration 3: custom domains

Each change runs once and only on a database that is missing it, so restarting
an already-current instance does nothing. A database written by a *newer* Quai
is refused rather than rewritten, so downgrading fails loudly instead of
corrupting state.

Take a backup first anyway. A migration is the one moment where a bug costs
more than a restart:

    quai backup before-upgrade.json

## Backups

    quai backup                  # writes quai-backup.json
    quai backup /path/to/file
    quai restore <file>

A backup holds projects, uids, environment variables and custom domains,
captured in a transaction so a deploy running at the same time cannot leave it
describing a project that half exists.

The uids matter most. Files on the quota volume are owned by number, so a
project restored under a fresh uid could not read its own deploy. Restoring
re-creates the records; **redeploy each project to bring its content back** —
the backup carries state, not site content.

## Seeing what is on an instance

    quai list      # every project: type, state, url
    quai status    # the limits actually enforced for this project

`status` reads the limits back from the kernel and from `xfs_quota` rather than
echoing the configuration, which is what makes it useful when something behaves
oddly: it shows what is enforced, not what was intended.

## Limits

Set in `quai.toml`; absent values keep Quai's defaults.

| Setting | Default | Enforced by |
|---|---|---|
| `memory` | 256Mi | cgroup, OOM kill |
| `cpu` | 0.5 | cgroup |
| `pids` | 64 | cgroup — this is what contains a fork bomb |
| `disk` | 1Gi | XFS project quota |
| `timeout` | 30s | the function host |

A project exceeding its memory limit is killed on its own; its neighbours keep
serving.

## Removing a project

    quai rm

Removes the account, home, network namespace, cgroup, quota and database
record. The uid is retired rather than reused, so a new project cannot inherit
files a previous owner left behind.

