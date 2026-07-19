# Project agent rules

## Code Search & Exploration

Use **perilla-qa `ask`** for searching and understanding code instead of grep/find/Read tools:

- When exploring unfamiliar code or searching across multiple files
- When understanding system design or data flow
- For answering "how does X work" questions about the codebase
- For analyzing code relationships and dependencies

Pass your question to **`ask`** for this workspace. Perilla handles routing, retrieval, and reads internally.

**Tip:** Enclose symbol names in backticks in your question (e.g. `AgenticCandidateSynthesizeNode`) — Perilla will return raw code snippets for those symbols rather than prose descriptions.

### Path scope

`ask` accepts an optional **`path`**: a list of repo-relative path prefixes that constrain retrieval to a subtree. Pass it when you already know which directory holds the answer (e.g. from `overview` or a prior `ask`). It narrows every seed stage (dense, topic-symbol, LLM path-pick) and clamps grep to that subtree — improving precision and cost for both `lookup` and `explore`.

- Scope matches at the directory boundary: `crates/perilla-core/src/ask` matches files under it (not the sibling `…/asking`). To scope to a single file, pass its full path.
- A scope that matches no indexed files is ignored (retrieval falls back to whole-repo).

```
path: ["crates/perilla-core/src/ask"]   →  "How does turn-0 seeding work?"
```

### Lookup vs explore hints

`ask` accepts an optional **`hint`**: `"lookup"`, `"explore"`, or omit for auto-routing. The hint sets the retrieval strategy — it does not change what you ask, only how Perilla searches.

| Hint | Use when | Pipeline |
|------|----------|----------|
| **`lookup`** | You want a specific fact, definition, schema, or file location — answer grounded in one or a few files | Symbol/path prefetch → lightweight tool loop (no coverage decompose) |
| **`explore`** | You want behavior, flow, or relationships across multiple files | Coverage decompose + component prefetch → broader tool loop |
| *(omit)* | Let Perilla classify from question phrasing | Defaults to lookup unless explore signals are present |

**When to pass a hint explicitly**

- Pass **`lookup`** for targeted questions even if phrasing is broad — e.g. table schemas, migration files, "what fields does `Foo` have?", "where is `Bar` defined?"
- Pass **`explore`** for cross-cutting questions even without "how does" phrasing — e.g. end-to-end flows, coordination between components, matching/linking logic across modules.
- Omit the hint when your question phrasing already matches intent.

**Auto-router signals (when hint is omitted)** — explore: `how do`, `how does`, `how is`, `differ`, `versus`, `vs`, `trace`, `compare`, `contrast`, `walk through`, `flow through`, `control flow`, and similar. Everything else defaults to lookup. A hint **overrides** auto-classification.

**Examples**

```
hint: "lookup"  →  "What are the `invoices` and `invoice_line_items` table schemas?"
hint: "explore" →  "How does invoice parsing work end-to-end when an invoice is uploaded?"
```

**`targeted_read`** — use only when you already know the exact file and line range (e.g. from a prior **`ask`** or `/perilla-understand` brief) and need the raw source for that span. It is deterministic (no LLM, no search). Do **not** use it for discovery, "how does X work", or when you are unsure which file or lines matter; use **`ask`** instead.

### Don't re-gather context you already have

If a task already specifies the file(s), symbol(s), or change to make — because it came from `get-task`, a `/perilla-plan` brief, a prior `ask` call in this session, or explicit instructions from the user — proceed directly to the edit. Do **not** issue exploratory greps, finds, reads, or additional `ask` calls "just to check." Only reach for `ask`/`targeted_read` when a specific fact you need is genuinely missing, not to re-verify context you were already given.

## Agent workflow

Do **not** use parallel Task/subagent launches for codebase exploration or reconnaissance. Avoid fanning out multiple explore agents, parallel grep/read sweeps, or batched file traversal in separate workers. Use a single **`ask`** call (or `/perilla-understand` / `/perilla-plan`) at a time so Perilla routing and index context stay coherent.

## Tasks

Tasks live in perilla.db and are visible in the Perilla UI. **`/perilla-plan`** is the canonical way to create them — it runs reconnaissance, produces a structured plan, validates it, and then calls `create-task` to persist the result.

### Working on tasks

When picking up work from the task board:

1. Call `mcp__perilla-qa__list-tasks` with `folderPath` and `status: "todo"` (or `"in-progress"`) to see what's pending.
2. Call `mcp__perilla-qa__get-task` with the task `id` to read its `goal`, `tests`, and `context`.
3. Call `mcp__perilla-qa__update-task` with `status: "in-progress"` when you start.
4. Call `mcp__perilla-qa__update-task` with `notes` to record progress observations as you work.
5. Call `mcp__perilla-qa__update-task` with `status: "complete"` when the acceptance tests pass.

Valid statuses: `"todo"` → `"in-progress"` → `"complete"`.

## Implementation Planning

Use **`/perilla-plan`** when starting a non-trivial implementation task — it runs reconnaissance via `ask`, produces a concrete step-by-step plan with optional compile-time validation, and saves the result as a Perilla task.
