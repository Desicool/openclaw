import { describe, expect, it, vi } from "vitest";
import {
  collectBlockIds,
  extractHeadings,
  findWeekSectionHeadingId,
  legacySentinelKeyword,
  parseFetchEnvelope,
  writeWeeklySection,
  type RunCommandFn,
} from "./doc-writer.js";

type Spawn = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  killed: boolean;
  termination: "exited" | "signal" | "timeout";
};
const ok = (stdout: string): Spawn => ({
  stdout,
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exited",
});
const fail = (stderr: string, code = 1): Spawn => ({
  stdout: "",
  stderr,
  code,
  signal: null,
  killed: false,
  termination: "exited",
});
const json = (v: unknown) => ok(`${JSON.stringify(v)}\n`);

describe("doc-writer parse helpers", () => {
  it("parseFetchEnvelope pulls document_id + content; tolerates a leading log line", () => {
    const stdout = `[info] ready\n${JSON.stringify({
      ok: true,
      data: { document: { document_id: "page-root", content: '<h2 id="a">t</h2>' } },
    })}`;
    const res = parseFetchEnvelope(stdout);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.documentId).toBe("page-root");
      expect(res.content).toContain("<h2");
    }
  });

  it("parseFetchEnvelope reports ok:false envelopes and missing document", () => {
    expect(parseFetchEnvelope(JSON.stringify({ ok: false })).ok).toBe(false);
    expect(parseFetchEnvelope(JSON.stringify({ ok: true, data: {} })).ok).toBe(false);
    expect(parseFetchEnvelope("not json").ok).toBe(false);
  });

  it("extractHeadings returns {id, level, text} for each heading", () => {
    const xml =
      '<h1 id="h1">概览</h1><p id="p1">x</p><h2 id="h2">2026.5.25-2026.5.31</h2><h3 id="h3">本周工作</h3>';
    expect(extractHeadings(xml)).toEqual([
      { id: "h1", level: 1, text: "概览" },
      { id: "h2", level: 2, text: "2026.5.25-2026.5.31" },
      { id: "h3", level: 3, text: "本周工作" },
    ]);
  });

  it("findWeekSectionHeadingId matches the H2 by exact week-title text", () => {
    const headings = [
      { id: "h2a", level: 2, text: "2026.5.18-2026.5.24" },
      { id: "h2b", level: 2, text: "2026.5.25-2026.5.31" },
    ];
    expect(findWeekSectionHeadingId(headings, "2026.5.25-2026.5.31")).toBe("h2b");
    expect(findWeekSectionHeadingId(headings, "2026.6.1-2026.6.7")).toBeUndefined();
  });

  it("collectBlockIds returns de-duplicated ids in order", () => {
    expect(collectBlockIds('<h2 id="a">x</h2><p id="b">y</p><p id="a">dup</p>')).toEqual([
      "a",
      "b",
    ]);
    expect(collectBlockIds("")).toEqual([]);
  });

  it("legacySentinelKeyword is scoped to the given weekKey", () => {
    const kw = legacySentinelKeyword("2026-W22");
    expect(kw).toContain("weekly-report:begin weekKey=2026-W22");
    expect(kw).toContain("weekly-report:end weekKey=2026-W22");
  });
});

function routedRunCommand(docs: {
  outline: unknown;
  section: unknown;
  keyword: unknown;
  insert: unknown;
  other: unknown;
}) {
  const calls: string[][] = [];
  const runCommand = vi.fn(async (argv: readonly string[]) => {
    const a = [...argv];
    calls.push(a);
    if (a.includes("+fetch")) {
      const scope = a[a.indexOf("--scope") + 1];
      if (scope === "outline") {
        return json(docs.outline);
      }
      if (scope === "section") {
        return json(docs.section);
      }
      return json(docs.keyword);
    }
    if (a.includes("+update")) {
      const command = a[a.indexOf("--command") + 1];
      if (command === "block_insert_after") {
        return json(docs.insert);
      }
      return json(docs.other);
    }
    return fail("unexpected");
  }) as unknown as RunCommandFn;
  return { runCommand, calls };
}

const EMPTY = { ok: true, data: { document: { document_id: "page-root", content: "" } } };
const UPDATE_OK = { ok: true, data: { document: { result: "success" } } };

const baseParams = {
  binPath: "lark-cli",
  asIdentity: "user" as const,
  docToken: "doc-token",
  weekKey: "2026-W22",
  weekTitle: "2026.5.25-2026.5.31",
  sectionMarkdown: "## 2026.5.25-2026.5.31\n...",
  timeoutMs: 30_000,
};

describe("writeWeeklySection orchestration", () => {
  it("fresh doc: inserts the section at the page head (inline content), no delete, no move", async () => {
    const { runCommand, calls } = routedRunCommand({
      outline: {
        ok: true,
        data: { document: { document_id: "page-root", content: '<h1 id="t">周报</h1>' } },
      },
      section: EMPTY,
      keyword: EMPTY,
      insert: UPDATE_OK,
      other: UPDATE_OK,
    });
    const res = await writeWeeklySection({ ...baseParams, runCommand });
    expect(res.ok).toBe(true);
    // outline fetch uses with-ids + outline scope as user.
    const outline = calls.find((c) => c.includes("+fetch") && c.includes("outline"))!;
    expect(outline).toEqual(expect.arrayContaining(["--detail", "with-ids", "--as", "user"]));
    expect(calls.some((c) => c.includes("block_delete"))).toBe(false);
    // No move step — the insert anchors on the page id (document head) directly.
    expect(calls.some((c) => c.includes("block_move_after"))).toBe(false);
    const insert = calls.find((c) => c.includes("block_insert_after"))!;
    expect(insert[insert.indexOf("--block-id") + 1]).toBe("page-root"); // page anchor = head
    // Content is inline markdown (NOT a @file path), with --doc-format markdown.
    expect(insert).toEqual(expect.arrayContaining(["--doc-format", "markdown"]));
    expect(insert[insert.indexOf("--content") + 1]).toBe(baseParams.sectionMarkdown);
    expect(insert[insert.indexOf("--content") + 1].startsWith("@")).toBe(false);
    // `docs +update` rejects `--format` ("unknown flag") — it must never appear on update calls.
    expect(calls.filter((c) => c.includes("+update")).every((c) => !c.includes("--format"))).toBe(
      true,
    );
  });

  it("existing same-week section: deletes its blocks before inserting", async () => {
    const { runCommand, calls } = routedRunCommand({
      outline: {
        ok: true,
        data: {
          document: { document_id: "page-root", content: '<h2 id="wk">2026.5.25-2026.5.31</h2>' },
        },
      },
      section: {
        ok: true,
        data: {
          document: {
            document_id: "page-root",
            content: '<h2 id="wk">2026.5.25-2026.5.31</h2><p id="body1">a</p>',
          },
        },
      },
      keyword: EMPTY,
      insert: UPDATE_OK,
      other: UPDATE_OK,
    });
    const res = await writeWeeklySection({ ...baseParams, runCommand });
    expect(res.ok).toBe(true);
    const del = calls.find((c) => c.includes("block_delete"))!;
    expect(del).toBeDefined();
    const ids = del[del.indexOf("--block-id") + 1];
    expect(ids).toContain("wk");
    expect(ids).toContain("body1");
  });

  it("also deletes leftover legacy sentinel blocks (migration)", async () => {
    const { runCommand, calls } = routedRunCommand({
      outline: {
        ok: true,
        data: { document: { document_id: "page-root", content: '<h1 id="t">周报</h1>' } },
      },
      section: EMPTY,
      keyword: {
        ok: true,
        data: {
          document: {
            document_id: "page-root",
            content:
              '<p id="sentinel-begin">&lt;!-- weekly-report:begin weekKey=2026-W22 --&gt;</p>',
          },
        },
      },
      insert: UPDATE_OK,
      other: UPDATE_OK,
    });
    const res = await writeWeeklySection({ ...baseParams, runCommand });
    expect(res.ok).toBe(true);
    const del = calls.find((c) => c.includes("block_delete"))!;
    expect(del[del.indexOf("--block-id") + 1]).toContain("sentinel-begin");
  });

  it("surfaces a doc-access failure as ok:false with remediation", async () => {
    const runCommand = (async () => fail("permission denied (99991)")) as unknown as RunCommandFn;
    const res = await writeWeeklySection({ ...baseParams, runCommand });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/denied|permission|access|EDIT/i);
    }
  });

  it("bot identity failure hint mentions sharing the doc with the bot", async () => {
    const runCommand = (async () => fail("forbidden")) as unknown as RunCommandFn;
    const res = await writeWeeklySection({ ...baseParams, asIdentity: "bot", runCommand });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/share the target doc with the bot/i);
    }
  });
});
