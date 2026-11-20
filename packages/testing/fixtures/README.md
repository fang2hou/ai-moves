# Fixture Convention

This directory stores upstream HTTP interactions for replay through `createMockUpstream().replay()`. All package tests use these fixtures instead of keeping package-local copies (architecture section 3.3).

## Layout and Names

```text
<upstream>/<scenario>.json
```

| Item         | Rule                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| `<upstream>` | One of `_example`, `hn`, `github`, `openrouter`, `slack`, `discord`, or `web` |
| `<scenario>` | Lowercase words separated by single hyphens                                   |
| Extension    | `.json` only                                                                  |

The file's `upstream` and `scenario` fields must produce the same path through `fixturePath()`.

## Format

Use the schema in `packages/testing/src/fixtures/exchange.ts`. The required fields are:

- `upstream` and `scenario`: stable fixture identity.
- `origin`: `recorded` for a real response and `synthetic` for a hand-written response.
- `recorded_on`: an ISO date for recorded fixtures; `null` for synthetic fixtures.
- `request`: the exact method and HTTPS URL used for replay matching.
- `response`: status, normalized lowercase headers, and a JSON value or response string body.

Unknown fields are rejected. Do not store tokens, cookies, private identifiers, or sensitive response content. Use synthetic values and run the log redactor check in `fixtures.test.ts`.

## Adding a Fixture

1. Choose the existing upstream directory and a descriptive scenario name.
2. Minimize the response to the behavior the test needs.
3. Replace private values with stable synthetic values.
4. Add the file and let `listFixturePaths()` discover it.
5. Run `pnpm --filter @ai-moves/testing test -- fixtures.test.ts`.

The `_example/ok.json` file is the format example.
