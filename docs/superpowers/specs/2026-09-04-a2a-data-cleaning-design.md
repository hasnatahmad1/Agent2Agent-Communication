# A2A Data Cleaning System — Design

**Date:** 2026-09-04
**Status:** Awaiting approval
**Language:** TypeScript (Node 24)

---

## 1. Goal

Build two independent AI agents that cooperate over the **A2A (Agent2Agent) protocol**
to clean a deliberately messy 400-row CSV dataset.

Both agents run as separate OS processes on separate ports and communicate only
over HTTP using the A2A protocol — no shared memory, no function calls between them.

The system must demonstrate every core A2A concept:

| A2A concept | Where it appears |
|---|---|
| Agent Card discovery | Cleaner fetches Profiler's `/.well-known/agent-card.json` before use |
| JSON-RPC 2.0 transport | All requests POST to a single endpoint, dispatched by `method` |
| Task lifecycle | `submitted → working → input-required → working → completed` |
| SSE streaming | Profiler pushes live status updates; Cleaner renders them |
| Artifacts | Profiler returns `cleaning-plan.json` as a task artifact |
| `input-required` | Profiler pauses and asks the human an ambiguous cleaning question |
| Multi-turn task | The answer resumes the *same* task by `taskId` |

---

## 2. What A2A is (and is not)

**A2A is a peer-to-peer protocol between autonomous agents.** Each agent publishes a
machine-readable Agent Card describing its identity and skills; other agents discover it,
send it work, and track that work as a stateful Task.

This is deliberately contrasted in the demo with **tool use**:

```
Tool use:   Agent ──calls──> function       The function has no agency.
A2A:        Agent <──talks──> Agent         Both sides decide, ask, and refuse.
```

The Cleaner agent uses both. Its CSV functions are tools. The Profiler is a peer.

---

## 3. System architecture

```
        ┌──────────────────────────── Terminal 1 ───────────────────────────┐
        │  AGENT A — CLEANER                              http://:4001      │
        │                                                                   │
        │   Claude (via @anthropic-ai/claude-agent-sdk)                     │
        │        │  decides what to do next                                 │
        │        ▼                                                          │
        │   Tools:  load_csv  profile_columns  ask_profiler                 │
        │           preview_changes  apply_rule  dedupe                     │
        │           save_csv  write_report                                  │
        │                                                                   │
        │   Also serves its own Agent Card (skill: clean-dataset)           │
        └───────────────────────────────┬───────────────────────────────────┘
                                        │
             1. GET /.well-known/agent-card.json      (discovery)
             2. POST / {"method":"message/stream"}    (JSON-RPC)
             3. <─── SSE: status updates, artifact    (streaming)
             4. POST / {"method":"message/stream", taskId}  (answer resumes task)
                                        │
        ┌───────────────────────────────┴───────────────────────────────────┐
        │  AGENT B — PROFILER                             http://:4002      │
        │                                                                   │
        │   Claude (via @anthropic-ai/claude-agent-sdk) — no tools          │
        │   Input:  column profile (~2K tokens)                             │
        │   Output: cleaning-plan.json  (Artifact)                          │
        │                                                                   │
        │   Agent Card skill: analyze-data-quality                          │
        └───────────────────────────────────────────────────────────────────┘
```

### Division of responsibility

| | Agent A — Cleaner | Agent B — Profiler |
|---|---|---|
| Role | Executor | Advisor |
| Claude's job | Decide which tool to run, in what order, when to stop | Reason about data quality, propose rules |
| Sees | The whole dataset, through tools | Only the profile summary |
| Tools | Yes (8) | No |
| A2A skill id | `clean-dataset` | `analyze-data-quality` |
| Port | 4001 | 4002 |

**Why the Profiler never sees all 400 rows:** sending the full CSV would cost ~20K tokens
per run and, worse, asking an LLM to emit 400 cleaned rows risks silent row loss.
Instead the Cleaner computes a deterministic statistical profile (~2K tokens); the
Profiler reasons over that and returns *rules*; the Cleaner applies those rules in code.

**LLM does judgement. Code does volume.** This scales to any dataset size.

---

## 4. Agent B — Profiler

### 4.1 Agent Card

Served at `GET http://localhost:4002/.well-known/agent-card.json`:

Shape verified against `@a2a-js/sdk@1.1.0` `AgentCard` (protocol v1 — note there is no
`protocolVersion`, `url`, or `preferredTransport` field; endpoints live in
`supportedInterfaces`, and all listed fields are required by the interface):

```ts
export const profilerCard: AgentCard = {
  name: 'Data Profiler Agent',
  description:
    'Analyzes a dataset column profile and returns a cleaning plan with justifications.',
  version: '1.0.0',
  supportedInterfaces: [
    { url: 'http://localhost:4002/', protocolBinding: 'JSONRPC', tenant: '' },
  ],
  provider: undefined,
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false, extensions: [] },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ['text/plain', 'application/json'],
  defaultOutputModes: ['application/json'],
  skills: [
    {
      id: 'analyze-data-quality',
      name: 'Data Quality Analysis',
      description:
        'Given a column profile, identify data quality issues and propose cleaning rules.',
      tags: ['data', 'quality', 'cleaning', 'profiling'],
      examples: ['Analyze this profile of a student records CSV and tell me how to clean it.'],
      inputModes: ['application/json'],
      outputModes: ['application/json'],
      securityRequirements: [],
    },
  ],
  signatures: [],
};
```

Served by `agentCardHandler({ agentCardProvider: async () => profilerCard })` at
`/.well-known/agent-card.json` (the SDK's default path, and what `ClientFactory.createFromUrl`
looks for).

### 4.2 Executor behaviour

On `message/stream`, the Profiler:

1. Publishes `submitted`, then `working`.
2. Parses the incoming column profile (JSON in a text part).
3. Emits progress updates as it validates the profile
   (`"7 columns received"`, `"city: 7 distinct variants"`, `"marks: 14 out-of-range"`).
   These are real observations computed from the profile, not decorative messages.
4. **Ambiguity gate:** if the profile contains a defect class the Profiler cannot
   resolve on its own (see 4.3), it moves the task to `input-required` and stops.
5. On resume, or if there was no ambiguity, calls Claude with the profile and the
   human's answer, streaming Claude's progress as `working` updates.
6. Publishes the resulting plan as an Artifact named `cleaning-plan`, then `completed`.

### 4.3 The `input-required` trigger

Deterministic and reproducible, so the demo always shows this state:

> The `age` column contains values outside the plausible range 5–100.
> Dropping those rows, imputing them, or leaving them are all defensible;
> the agent must not silently choose.

Question sent to the caller:

```
age column has 3 rows with implausible values (-5, -5, 250).
How should these be handled?
  (a) drop those rows
  (b) replace with the column median
  (c) leave as-is and flag them in the report
```

The answer is injected into the Claude prompt as a constraint, so the returned plan
reflects the human's decision.

### 4.4 Prompt shape (Claude, no tools)

- **System:** role as a data quality expert; must return JSON only, matching the plan
  schema in §7; every rule must carry a human-readable `reason`; never invent columns.
- **User:** the column profile JSON, plus the human's answer to the ambiguity question if any.
- Output is parsed and validated against the schema. A parse failure retries once with the
  validation error appended; a second failure fails the task with a clear message.

---

## 5. Agent A — Cleaner

### 5.1 Agent Card

Served at `GET http://localhost:4001/.well-known/agent-card.json` — skill `clean-dataset`.
The Cleaner is a real A2A agent, not just a client: another agent could delegate a
cleaning job to it. Serving this card is what makes that true.

### 5.2 Tools available to Claude

| Tool | Input | Returns | Notes |
|---|---|---|---|
| `load_csv` | `path` | row count, column names | Loads into in-process state |
| `profile_columns` | — | column profile JSON | Deterministic statistics |
| `ask_profiler` | `profile` | cleaning plan JSON | **Makes the A2A call** |
| `preview_changes` | `rule` | rows affected, 5 before/after examples | Does not mutate |
| `apply_rule` | `rule` | rows changed | Mutates working dataset |
| `dedupe` | `keys`, `keep` | rows removed | Mutates working dataset |
| `save_csv` | `path` | rows written | Writes final output |
| `write_report` | `summary` | path written | Claude supplies the narrative paragraph; code fills every number from the change log, so the report cannot contain invented statistics |

Claude receives a goal, not a script:

> "Clean the dataset at `<path>`. You have these tools. A specialist Profiler agent is
> reachable via `ask_profiler` if you want a cleaning plan. Preview any rule that looks
> like it will change a large fraction of rows before applying it. When done, save the
> result and write a summary report."

The order of operations is Claude's decision. This is what makes it an agent rather
than a script.

### 5.3 The `ask_profiler` tool — where A2A happens

Inside this one tool:

1. `GET http://localhost:4002/.well-known/agent-card.json`
2. Assert the card advertises skill `analyze-data-quality`; abort with a clear error if not.
   (Genuine capability negotiation — the URL is configuration, the *capability* is discovered.)
3. `POST` JSON-RPC `message/stream` with the profile.
4. Consume the SSE stream; print each status update to the Cleaner's console prefixed `[profiler]`.
5. On `input-required`: prompt the human on stdin, then `POST` `message/stream` again with
   the same `taskId` and `contextId` to resume the task.
6. On `completed`: extract the `cleaning-plan` artifact and return it to Claude.
7. On `failed`: return the error text to Claude, which may retry or proceed without a plan.

### 5.4 Column profile format

Computed deterministically, ~2K tokens for 400 rows:

```json
{
  "rowCount": 400,
  "columns": [
    {
      "name": "city",
      "inferredType": "string",
      "nullCount": 12,
      "distinctCount": 7,
      "topValues": [["Lahore",120],["lahore",45],["Karachi",95],["LHR",18],
                    [" Lahore ",9],["khi",11],["N/A",12]],
      "sampleValues": ["Lahore","lahore","LHR"]
    },
    {
      "name": "marks",
      "inferredType": "number",
      "nullCount": 5,
      "min": -5, "max": 105, "mean": 67.2,
      "outOfRangeCount": 14,
      "nonNumericValues": []
    }
  ],
  "sampleRows": "15 raw rows, verbatim",
  "exactDuplicateRows": 17
}
```

---

## 6. Protocol surface

`@a2a-js/sdk@1.1.0` implements **A2A protocol v1**, whose JSON-RPC method names are
PascalCase. The older `message/send` / `tasks/get` names are v0.3 and only work behind
`legacyCompat: { enabled: true }`. **We target v1 and do not enable legacy compat.**

| v1 method (used) | v0.3 name (not used) | Role in demo |
|---|---|---|
| `SendStreamingMessage` | `message/stream` | **Primary** — SSE stream |
| `SendMessage` | `message/send` | Blocking fallback |
| `GetTask` | `tasks/get` | Shown in demo via curl |
| `CancelTask` | `tasks/cancel` | Shown in demo via curl |
| `SubscribeToTask` | `tasks/resubscribe` | Available, not exercised |

Task states are the protobuf enum `TaskState`, not strings:
`TASK_STATE_SUBMITTED`, `TASK_STATE_WORKING`, `TASK_STATE_INPUT_REQUIRED`,
`TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`.

Wire shapes that differ from the v0.3 documentation commonly found online, and that the
implementation must follow:

- **`Part`** is a tagged union: `{ content: { $case: 'text', value: string } }` —
  not `{ kind: 'text', text: string }`. `$case` may also be `'data'`, `'raw'`, `'url'`.
- **`Role`** is the enum `Role.ROLE_USER` / `Role.ROLE_AGENT`, not `'user'` / `'agent'`.
- **Stream events** arrive as `StreamResponse` with `payload.$case` of
  `'task' | 'message' | 'statusUpdate' | 'artifactUpdate'`.
- **Executor events** are published via the `AgentEvent` factory:
  `AgentEvent.task(...)`, `AgentEvent.statusUpdate(...)`, `AgentEvent.artifactUpdate(...)`.
  The first event of every `execute()` call MUST be a `task` or `message` event; the
  server rejects a stream that opens with a status or artifact update.

---

## 7. Cleaning plan schema

The contract between the two agents. Validated on both sides.

```jsonc
{
  "summary": "string — one paragraph in plain English",
  "rules": [
    {
      "id": "r1",
      "column": "city",              // omit for row-scoped rules
      "action": "normalize",         // see action table below
      "params": { "map": { "lahore": "Lahore", "LHR": "Lahore", "khi": "Karachi" } },
      "reason": "Same city written multiple ways",
      "severity": "medium"           // low | medium | high
    }
  ]
}
```

| `action` | `params` | Effect |
|---|---|---|
| `trim_whitespace` | — | Strip leading/trailing whitespace |
| `normalize` | `map` | Replace values via an explicit mapping |
| `title_case` | — | Normalize casing |
| `clip` | `min`, `max` | Clamp numeric values into range |
| `coerce_number` | `wordMap?` | `"twenty"` becomes `20`; unparseable becomes null |
| `parse_date` | `targetFormat` | Unify mixed date formats |
| `fill` | `strategy` (median / mode / constant), `value?` | Impute nulls |
| `drop_rows_where` | `predicate` | Remove rows matching a constrained predicate |
| `flag_invalid` | `pattern` | Add a `<col>_invalid` boolean column, do not delete |
| `dedupe` | `keys`, `keep` (first / last) | Row-scoped |

**Closed action set by design.** The Cleaner rejects any action outside this list. The LLM
cannot cause arbitrary transformations — a safety property worth stating to a reviewer.

---

## 8. Dataset

`data/students_raw.csv` — 400 rows, generated once by a seeded script and committed.

Columns: `roll_no, name, email, age, city, marks, enrolled_date`

| Defect | Approx. count | Example |
|---|---|---|
| Exact duplicate rows | 17 | full row repeated |
| Near-duplicate `roll_no` | 12 | same roll, different casing in name |
| Missing values | 55 | empty, `N/A`, `NULL`, `-` |
| City variants | 83 | `lahore`, `LHR`, `" Lahore "`, `khi` |
| Non-numeric age | 9 | `"twenty"`, `"22 years"` |
| Out-of-range marks | 14 | `105`, `-5` |
| Out-of-range age | 3 | `-5`, `250` — **triggers `input-required`** |
| Mixed date formats | 94 | `2024-03-01`, `01/03/2024`, `March 1, 2024` |
| Invalid emails | 21 | `ali@`, `sara.example.com` |
| Whitespace / casing in names | 40 | `"  ALI RAZA "` |

Remaining rows are clean, so the report's percentages are meaningful.

---

## 9. LLM abstraction

```ts
interface LLM {
  complete(opts: {
    system: string;
    user: string;
    tools?: ToolDef[];
    onProgress?: (text: string) => void;
  }): Promise<LLMResult>;
}
```

Two implementations:

| Implementation | Backend | When |
|---|---|---|
| `AgentSdkLLM` | `@anthropic-ai/claude-agent-sdk` → local `claude` CLI → existing Claude Code login | Default |
| `MockLLM` | Hardcoded plan + scripted tool calls | `USE_MOCK=1` |

No Anthropic API key is required. The user has Claude Code 2.1.260 installed and
authenticated; the Agent SDK reuses that session. Usage counts against the user's
Claude subscription limits, not an API bill.

`MockLLM` exists so the full protocol can be developed and tested without consuming
quota, and so tests are deterministic. **The protocol path is identical in both modes** —
only the reasoning is stubbed.

---

## 10. Outputs

| File | Content |
|---|---|
| `out/cleaned.csv` | The cleaned dataset |
| `out/cleaning-plan.json` | The artifact received from the Profiler, saved verbatim |
| `out/report.md` | Before/after counts per column, each rule applied with its reason, and the human decision made at the `input-required` gate |

`report.md` is the demo's headline output: it proves what the agents decided and why.

---

## 11. Project structure

```
A2A/
  package.json
  tsconfig.json
  data/
    students_raw.csv
  out/                       (gitignored)
  scripts/
    generate-dataset.ts      run once, seeded
  src/
    shared/
      plan.ts                plan schema + validation (used by BOTH agents)
      profile.ts             column profile types
      llm/
        index.ts             LLM interface + factory
        agent-sdk.ts         AgentSdkLLM
        mock.ts              MockLLM
    profiler/                Agent B
      index.ts               server bootstrap, port 4002
      card.ts                Agent Card
      executor.ts            task lifecycle, SSE, input-required gate
      prompt.ts
    cleaner/                 Agent A
      index.ts               server bootstrap + CLI entry, port 4001
      card.ts                Agent Card
      executor.ts
      tools/
        csv.ts               load/save/profile/apply/preview/dedupe
        ask-profiler.ts      the A2A client call
      apply.ts               rule engine (closed action set)
      report.ts
  test/
```

`src/shared/plan.ts` is imported by both agents, which is legitimate: it is the wire
contract, the equivalent of a shared `.proto` file. No runtime state is shared.

---

## 12. Error handling

| Failure | Behaviour |
|---|---|
| Profiler unreachable | `ask_profiler` returns a clear error to Claude; Claude may proceed with a minimal built-in plan or stop. Cleaner never crashes. |
| Card missing required skill | Abort with an explicit message naming the missing skill id. |
| Claude returns unparseable JSON | Retry once with the validation error appended; then fail the task. |
| Rule references unknown column | Rule skipped, recorded in `report.md` under "Skipped rules". |
| Unknown `action` | Rule rejected before execution. Never evaluated dynamically. |
| SSE connection drops | Surfaced as a task failure. (`tasks/resubscribe` is available but out of scope.) |
| `apply_rule` would change >50% of rows | Tool returns a warning; Claude is instructed to `preview_changes` first. |

---

## 13. Testing

| Level | Covers |
|---|---|
| Unit — rule engine | Each of the 10 actions, including no-op and error cases |
| Unit — profiler stats | Profile statistics correct on a fixture CSV |
| Unit — plan schema | Valid plans pass; unknown actions and malformed rules rejected |
| Integration — protocol | Start Profiler on an ephemeral port with `MockLLM`; assert card fetch, JSON-RPC call, SSE event sequence, artifact content |
| Integration — `input-required` | Assert the task enters `input-required`, resumes on the same `taskId`, and the answer changes the resulting plan |
| End-to-end | Both agents, `MockLLM`, real CSV → assert `cleaned.csv` row count and per-column invariants |

TDD: tests are written before each implementation unit.

---

## 14. Demo runbook

```
Terminal 2:  npm run profiler          # Agent B on :4002
Terminal 1:  npm run cleaner           # Agent A on :4001
Terminal 3:  npm run clean data/students_raw.csv
```

The demo narrative, in order:

1. `curl http://localhost:4002/.well-known/agent-card.json` — discovery, before anything runs.
2. Start the clean. Watch `[profiler]` SSE updates appear live in Terminal 1.
3. Answer the `input-required` question at the prompt.
4. `curl` a `tasks/get` request in Terminal 3 to show the task is server-side state with an id.
5. Open `out/report.md` and `out/cleaning-plan.json`.
6. Change the Profiler's port and restart it to show that only configuration changes —
   the protocol is unaffected. (Illustrates it could run on another machine.)

---

## 15. Out of scope

- Authentication (A2A supports it; not needed for a localhost demo)
- Push notifications / webhooks
- gRPC transport (the SDK offers it; JSON-RPC is the demo transport)
- A third **Validator** agent — a natural follow-up. Because each agent is already a
  separate process behind an Agent Card, adding it is a new folder plus one more
  `ask_*` tool. Explicitly deferred, not designed around.

---

## 16. Risks

| Risk | Mitigation |
|---|---|
| ~~`@a2a-js/sdk` v1.1.0 API names differ from assumptions here~~ | **RESOLVED 2026-09-04.** Verified against the installed `.d.ts`. The SDK is protocol v1, not v0.3: method names are PascalCase, `AgentCard` uses `supportedInterfaces`, `Part` is a `$case` union, `Role`/`TaskState` are enums, and the server is assembled from `DefaultRequestHandler` + `agentCardHandler` + `jsonRpcHandler` on Express. §4.1 and §6 rewritten accordingly. |
| Claude Agent SDK streaming shape doesn't map cleanly to A2A SSE | `MockLLM` keeps the protocol path testable regardless; the adapter is isolated in one file |
| Subscription rate limits during repeated testing | Develop with `USE_MOCK=1`; use real Claude only for end-to-end checks and the demo |
| Claude chooses a poor tool order | The goal prompt states the expected shape without scripting it; `preview_changes` and the closed action set bound the damage |
