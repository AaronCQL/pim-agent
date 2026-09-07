# Style Guide

## Shared functions: namespace objects

Related free functions are exported as **one `const` object literal at the bottom of the file**, named for the module, with the functions declared above it as bare `function` declarations.

```ts
function scan(...) {}
function watch(...) {}

export const FileEnumerator = { scan, watch };
```

- Bare internal calls, no `this`, no `static`.
- The name is canonical and chosen at the definition site. Consumers write `import { FileEnumerator }` — never `import * as`, never an `as`-rename.
- The filename matches the exported namespace exactly (`Renderer.ts` exports `const Renderer`).

## State: two representations, by temperature

| State | Shape | Examples |
| --- | --- | --- |
| Stateful service — few, lifecycle, invariants | `class` | `SessionHost`, `SessionRegistry`, `PickerService`, `AttachmentStore`, `WsGateway`, `SessionStore` |
| Content | object literals `satisfies Def` | themes, tool schemas, the replay fixture |

For the `class` tier: instantiate at the composition root (`bin/pim.ts`, an extension factory, a frontend entry) and pass instances down — **no module-level instances**, which are untestable. Initialise every field in the constructor and never `delete`.

## Comments

**Code says what; a comment says why, and only when the why is not visible.** A comment that could be deleted without losing information is a liability with no asset side.

Never write:

- Restatement. If the signature is not the documentation, rename the function.
- Pointers into `docs/` — no `.md` filename, no `§`. State the rule, not its address: a sentence survives a reorg and is wrong in a way review can catch.
- Duplicated prose. If it exists in `docs/`, it exists once.
- Plans. Intent about code that does not exist yet is guaranteed to be wrong later.
- JSDoc tags restating a signature. TypeScript already states and checks it.
- `TODO` / `FIXME` / `XXX`. An issue, a failing test, or nothing.

## Imports

**Cross-package imports use the `#` aliases; everything else is relative.** The root `package.json` `imports` map (`#core/*`, `#protocol/*`, …) is the only alias layer — no tsconfig `paths`, no `@/`/`~/` prefixes. Bun, TypeScript, and Vite all resolve it, in the checkout and inside the installed tarball alike. Intra-package imports stay relative, and `packages/boundaries.test.ts` enforces which layer may reach which.

## Icons

**Chrome is a class, never an inline SVG.** Everything the UI points at itself with is a utility class off the unocss icon preset (`i-lucide-*`, `i-solar-*`), and no SVG is ever inlined into a component. One inline drawing is a component that has quietly become an art asset: it cannot be restyled with the rest, nobody can find it when the set changes, and the second one will not match the first.

## TypeScript

- `type` over `interface`.
- Mark data-shape fields `readonly` where possible.
- Default to `Bun.*` APIs over Node built-ins, unless Bun has no equivalent.

## Tests

**Never wait on wall time.** Poll the condition, or hold the fake model server's turn open and release it once the state under test exists. A `sleep` tuned until it passes is tuned to one machine's load: it is dead time on every run and a failure on a slower one. The suite is a couple of seconds whole, and stays that way only because nothing in it sleeps.

**Print nothing on success.** `bun scripts/check.ts` is the gate — lint, format, typecheck, and the `agent`, `web` and `pack` suites — and a green run is silent, so everything on screen is a failure or a file that was rewritten. Run it after every change. Narrow it by task and forward flags to the suites: `bun scripts/check.ts agent --changed`, `bun scripts/check.ts web -t Sidebar`.

**A rewrite is a failure in CI.** `lint` and `format` repair what they can locally, on the assumption that whoever ran them can commit the result. Under `CI` there is no such person, so they only report: `format` names the files it would have rewritten and `lint` drops `--fix`, and either one exits non-zero. Fix it the same way you would any other red check — `bun run check`, then commit what it changed.

That contract only holds if the tests hold it too. A `console.log` left in a passing test is printed on every run of it forever; if a log line is worth keeping, assert on it with `spyOn(console, …)` instead, and if a number is only interesting when it regresses, print it only when it does.
