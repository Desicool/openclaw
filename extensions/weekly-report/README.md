# weekly-report plugin

Cron-triggered weekly report flow with a Feishu confirmation card and a sentinel-bounded doc write. The agent is the collector — it drafts from its own conversation context, the user confirms or supplements via a card, and the plugin writes the report into a configured Feishu doc.

This plugin is intentionally personal-deployment shaped: no per-user values are baked into source. Schedule, target doc, recipient chat, reminder cadence — everything comes from user config.

## Config

`openclaw.plugin.json` config under `plugins.entries.weekly-report`:

| Key                   | Type             | Default        | Notes                                                                          |
| --------------------- | ---------------- | -------------- | ------------------------------------------------------------------------------ |
| `targetDocToken`      | string           | —              | Required at flow time. Feishu doc token where the report is written.           |
| `recipientSessionKey` | string           | —              | Required. Where the card is delivered. Matches the user's main agent session.  |
| `reminderAfterDays`   | integer ≥ 1      | `3`            | Days waiting before the sweeper posts a reminder.                              |
| `failAfterDays`       | integer ≥ 1      | `7`            | Days waiting before the sweeper fails the flow. Must be > `reminderAfterDays`. |
| `notesDocToken`       | string           | —              | Optional supplementary notes doc the agent may consult during drafting.        |
| `draftPromptOverride` | string           | —              | Optional override for the agent drafting prompt.                               |
| `weekStartsOn`        | `monday\|sunday` | monday         | Currently only `monday` is implemented; `sunday` throws.                       |
| `sweeperIntervalMs`   | integer ≥ 60000  | `3600000` (1h) | Sweeper tick. Lower in tests.                                                  |

### Git-activity fact source (v2, opt-in)

The agent calls `fetch_git_activity` alongside `getSessionMessages` during drafting to anchor `completed` bullets in real commits. Set `gitRemotes` to enable; leave unset to disable entirely (the tool returns empty and the agent moves on).

| Key                    | Type                 | Default                           | Notes                                                                                        |
| ---------------------- | -------------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| `gitRemotes`           | `[{ name, sshUrl }]` | `[]`                              | Repos to track. `sshUrl` must be scp-style `git@host:path.git`. `name` is `[a-z0-9_-]+`.     |
| `gitAuthor`            | string               | —                                 | Required when `gitRemotes` is non-empty. Passed to `git log --author=` (matches name/email). |
| `gitWorkspaceDir`      | string               | `{stateDir}/weekly-report/repos/` | Clone destination root. Per-repo dir = `{gitWorkspaceDir}/{name}/`.                          |
| `gitFetchTimeoutMs`    | integer ≥ 1000       | `30000`                           | Per-operation timeout (clone, fetch, log).                                                   |
| `gitOverallTimeoutMs`  | integer ≥ 5000       | `120000`                          | Budget across all repos in one tool call.                                                    |
| `gitMaxParallelOps`    | integer ≥ 1          | `3`                               | Concurrent clone/fetch ops cap.                                                              |
| `gitMaxRepoCount`      | integer ≥ 1          | `10`                              | Refuses to start if `gitRemotes.length` exceeds this.                                        |
| `gitMaxCommitsPerRepo` | integer ≥ 1          | `200`                             | Per-repo log cap to keep tool output bounded for the LLM.                                    |
| `gitHostAllowlist`     | string[]             | `["gitlab.com", "github.com"]`    | Allowed hostnames for `sshUrl`. Add your self-hosted GitLab here.                            |

**Security & operational notes** (v2):

- All git invocations are argv-only (no shell interpolation), with hooks/submodules/file protocol disabled and `GIT_TERMINAL_PROMPT=0` + `BatchMode=yes`. The remote URL goes in as a single argv element.
- SSH host-key policy is **your responsibility**: ensure each `gitHostAllowlist` entry has its host key in `~/.ssh/known_hosts` BEFORE the first clone (run `ssh-keyscan <host> >> ~/.ssh/known_hosts` once). The plugin does not override `StrictHostKeyChecking`.
- Per-repo failures (network, missing key, etc.) surface as `{ok: false, error}` in the tool output and the agent is required by prompt to mention them in the draft — they never fail the TaskFlow.
- The git phase is purely additive: removing the SSH key or `gitRemotes` config returns the plugin to chat-only drafting with no error.

## Cron entry (sample)

This plugin doesn't ship a cron schedule. Add an entry to your OpenClaw cron jobs file (typically `$XDG_CONFIG_HOME/openclaw/cron/jobs.json`); the relevant shape is roughly:

```json
{
  "id": "weekly-report-friday",
  "name": "Weekly report kickoff",
  "enabled": true,
  "schedule": { "kind": "cron", "expr": "0 18 * * 5", "tz": "Asia/Shanghai" },
  "sessionTarget": "main",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "systemEvent",
    "text": "Time to draft this week's report. Pull the past week of conversation, organize it by project per the contract in `submit_weekly_report_draft`, and submit a draft."
  },
  "state": {}
}
```

Adjust schedule, timezone, prompt, and `sessionTarget` as you like. The prompt text is yours — the plugin doesn't care what nudges the agent, only that the agent ends up calling `submit_weekly_report_draft`. Use `openclaw cron add` (or the cron service surface) to create the entry rather than hand-editing if you're unsure of the exact field shape — it's the source of truth.

## Tools

The plugin exposes four tools the agent calls in sequence:

1. **`submit_weekly_report_draft({weekKey, weekTitle, draftJson, supersedeFlowId?, revisionLabel?})`** — validates the draft against the renderer schema, runs best-effort dedupe (or supersedes the named flow), creates a managed flow at `await_user_reply`, and returns a Feishu card JSON to send to `recipientSessionKey`. If a flow for this `weekKey` is already pending, the call no-ops and returns `action: "noop_already_pending"`.
2. **`respond_to_weekly_report_card({metadataJson, supplement?, sessionKey})`** — call this when a synthetic card-action event arrives from the Feishu plugin. Validates trust (controllerId / sessionKey / status / weekKey all checked against the bound flow) and branches:
   - `confirm` → transitions to `writing_doc`, returns splice instructions.
   - `supplement` → transitions to a transient `revising` state, returns `(originalDraft, supplement)` for the agent to merge and re-submit via `submit_weekly_report_draft` with `supersedeFlowId`.
3. **`splice_weekly_report_doc({flowId, currentDocBody})`** — pure server-side splice. Call between `feishu_doc read` and `feishu_doc write`. Returns the doc body with this flow's section replaced (or prepended) at sentinel boundaries.
4. **`finalize_weekly_report({flowId, success, error?})`** — call after the `feishu_doc write` step to `finish` (success) or `fail` (failure, with reason) the flow.

## Drafting contract

Each `current_week` item: `{title, intent, objective, completed[]}`. Each `next_week` row: `{project, plan}`. Rendering uses the same algorithm as the original `generate_weekly_report.py`; the test fixture is committed to keep the port honest.

## Sentinels in the doc

Each managed section is wrapped in invisible HTML comments:

```
<!-- weekly-report:begin weekKey=2026-W21 -->
## 2026.5.18-2026.5.24
...content...
<!-- weekly-report:end weekKey=2026-W21 -->
```

The splicer matches on the `weekKey` carried in the sentinel, not the visible heading. You can rename headings, hand-edit other parts of the doc, or interleave non-plugin sections — only the matching bounded range is touched.

## Behavior notes

- **Cross-extension calls.** The plugin does not import Feishu plugin internals. The card JSON is returned to the agent; the agent calls Feishu's existing tools (`feishu_doc`, whatever card-send mechanism is wired into your deployment) to perform actual I/O. Tool responses include explicit `instructions` strings to guide the agent through the multi-step flow.
- **Dedupe is best-effort.** `submit_weekly_report_draft` lists current flows, filters by `weekKey + active status`, and skips with a notification message if one already exists. The race window between list and create is theoretical for a single-user weekly cron; the read-modify-write doc strategy is the backstop.
- **Sweeper is CAS-idempotent.** Reminder and fail transitions use `expectedRevision`; two sweepers racing on the same flow can only succeed once.
- **Card-action trust.** `respond_to_weekly_report_card` validates `flowId` resolves, `controllerId === "weekly-report"`, `sessionKey` matches, `status === "waiting"`, and `weekKey` matches. Stale or forged events get a user-visible "no longer valid" response and no flow mutation.

## Tests

```
node scripts/run-vitest.mjs extensions/weekly-report
```

Coverage:

- `report-renderer.test.ts` — golden DocXML fixture (`fixtures/sample.expected.docxml`) verifies byte-equivalence with the Python source script.
- `doc-splicer.test.ts` — sentinel match, prepend, replace, freeform preserved, multiple weeks, renamed headings, orphaned sentinels.
- `dedupe.test.ts` — list+filter behavior.
- `card.test.ts` — payload codec round-trip + envelope primitive-only check.
- `card-action-handler.test.ts` — parsing happy paths and the five rejection reasons.
- `week-key.test.ts` — ISO week math and year boundaries.
- `settings.test.ts` — defaults, full population, invalid combinations.
- `timeout-sweeper.test.ts` — reminder posts once, no re-post when set, expiry triggers fail, CAS conflict is treated as skipped.
