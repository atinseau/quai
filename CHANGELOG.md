# Changelog

Only what changes for someone already running Quai: behaviour that differs,
and anything a working setup has to do about it. The full list of changes is
in the release notes on each tag.

## Unreleased

### Breaking

**`quai dev` refuses request paths it used to serve.** A static folder is now
resolved by the same code the deployed project uses, so directory traversal,
malformed percent-encoding and null bytes answer 404 locally exactly as they
already did on the server. A local link that relied on the old permissiveness
was already broken once deployed; it now fails in both places.

**`quai dev` serves on the port the manifest declares.** A service declaring
`internal_port = 8080` is served on 8080 rather than 3000. A project that
declares no port is unaffected. When the port is busy the command stops instead
of choosing another one — pass `--port` to move it.

### Added

`quai dev` reads `.env.local`, so a project needing a secret behaves the same
locally as on the server, and prints what it made of the manifest along with
the guarantees local execution cannot reproduce.

A Traefik overlay for putting Quai behind a proxy, verified against a real
proxy in CI, plus Caddy and nginx examples in the deployment guide.
