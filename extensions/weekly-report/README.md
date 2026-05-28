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

### Group-message collection (v3, auto-on)

The agent calls `fetch_recent_group_messages` alongside `getSessionMessages` and `fetch_git_activity` during drafting to capture the user's contributions in Feishu group chats — own messages, mentions, and threads the user participated in. **Auto-discovers** all groups the bot is in via `runtime.agent.session.listSessionEntries`; no allowlist required. Skip noisy groups via `groupDenylist`.

| Key                        | Type                                             | Default                                 | Notes                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `userOpenId`               | string `ou_…`                                    | auto-derived from `recipientSessionKey` | Feishu open*id of the human user. Auto-pulled from `:direct:<openid>` suffix of `recipientSessionKey` if not set. Validated against `^ou*[A-Za-z0-9_-]{8,}$`. If unresolvable, `fetch_recent_group_messages`returns a single`ok: false` entry with a remediation message — drafting continues without group data. |
| `botOpenId`                | string `ou_…`                                    | —                                       | Bot account's open*id. Messages with `senderOpenId === botOpenId` are excluded from group output. **No auto-derivation** — appId (`cli*…`) ≠ open_id; the plugin doesn't call the Feishu contacts API. Optional; without it bot self-messages may surface in collector output.                                    |
| `groupDenylist`            | string[]                                         | `[]`                                    | Full sessionKeys (`agent:…:feishu:group:oc_xxx`) or bare chatIds (`oc_xxx`) to skip.                                                                                                                                                                                                                              |
| `groupStaleAfterDays`      | integer ≥ 1                                      | `14`                                    | Skip group sessions with no activity (per `lastInteractionAt ?? updatedAt`) for this many days. Stops scanning groups the bot left months ago.                                                                                                                                                                    |
| `topicGroups`              | `"include" \| "collapse-by-chatid" \| "exclude"` | `"include"`                             | Feishu topic groups create one session per topic. `include` keeps all (default; can inflate scanned-count under `topicSessionMode: true`). `exclude` dedupes by `groupId` (keeps first session per parent chat). `collapse-by-chatid` deferred to v3.1.                                                           |
| `groupMaxMessagesPerGroup` | integer ≥ 1                                      | `200`                                   | Per-group fetch cap. Matches `getSessionMessages` server-side ceiling at `src/gateway/server-methods/sessions.ts:2178`.                                                                                                                                                                                           |
| `groupMaxParallelOps`      | integer ≥ 1                                      | `5`                                     | Concurrent group reads.                                                                                                                                                                                                                                                                                           |
| `groupMaxGroupsScanned`    | integer ≥ 1                                      | `50`                                    | Safety cap; if more candidate groups exist after filtering, the rest are dropped (count surfaced as `skippedGroups` in the tool response).                                                                                                                                                                        |
| `groupOverallTimeoutMs`    | integer ≥ 5000                                   | `60000`                                 | Overall tool budget. Groups not started before the deadline are marked `ok: false, error: "budget_exhausted"`.                                                                                                                                                                                                    |

**Volume budgeting** (v3): with defaults — up to 50 groups × 200 messages × ~50 tokens/message after filtering ≈ ~500k tokens worst case. Author+mention filtering typically drops this 10×+ in practice. If you're in many groups, lower `groupMaxGroupsScanned` or `groupMaxMessagesPerGroup`. The cron's main-session systemEvent path is unaffected by per-tool latency.

**Concurrency interaction**: agent issues up to ~9 concurrent ops (`fetch_git_activity` parallelism 3 + `fetch_recent_group_messages` parallelism 5 + `getSessionMessages` 1) in the drafting turn. Tune individual caps if you see rate-limiting in practice.

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

Adjust schedule, timezone, and prompt as you like. The prompt text is yours — the plugin doesn't care what nudges the agent, only that the agent ends up calling `submit_weekly_report_draft`.

> ⚠️ **Use `sessionTarget: "main"` + `payload.kind: "systemEvent"`, not `agentTurn`.** The cron runner spawns a fresh isolated agent process for every `agentTurn` job and has a hardcoded **60 s setup watchdog** (`CRON_AGENT_SETUP_WATCHDOG_MS` in `src/cron/service/timer.ts`). On hosts with several plugins, plugin loading + model auth routinely exceed that budget and the job fails with `cron: isolated agent setup timed out before runner start` _before our tool ever runs_. `systemEvent` queues the event into the user's already-running main session — no fork, no bootstrap, no 60 s deadline. The agent still has every tool it normally has, including `feishu_ask_user_question` (the card delivery), so nothing about the interactive flow is lost.
>
> Concretely: the systemEvent flavor expects `payload: { kind: "systemEvent", text: "…" }` (note the field is `text`, not `message`). The agentTurn flavor would use `message` — that mismatch is also a common gotcha when migrating an existing entry.

Use `openclaw cron add` (or the cron service surface) to create the entry rather than hand-editing if you're unsure of the exact field shape — it's the source of truth.

## Tools

The plugin exposes six tools. The agent calls them in this order:

1. **`submit_weekly_report_draft({weekKey, weekTitle, draftJson, supersedeFlowId?, revisionLabel?})`** — validates the draft against the renderer schema, runs best-effort dedupe (or supersedes the named flow), creates a managed flow at `await_user_reply`, and returns `{flowId, weekKey, weekTitle, previewMarkdown, questionHeader, confirmLabel, supplementLabel, instructions}`. **It does NOT return a raw card JSON** — the response's `instructions` tell the agent to deliver the card via `feishu_ask_user_question` (provided by `@larksuite/openclaw-lark` or any other lark plugin that registers it). If a flow for this `weekKey` is already pending, the call no-ops and returns `action: "noop_already_pending"`.
2. **`fetch_git_activity({sinceTs?, untilTs?, repoFilter?})`** — v2 fact source. Returns `{windowStart, windowEnd, repos: [{name, sshUrl, ok, commits|error}]}`. Agent typically calls this in the same turn as `getSessionMessages` so the LLM has both chat context and factual commit records before drafting. Returns an empty repos array if `gitRemotes` is unset; per-repo failures surface as `{ok: false, error}` and the agent is required by prompt to mention them in the draft.
3. **`fetch_recent_group_messages({sinceTs?, untilTs?, includeReasons?})`** — v3 fact source. Auto-discovers Feishu group sessions and returns the user's contributions per group: `{windowStart, windowEnd, scannedGroups, skippedGroups, userOpenId, threadFilterAvailable, groups: [{sessionKey, ok, messages|error}]}`. Each kept message has a `reason: "author" | "mention" | "thread"`. `includeReasons` is an optional comma-separated subset (default = all three). Returns a single ok:false entry when `userOpenId` is unresolved (remediation message in `error`).
4. **`respond_to_weekly_report_card({flowId, weekKey, action, supplement?, sessionKey})`** — call after the user submits the `feishu_ask_user_question` card. `action` is `"confirm"` or `"supplement"`. Validates trust (controllerId / sessionKey / status / weekKey all checked against the bound flow). On `confirm` → transitions to `writing_doc`, returns splice instructions. On `supplement` → transitions to a transient `revising` state, returns `(originalDraft, supplement)` for the agent to merge and re-submit via `submit_weekly_report_draft` with `supersedeFlowId`.
5. **`splice_weekly_report_doc({flowId, currentDocBody})`** — pure server-side splice. Call between `feishu_doc read` and `feishu_doc write`. Returns the doc body with this flow's section replaced (or prepended) at sentinel boundaries.
6. **`finalize_weekly_report({flowId, success, error?})`** — call after the `feishu_doc write` step to `finish` (success) or `fail` (failure, with reason) the flow.

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

- **Cross-extension calls.** The plugin does not import Feishu/lark plugin internals. Tool responses include explicit `instructions` naming the lark tools the agent must call: `feishu_ask_user_question` to render the interactive card, `feishu_doc` for read/write of the target doc. If your deployment uses a different lark plugin, register equivalent tool names or override `draftPromptOverride`/`questionHeader` to match.
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
