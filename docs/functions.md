# Writing a function

A function is a handler, not a server. You write what a request produces; Quai
provides the listening socket, the process lifecycle and the timeout.

Every form below is verified against a running instance, not merely intended.

## Node

The handler is exported as `default` or as `handler`, and receives Node's own
request and response objects.

```js
// api.js
export default (request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ path: request.url }));
};
```

A named export works identically, which matters when a file exports more than
one thing:

```js
export function handler(request, response) {
  response.end("hello");
}
```

Async handlers are awaited:

```js
export default async (request, response) => {
  const data = await fetch("https://example.com/api").then((r) => r.json());
  response.end(JSON.stringify(data));
};
```

You are responsible for ending the response. Nothing is sent until you call
`response.end()`, and a handler that never does is cut off by the timeout.

## Bun

Bun handlers use the platform's fetch shape: a `Request` in, a `Response` out.
Exported as `default`, `handler` or `fetch`.

```ts
// api.ts
export default (request: Request) =>
  Response.json({ path: new URL(request.url).pathname });
```

```ts
export const fetch = (request: Request) =>
  new Response("hello", { headers: { "content-type": "text/plain" } });
```

Returning the `Response` is enough; there is nothing to end.

## Python

The module defines a callable named `handler`. It receives a dictionary and
returns a value.

```python
# main.py
def handler(request):
    return {"method": request["method"], "path": request["path"]}
```

The request holds `method`, `path`, `headers` and `body`, the last being a
string, empty when the request carried none.

The return value decides the response. A `dict` or `list` is sent as JSON;
anything else is sent as text through `str()`; `None` sends an empty body.

```python
def handler(request):
    return "plain text"          # text/plain
```

Unlike Node and Bun, there is no response object: you return, Quai replies.

## What every runtime shares

**Naming.** A lone `api.js`, `api.ts` or `api.py` in a directory is recognised
as a function with no configuration at all. Anything else — a different
filename, or a handler that lives beside a `package.json` — needs a
`quai.toml` naming it:

```toml
type = "function"
runtime = "node"

[service]
start = "handlers/api.js"
```

**Timeouts.** A handler that does not answer in time gets cut off, and the
caller receives `504` rather than a hanging connection. Thirty seconds by
default:

```toml
[limits]
timeout = "45s"
```

**Failures.** A handler that throws produces `500 Function failed`; the error
itself goes to the logs, readable with `quai logs`. The exception is never sent
to the caller, since it routinely contains paths and connection strings.

**Environment.** Variables set with `quai env add` are available the usual way
for the runtime. `PORT`, `HOME` and `USER` are assigned by Quai and cannot be
overridden — a project that changed `PORT` would listen where the router is not
looking.

**Types.** `npm install --save-dev quai-types` gives completion and checking on
handlers and on `quai.toml`. The helpers return their argument untouched, so
the code that runs is the code you wrote.

## When a function is the wrong shape

A function is served per request, with its lifecycle managed for you. Reach for
a **service** instead when you need a long-lived process: a framework with its
own router, a websocket server, anything holding state between requests, or a
background worker.

```toml
type = "service"
runtime = "node"

[service]
internal_port = 8080
start = "node server.js"
```

A service listens on the port it declares. Two projects can both use 8080:
each has its own network namespace, so there is nothing to coordinate.

