# A2A Data Cleaning

Two independent AI agents — a **Cleaner** and a **Profiler** — cooperate over the
**A2A (Agent2Agent) protocol** to clean a messy 400-row student-records CSV. Each runs
as its own OS process on its own port and talks to the other only over HTTP, using the
A2A protocol: discover the other agent's Agent Card, send it a task, stream status
updates back over SSE, and — critically — let the Profiler pause a task in
`input-required` to ask a human a question before it finishes. This is different from
ordinary tool use, where an agent calls a function that has no agency of its own. A2A is
peer-to-peer: both sides are autonomous agents that can decide, ask, and refuse. The
Cleaner uses both patterns in this system — its CSV-manipulation functions are plain
tools, and the Profiler is an A2A peer it consults through the `ask_profiler` tool.

## Architecture

```
        ┌──────────────────────────── Terminal 1 ───────────────────────────┐
        │  AGENT A — CLEANER                              http://:4001      │
        │                                                                   │
        │   Claude (via @anthropic-ai/claude-agent-sdk)                     │
        │        │  decides what to do next                                 │
        │        ▼                                                          │
        │   Tools:  load_csv  profile_columns  ask_profiler                 │
        │           preview_changes  apply_rule  apply_plan                 │
        │           save_csv  write_report                                  │
        │                                                                   │
        │   Also serves its own Agent Card (skill: clean-dataset)           │
        └───────────────────────────────┬───────────────────────────────────┘
                                        │
             1. GET /.well-known/agent-card.json      (discovery)
             2. POST / {"method":"SendStreamingMessage"} (JSON-RPC)
             3. <─── SSE: status updates, artifact    (streaming)
             4. POST / {"method":"SendStreamingMessage", taskId}  (answer resumes task)
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

The Profiler never sees the raw 400 rows — only a deterministic statistical profile
(~2K tokens: per-column types, missing counts, distinct values, ranges, sample rows).
It reasons over that and returns *rules*; the Cleaner applies those rules in code. The
LLM does judgement, code does volume — this scales to any dataset size. See the
[design doc](docs/superpowers/specs/2026-09-04-a2a-data-cleaning-design.md) §3 for more.

## Run it

Three terminals:

```bash
# Terminal 1 — start the Profiler
npm run profiler

# Terminal 2 — start the Cleaner as an A2A server (optional; not needed for the CLI demo)
npm run cleaner

# Terminal 3 — run the Cleaner as a CLI against a CSV
npm run clean data/students_raw.csv
```

The Cleaner's CLI drives Claude directly (no A2A involved on that side); Claude then
calls the `ask_profiler` tool, which performs the full A2A exchange with the Profiler
server started in Terminal 1: discovery, a streaming JSON-RPC task, and — for this
dataset — an `input-required` pause asking how to handle implausible ages (`-5`, `250`).
Answer `a`, `b`, or `c` at the prompt.

`USE_MOCK=1 npm run clean data/students_raw.csv` runs the entire protocol —
discovery, streaming, the `input-required` pause and resume, the artifact — end to end
against a deterministic scripted response instead of Claude. Useful for exercising the
A2A wiring without spending API quota; this is also what the test suite runs against.

With real Claude (`USE_MOCK` unset), authentication comes from the machine's existing
Claude Code login — no `ANTHROPIC_API_KEY` needed.

## What to look at

After a run, `out/` contains:

| File | What it is |
|---|---|
| `out/report.md` | Human-readable cleaning report: rows before/after, the Profiler's plan summary, a table of every rule applied with rows changed/removed, and the human decision recorded verbatim |
| `out/cleaning-plan.json` | The raw plan artifact returned by the Profiler — the rules, their reasons, and severities |
| `out/cleaned.csv` | The cleaned dataset |

The CLI only claims a file was written after checking it actually exists on disk — a run
that doesn't reach `save_csv` or `write_report` says so plainly instead of printing a
false success message.

## Where the A2A protocol lives in the code

| File | What it implements |
|---|---|
| `src/profiler/card.ts` | The Profiler's Agent Card — identity, skills, capabilities, served at `/.well-known/agent-card.json` |
| `src/cleaner/ask-profiler.ts` | The client side of the A2A call: Agent Card discovery, the JSON-RPC streaming request, consuming SSE status/artifact events, answering an `input-required` pause on the same task, validating the returned plan |
| `src/profiler/executor.ts` | The server side of the task lifecycle: `submitted → working → input-required → working → completed`, publishing the `cleaning-plan` artifact, retrying an invalid plan once with the validation error appended |

## Design notes

**Why the LLM plans and code executes.** The Profiler's plan is JSON describing *what*
to do (`{"action": "clip", "column": "marks", "params": {"min": 0, "max": 100}}`), never
executable code. The Cleaner's rule engine (`src/cleaner/apply.ts`) interprets that JSON
against a closed action set — the LLM can request a transformation, but it cannot make
the process do anything the rule engine doesn't already know how to do safely. This also
means every plan is previewable and auditable before it touches a single row.

**Why the action set is closed.** `src/shared/plan.ts` defines exactly ten actions
(`trim_whitespace`, `normalize`, `title_case`, `clip`, `coerce_number`, `parse_date`,
`fill`, `drop_rows_where`, `flag_invalid`, `dedupe`). A plan is validated against this
list with Zod before anything is applied — "however it was produced, a plan cannot
request an arbitrary transformation." No `eval`, no free-form scripts, no way for either
agent to smuggle logic outside what the rule engine can execute.

**Protocol-v1 gotchas worth knowing**, discovered while wiring this up against
`@a2a-js/sdk@1.1.0`:

- The streaming JSON-RPC method is `SendStreamingMessage`, not the legacy
  `message/stream`.
- A message `Part`'s content is a `$case` discriminated union
  (`part.content.$case === 'text'`), not a flat `{ type: 'text', text }` shape.
- `Role` and `TaskState` are enums (`Role.ROLE_AGENT`, `TaskState.TASK_STATE_COMPLETED`),
  not string literals.
- `AgentInterface.protocolVersion` is required per interface entry in
  `supportedInterfaces` — omitting it causes protocol version negotiation to fail.
- A plain `GetTask` JSON-RPC call needs an explicit `A2A-Version: 1.0` header; without
  one, the server assumes the legacy `0.3` protocol and rejects the request.

## Real-Claude run notes

Running this against real Claude (rather than the deterministic mock used by the test
suite) exposed two SDK-level bugs, both fixed in `src/shared/llm-agent-sdk.ts` and
`src/cleaner/tools.ts`:

- The query picked up the user's own globally-configured MCP connectors alongside the
  tools this project registers, which confused Claude about its actual toolset. Fixed
  with `strictMcpConfig: true`.
- `createSdkMcpServer`'s tools are deferred behind a "tool search" meta-tool by default;
  since this project disables all built-in tools (`tools: []`), that meta-tool was
  disabled too, so Claude could never discover its tools existed at all. Fixed with
  `alwaysLoad: true`. Separately, one tool schema (`z.record(...)`, used for the
  `rule` parameter) broke JSON-Schema conversion for the whole MCP server, silently
  emptying its tool list; replaced with `z.object({}).passthrough()`.

Full run transcript, plan, and report are in the project's task report, not committed
here.

## Design doc

[`docs/superpowers/specs/2026-09-04-a2a-data-cleaning-design.md`](docs/superpowers/specs/2026-09-04-a2a-data-cleaning-design.md)
