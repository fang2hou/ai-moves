# AI Moves Signal Desk

Review recent Hacker News activity and changelogs, open prepared alert documents, and check recorded delivery outcomes. Operators can edit notification destinations and publish versioned settings without viewing provider credentials or raw analysis.

```sh
pnpm --filter @ai-moves/web test
pnpm --filter @ai-moves/web build
pnpm --filter @ai-moves/api smoke:browser
```

The production build is served by the [API Worker](../api/README.md). It uses same-origin API calls and has no browser-managed tokens. Direct links to items, alerts, and controls require the same verified Access session as the feed. The local browser fixture runs the production assets against a synthetic, loopback-only Worker and D1 database.
