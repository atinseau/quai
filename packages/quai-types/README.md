# quai-types

Types for [Quai](https://github.com/atinseau/quai) projects.

    npm install --save-dev quai-types

## Functions

```ts
import { defineHandler } from "quai-types";

export default defineHandler((request, response) => {
  response.end(JSON.stringify({ path: request.url }));
});
```

On Bun, use `defineBunHandler` and the platform's fetch-style handler:

```ts
import { defineBunHandler } from "quai-types";

export default defineBunHandler((request) =>
  Response.json({ path: new URL(request.url).pathname }),
);
```

## Manifest

`quai.toml` stays the source of truth, but `defineConfig` gives you completion
and checking while you work out what to put in it:

```ts
import { defineConfig } from "quai-types";

export default defineConfig({
  type: "service",
  runtime: "node",
  service: { internalPort: 8080, start: "node server.js" },
  limits: { memory: "512Mi", cpu: "1" },
});
```

Every helper returns its argument untouched. They exist for the type checker,
so the code that runs on the server is exactly the code you wrote.

