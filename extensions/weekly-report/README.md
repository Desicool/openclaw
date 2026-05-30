# weekly-report plugin

Cron-triggered weekly report flow with a Feishu confirmation card and a **non-destructive** doc write. The agent is the collector — it drafts from its own conversation context plus git/group fact sources, the user confirms or supplements via a card, and the plugin inserts the report at the **top** of a configured Feishu doc without disturbing anything already there.

The drafting contract (first-person voice + "facts not chat-recap" rules) is **owned by the plugin** and returned by the `begin_weekly_report` tool, so the cron entry is a one-line trigger and the plugin behaves consistently for everyone who installs it — no per-deployment prompt authoring.

This plugin is intentionally personal-deployment shaped: no per-user values are baked into source. Schedule, target doc, recipient chat, reminder cadence — everything comes from user config.

## Config

`openclaw.plugin.json` config under `plugins.entries.weekly-report`:

| Key                   | Type             | Default        | Notes                                                                                                                               |
| --------------------- | ---------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `targetDocToken`      | string           | —              | Required at flow time. Feishu doc token where the report is written.                                                                |
| `recipientSessionKey` | string           | —              | Required. Where the card is delivered. Matches the user's main agent session.                                                       |
| `reminderAfterDays`   | integer ≥ 1      | `3`            | Days waiting before the sweeper posts a reminder.                                                                                   |
| `failAfterDays`       | integer ≥ 1      | `7`            | Days waiting before the sweeper fails the flow. Must be > `reminderAfterDays`.                                                      |
| `weekStartsOn`        | `monday\|sunday` | monday         | Week-start anchor for `mondayMidnightUtcMs` (used as default time window when group/git tools are called without explicit sinceTs). |
| `sweeperIntervalMs`   | integer ≥ 60000  | `3600000` (1h) | Sweeper tick. Lower in tests.                                                                                                       |

### Doc write & card delivery (official lark-cli)

Card delivery and the doc write both shell out to the **official `@larksuite/cli`** (`lark-cli`). The doc write uses `docs +update` block ops (`block_insert_after` / `block_delete` / `block_move_after`) so the new week's section is inserted at the document head and only this week's prior section is replaced — images, comments, prior weeks, and any other content are left intact.

| Key                        | Type           | Default      | Notes                                                                                                                                                                                                                                                       |
| -------------------------- | -------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `larkOfficialCliBinPath`   | string         | `"lark-cli"` | Path to the official `@larksuite/cli` binary. One-time setup: `npm install -g @larksuite/cli@latest` + `lark-cli config init --app-id <bot appId> --app-secret-stdin --brand feishu`.                                                                       |
| `larkOfficialCliTimeoutMs` | integer ≥ 1000 | `30000`      | Per-invocation timeout for the official lark-cli (card send + each doc op).                                                                                                                                                                                 |
| `docIdentity`              | `user\|bot`    | `user`       | Identity (`--as`) for the doc read/write. **`user`** is the default: a bot generally cannot see a user-owned doc unless it is shared with the bot. Use `bot` only when the target doc is shared with the bot app (with edit) and user auth isn't available. |

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

### Group-message collection (v4 — shell-out to lark-cli)

v3 enumerated via `runtime.agent.session.listSessionEntries`, which only saw groups the agent had local session records for (3 groups in practice for silver-chariot, vs. the user's actual ~dozens of Feishu memberships). **v4 replaces this with a shell-out to `@richord/lark-cli` (a.k.a. `@fanfanv5/feishu-cli`) `im search-messages`**, which queries Feishu's server-side `search:message` API for messages the user authored or was mentioned in — discovery (chat_id) comes free as a byproduct of the hit set.

Two CLI invocations per drafting call: one with `--sender_ids` (author pass), one with `--mention_ids` (mention pass). Time window passed as explicit `--start_time`/`--end_time` ISO 8601 from the plugin's `mondayMidnightUtcMs` helper — `--relative_time this_week` is NOT used in production because lark-cli's notion of week-start may differ from configured `weekStartsOn`.

**Prerequisites on the host** (one-time setup; reused across cron runs):

1. **Install lark-cli (pinned)**: `npm install -g @richord/lark-cli@0.0.4` — auto-downloads the prebuilt binary on postinstall. Verify with `larkcli --version`. (Falls back: `@fanfanv5/feishu-cli@2.0.11` — same CLI compiled from JS, bin name `feishu`.)
2. **Bootstrap `~/.feishu-cli/config.json`** with the bot's app credentials (`appId`, `appSecret` pulled from `~/.openclaw/openclaw.json`'s `channels.feishu.accounts.<accountId>`). Use the same account id you'll pass to `larkCliAccountId` below.
3. **REQUIRED first-run device-flow**: `larkcli -a <accountId> auth device-flow` — completes OAuth in a browser. Although the openclaw-lark plugin already has the UAT (user-access-token) in `~/.local/share/openclaw-feishu-uat/`, lark-cli also needs the `<appId>.user` mapping file which openclaw-lark does not write. Skipping this step makes `larkcli auth status` report "not authorized" even though the keychain entry exists.
4. **REQUIRED scope pre-warm**: `larkcli -a <accountId> im search-messages --query test --page_size 1` once in an interactive shell. If lark-cli prompts for `search:message` scope grant, complete it. Subsequent non-interactive cron calls then have the scope cached. Without this, the first cron-triggered call surfaces a deferred-scope-grant error.

After the prerequisites the plugin auto-shells out per cron call. No drift, no daily setup.

| Key                       | Type           | Default     | Notes                                                                                                                                                                                                                       |
| ------------------------- | -------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `userOpenId`              | string `ou_…`  | auto-derive | Feishu open_id of the user. Auto-pulled from `recipientSessionKey`'s `:direct:<openid>` suffix. If unresolvable, the tool returns top-level `ok: false` with remediation; drafting continues without group data.            |
| `botOpenId`               | string `ou_…`  | —           | Bot's open_id. Messages sent by the bot are dropped from `groupedByChat`. No auto-derivation (Feishu appId ≠ open_id).                                                                                                      |
| `groupDenylist`           | string[]       | `[]`        | Bare chatIds (`oc_…`) to drop from `groupedByChat` after fetch. Post-filter only.                                                                                                                                           |
| `groupMaxMessagesPerPass` | integer ≥ 1    | `200`       | Total messages per pass before pagination cap kicks in. Clamped to Feishu's per-page max (50) when invoking the CLI.                                                                                                        |
| `larkCliBinPath`          | string         | `"larkcli"` | Path to the lark-cli binary. Resolves via PATH for the bare name; absolute paths accepted.                                                                                                                                  |
| `larkCliAccountId`        | string         | —           | Account id passed to `larkcli -a`. **Required to enable group collection** — when unset the tool returns top-level `ok: false` synchronously without spawning anything. Must match an entry in `~/.feishu-cli/config.json`. |
| `larkCliTimeoutMs`        | integer ≥ 1000 | `30000`     | Per-CLI-invocation timeout.                                                                                                                                                                                                 |
| `larkCliMaxPages`         | integer ≥ 1    | `4`         | Hard cap on page-token follows per pass. With page_size 50, default = 200 messages max per pass. If `has_more` is still true at the cap, the pass result carries `truncated: true`.                                         |

**Removed in v4** (delete from your existing config if upgrading): `groupStaleAfterDays`, `topicGroups`, `groupMaxParallelOps`, `groupMaxGroupsScanned`, `groupOverallTimeoutMs`, and the renamed `groupMaxMessagesPerGroup` (now `groupMaxMessagesPerPass`).

**Volume / cost shape**: per cron draft, lark-cli does ~3 Feishu API round-trips per page (`search.message.create` + `mget` + `chats/batch_query`). With defaults: 4 pages × 2 passes × 3 calls ≈ 24 round-trips, budget roughly 5–12s total for the group phase. The agent's parallel `getSessionMessages` and `fetch_git_activity` calls are independent.

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
    "text": "Time for the weekly report — call `begin_weekly_report` and follow the contract it returns."
  },
  "state": {}
}
```

The cron text is just a trigger: `begin_weekly_report` returns the full first-person drafting contract (voice rules, the three fact sources, the JSON schema, and the submit→card→confirm/supplement flow). You don't author the drafting prompt — that's why the plugin is shareable as-is. Adjust schedule and timezone freely.

> ⚠️ **Use `sessionTarget: "main"` + `payload.kind: "systemEvent"`, not `agentTurn`.** The cron runner spawns a fresh isolated agent process for every `agentTurn` job and has a hardcoded **60 s setup watchdog** (`CRON_AGENT_SETUP_WATCHDOG_MS` in `src/cron/service/timer.ts`). On hosts with several plugins, plugin loading + model auth routinely exceed that budget and the job fails with `cron: isolated agent setup timed out before runner start` _before our tool ever runs_. `systemEvent` queues the event into the user's already-running main session — no fork, no bootstrap, no 60 s deadline. The agent still has every tool it normally has (`begin_weekly_report`, `submit_weekly_report_draft`, the fact sources), so nothing about the flow is lost.
>
> Concretely: the systemEvent flavor expects `payload: { kind: "systemEvent", text: "…" }` (note the field is `text`, not `message`). The agentTurn flavor would use `message` — that mismatch is also a common gotcha when migrating an existing entry.

Use `openclaw cron add` (or the cron service surface) to create the entry rather than hand-editing if you're unsure of the exact field shape — it's the source of truth.

## Tools

The plugin exposes these agent-facing tools:

1. **`begin_weekly_report({})`** — kickoff. Returns `{ok, weekKeyHint, weekTitleHint, contract}` where `contract` is the plugin-owned first-person drafting contract: voice/content rules, the three parallel fact-source calls, the JSON schema, and the submit→card→confirm/supplement flow. No side effects. Call this first and follow the `contract` verbatim.
2. **`submit_weekly_report_draft({weekKey, weekTitle, draftJson, supersedeFlowId?, revisionLabel?})`** — validates the draft against the renderer schema, runs best-effort dedupe (or supersedes the named flow), creates a managed flow at `await_user_reply`, **and delivers the confirmation card to the user's DM** as a CardKit form card via the official `lark-cli` (`im +messages-send --as bot`). **Do NOT call `feishu_ask_user_question` afterwards** — the card is already sent. Your turn ends; the user taps a button on the card. If a flow for this `weekKey` is already pending, the call no-ops with `action: "noop_already_pending"`.
3. **`fetch_git_activity({sinceTs?, untilTs?, repoFilter?})`** — fact source. Returns `{windowStart, windowEnd, repos: [{name, sshUrl, ok, commits|error}]}`. Called in the same turn as `getSessionMessages`/`fetch_recent_group_messages`. Empty repos array if `gitRemotes` is unset; per-repo failures surface as `{ok: false, error}`.
4. **`fetch_recent_group_messages({sinceTs?, untilTs?, includeReasons?})`** — fact source. Shells out to lark-cli `im search-messages` (author + mention passes) and returns `{windowStart, windowEnd, userOpenId, accountId, passes: [...], groupedByChat: {chatId: messages[]}}`. Top-level `ok: false` when prerequisites are missing; `passes[].truncated: true` flags hard-cap exhaustion.
5. **`respond_to_weekly_report_card({flowId, weekKey, action, supplement?, sessionKey})`** — legacy/agent-side handler for the rare case the user replies by text instead of tapping the card. The live confirm/supplement path is the card buttons, handled by the plugin's interactive handler (the plugin writes the doc itself on confirm). On `confirm` this tool just transitions and tells the agent the plugin writes on the card tap; on `supplement` it transitions to `revising`.
6. **`finalize_weekly_report({flowId, success, error?})`** — `finish` (success) or `fail` (failure, with reason) the flow.

**The doc write is not an agent tool.** When the user taps 「直接写入」 on the card, the plugin's interactive handler writes the doc inline via `doc-writer.writeWeeklySection` (official `lark-cli docs +update` block ops). The agent never fetches/splices/overwrites the doc.

## Drafting contract

`begin_weekly_report` returns the authoritative contract. Each `current_week` item: `{title, intent, objective, completed[]}`; each `next_week` row: `{project, plan}`. Voice is **first person** ("我"/I — the report is written by the user for their manager); `completed` bullets are **concrete facts** (shipped/merged commits, submissions, agreed conclusions), never chat-history recap. The renderer emits Markdown (GFM pipe table for the next-week section); `fixtures/sample.expected.md` is the byte-equal golden. The shared voice/content rules (`DRAFTING_HARD_RULES`) are reused by the supplement re-draft prompt so both rounds stay consistent.

## Section layout in the doc

Each week renders as exactly one `## <week_title>` H2 block followed by its body. The writer locates a week's existing section by **matching that H2 heading text** (via `docs +fetch --scope outline/section --detail with-ids`), deletes that section's blocks, and inserts the freshly rendered section at the document head — so the newest week is always on top and everything else is preserved. (Legacy `<!-- weekly-report:* -->` sentinel comments from the old overwrite-era write are cleaned up on the next write.)

## Behavior notes

- **Cross-extension calls.** The plugin does not import Feishu/lark plugin internals. Card delivery and the doc read/write shell out to the official `@larksuite/cli` (`lark-cli`) via `runtime.system.runCommandWithTimeout` — card send as bot, doc ops as `docIdentity` (default `user`). Group collection uses `@richord/lark-cli` (`larkcli`) `im search-messages`. The drafting prompt is owned by the plugin (`begin_weekly_report`), not the cron `jobs.json`.
- **Dedupe is best-effort.** `submit_weekly_report_draft` lists current flows, filters by `weekKey + active status`, and skips with a notification message if one already exists. The race window between list and create is theoretical for a single-user weekly cron; the read-modify-write doc strategy is the backstop.
- **Sweeper is CAS-idempotent.** Reminder and fail transitions use `expectedRevision`; two sweepers racing on the same flow can only succeed once.
- **Card-action trust.** `respond_to_weekly_report_card` validates `flowId` resolves, `controllerId === "weekly-report"`, `sessionKey` matches, `status === "waiting"`, and `weekKey` matches. Stale or forged events get a user-visible "no longer valid" response and no flow mutation.

## Tests

```
node scripts/run-vitest.mjs extensions/weekly-report
```

Coverage:

- `report-renderer.test.ts` — golden Markdown fixture (`fixtures/sample.expected.md`) pins the render output byte-for-byte.
- `doc-writer.test.ts` — XML parse helpers (headings, block ids, fetch/new-block envelopes), and the orchestration: fresh-doc insert-at-top, same-week replace via `block_delete`, legacy sentinel cleanup, and doc-access failure surfacing.
- `drafting-contract.test.ts` — the contract embeds first-person voice + facts-not-chat + no-meta/no-id rules and the schema; hint substitution.
- `begin-weekly-report.test.ts` — kickoff tool returns the contract + week hints with no side effects.
- `dedupe.test.ts` — list+filter behavior.
- `card.test.ts` — payload codec round-trip + envelope primitive-only check.
- `card-action-handler.test.ts` — parsing happy paths and the five rejection reasons.
- `week-key.test.ts` — ISO week math and year boundaries.
- `settings.test.ts` — defaults, full population, invalid combinations.
- `timeout-sweeper.test.ts` — reminder posts once, no re-post when set, expiry triggers fail, CAS conflict is treated as skipped.
