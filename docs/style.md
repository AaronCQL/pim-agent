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

**A comment earns its place only if deleting it could let someone introduce a real bug.** That is the whole test. "It helps a reader understand" is not a justification — understanding is the code's job, and where the code is not doing it the fix is a better name or a smaller function, not a paragraph above it. Start from no comment and make the constraint argue its way in.

**Two sentences is a smell.** A constraint fits on one line. If it takes a paragraph, what is being explained is a bad name or a function doing two things; rename or split it and the paragraph goes away with it.

Delete, without replacement:

- **Rationale and justification.** Why a decision was made, why the alternative was rejected, why something was removed, what a thing is "rather than". History belongs in git, where it is dated, attributed and searchable; in the source it is an undated claim that nothing checks and that the next change silently falsifies. This is the largest cut, and it applies to a sentence inside an otherwise good comment as much as to a whole block.
- **Every doc comment on something not exported.** Private fields and methods, module-local consts and types, internal helpers, JSX children. If it isn't exported, the code is the documentation — the only reader is already in the file, looking at it.
- **Layout and CSS justification in JSX.** What the padding clears, why the row wraps, what the breakpoint hands to which host. The markup is the description.
- Restatement. If the signature is not the documentation, rename the function.
- Pointers into `docs/` — no `.md` filename, no `§`. State the rule, not its address: a sentence survives a reorg and is wrong in a way review can catch.
- Duplicated prose. If it exists in `docs/`, it exists once.
- Plans. Intent about code that does not exist yet is guaranteed to be wrong later.
- JSDoc tags restating a signature — `@param`, `@returns`. TypeScript already states and checks it.
- `TODO` / `FIXME` / `XXX`. An issue, a failing test, or nothing.

Two things survive. A **constraint** the compiler cannot hold: an upstream API bug, a browser or vendor quirk, a protocol invariant, a required ordering, a silent-corruption trap, a perf-critical invariant. It is compressed, never deleted, to one imperative line naming the constraint and what breaks — not the story, not what was tried. And **JSDoc on an exported symbol**, one line, only where the name and the type do not already say it.

| Comment | Verdict |
| --- | --- |
| Why this way, why not the other way, what it replaced | Delete |
| Anything on a non-exported field, const, type, helper or JSX node | Delete |
| Why the layout, padding or breakpoint is what it is | Delete |
| Upstream bug, vendor quirk, protocol invariant, required ordering, corruption trap, perf invariant | Compress to one line |
| Exported symbol whose name and type do not already say it | Keep, one line |
| Anything else | Delete |

A real constraint, compressed — the trap is kept, the reasoning is dropped:

```diff
-  // Attaching is imperative IO whose first act is a status write, and a
-  // component body may not write reactive state — dev Solid throws
-  // REACTIVE_WRITE_IN_OWNED_SCOPE, which `connect()` then reports as a
-  // rejection, so the socket is never opened and the app paints empty
-  // against a healthy server. `onSettled` is the effect phase, where the
-  // write is legal, and its returned cleanup is this component's teardown.
+  // Connect in the effect phase: `connect()` writes state, illegal in a component body.
   onSettled(() => {
```

```diff
-  // Substitutions in normalizeUnicode must be 1:1 by UTF-16 code unit so offsets in
-  // normalizedContent index into the original content. Adding multi-codepoint mappings
-  // (e.g. `…` → `...`) here would silently corrupt range math.
+  // normalizeUnicode substitutions must stay 1:1 by UTF-16 code unit, or offsets desync.
   const normalizedContent = normalizeUnicode(content);
```

An export keeps its line; the argument for how it is built is not part of it:

```diff
-/**
- * The cwd's git state, for the TUI footer and the web's branch chip. Shells
- * out rather than reading `.git` itself: worktrees, submodules and detached
- * heads are git's business, and `git status` already knows all three.
- */
+/** The cwd's git state, for the TUI footer and the web's branch chip. */
 export const Git = { EMPTY, parseStatus, watchDir, fetchStatus };
```

Not exported, so nothing is owed:

```diff
-/** The same message, as the store holds it: grown in place by a second send. */
 type OptimisticMessage = {
```

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

**A Solid diagnostic fails the test that provoked it.** The `web` suite loads Solid's dev build, and its findings — a read that will never update, a cleanup that will never run, a write from a scope that may not write — are failures like any assertion. They catch what no static check can, because the defect is in who called a function rather than in the function: `observeHeight` is correct from a component body and leaks from a `ref`. Two answers a linter has to give at one line of source, and the runtime already knows which one happened. Where the read really is a snapshot, `untrack` says so and the diagnostic goes quiet; where it is not, the fix is the one the message names.

**Print nothing on success.** `bun scripts/check.ts` is the gate — lint, format, typecheck, and the `agent`, `web` and `pack` suites — and a green run prints one line, `✓ lint, format, typecheck, agent, web in 3.3s`, so everything above it is a failure or a file that was rewritten. The line names the tasks rather than counting them: it is the receipt that the gate ran at all, and on a narrowed run, that the selector chose what you meant. Run it after every change. Narrow it by task and forward flags to the suites: `bun scripts/check.ts agent --changed`, `bun scripts/check.ts web -t Sidebar`.

**A rewrite is a failure in CI.** `lint` and `format` repair what they can locally, on the assumption that whoever ran them can commit the result. Under `CI` there is no such person, so they only report: `format` names the files it would have rewritten and `lint` drops `--fix`, and either one exits non-zero. Fix it the same way you would any other red check — `bun run check`, then commit what it changed.

That contract only holds if the tests hold it too. A `console.log` left in a passing test is printed on every run of it forever; if a log line is worth keeping, assert on it with `spyOn(console, …)` instead, and if a number is only interesting when it regresses, print it only when it does.
