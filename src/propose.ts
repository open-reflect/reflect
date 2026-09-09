import type { Database } from "bun:sqlite";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Row, rows } from "./db.ts";
import { LEARNED_RULES_PATH, PROPOSALS_DIR, ROLLBACK_DIR } from "./paths.ts";
import { PROVIDER_NAME, WINDOW_DAYS, setting } from "./config.ts";

const autoApply = () => /^(true|1|yes)$/i.test(setting("auto_apply") ?? "");
import { MINERS, type MinerEntry, QUALITATIVE_SLUGS } from "./miners.ts";
import { ask, judgeModel } from "./providers.ts";
import { statHookFriction, statTools } from "./stats.ts";

const LENSES: [string, string][] = [
  ["minimal", "Take the minimal-change view: propose the single smallest change the evidence below justifies."],
  ["rootcause", "Take the root-cause view: propose one change that addresses the cause, not the symptom."],
  ["clarity", "Take the clarity view: propose one change a teammate would understand on first read."],
];

const language = () => setting("language") ?? "en";

const REFUTE_VOTES = 3;
// Unanimous. A 2-of-3 bar was not reproducible: the same input flipped between apply and reject.
const REFUTE_SURVIVE = 3;

export async function synthesizeProposal(
  label: string,
  evidence: Row[],
  context = "",
): Promise<string> {
  const prompt =
    "You observe how a coding agent is used and propose improvements. " +
    "Below is a signal aggregated deterministically with SQL — measured, not guessed. Using only " +
    `these numbers, write one short improvement proposal in Markdown, in ${language()}.\n\n` +
    "Rules: 1) lead with the evidence (numbers) 2) propose a concrete change " +
    "3) end with a 'How to apply' section a person can review and run " +
    "4) never invent facts beyond the data 5) under 300 words.\n\n" +
    `Proposal type: ${label}\n${context}\n` +
    `Evidence (JSON):\n${JSON.stringify(evidence, null, 2)}\n`;
  const text = await ask(prompt, { timeoutMs: 180_000 });
  if (text) return text;
  // Keep the evidence even when synthesis fails — the numbers are the proposal.
  return `(${PROVIDER_NAME()} synthesis failed — evidence only)\n\n` +
    `\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\``;
}

/** Extract the file body from a synthesis answer: the first fenced block if any. */
export function stripFence(text: string): string {
  const fenced = text.match(/```[\w-]*\n([\s\S]*?)\n?```/);
  return `${(fenced ? fenced[1]! : text).trim()}\n`;
}

export type Verdict =
  | { verdict: "judged"; target_path: string; new_content: string; survivor_count: number; keeps: number[] }
  | { verdict: "no_survivor"; keeps: number[] }
  | { verdict: "no_new_rule"; detail: string }
  | { verdict: "error"; detail: string };

/**
 * Judge a qualitative proposal unattended: drafts, refutation votes, synthesis.
 * Each call is its own process, so the fan-out awaits every one.
 */
export async function judgeQualitative(
  proposalText: string,
  mode: "merge" | "create",
  targetPath: string,
  currentContent = "",
): Promise<Verdict> {
  const evidence = proposalText.slice(0, 4000);
  const model = judgeModel();

  const drafted = await Promise.all(
    LENSES.map(([, instruction]) => ask(`${instruction} Answer in ${language()}.\n\nEvidence:\n${evidence}`, { model })),
  );
  const drafts = drafted.filter((text) => text);
  if (!drafts.length) return { verdict: "error", detail: "no drafts produced" };

  const refutePrompt = (draft: string) =>
    "Judge whether the change below is justified by the evidence alone. Extending beyond the " +
    "evidence, overfitting, or duplicating an existing rule means it is refuted.\n" +
    "First line: REFUTED or KEEP only. Second line: one sentence of reasoning.\n\n" +
    `Evidence:\n${evidence}\n\nChange:\n${draft}`;

  const votes = await Promise.all(
    drafts.flatMap((draft) =>
      Array.from({ length: REFUTE_VOTES }, () => ask(refutePrompt(draft), { model })),
    ),
  );
  const keeps = drafts.map((_, index) =>
    votes
      .slice(index * REFUTE_VOTES, (index + 1) * REFUTE_VOTES)
      .filter((vote) => vote.toUpperCase().trimStart().startsWith("KEEP")).length,
  );
  const survivors = drafts.filter((_, index) => (keeps[index] ?? 0) >= REFUTE_SURVIVE);
  if (!survivors.length) return { verdict: "no_survivor", keeps };

  const joined = survivors.join("\n---\n");
  let synth: string;
  if (mode === "merge") {
    // Never ask the model to re-emit the file: it cannot reproduce what it was not shown.
    // Duplicate detection only needs the existing headings, not the bodies.
    const existingRules = currentContent
      .split("\n")
      .filter((line) => line.startsWith("# "))
      .join("\n");
    synth =
      `Below are the headings of the rules already in ${targetPath}.\n---\n${existingRules}\n---\n` +
      "Combine the surviving changes into exactly one new rule section to append to that file. " +
      "The first line must be '# slug (one-line summary)', followed by the body. " +
      "If it duplicates a heading above or there is nothing to add, answer with one sentence and no heading. " +
      `Output only the section, in ${language()}, with no explanation.\n\n${joined}`;
  } else {
    synth =
      "Combine the surviving changes into one memory file in the format below. Output only the file, " +
      `in ${language()}, with no explanation.\n---\nname: <kebab-case-slug>\ndescription: <one line>\nmetadata:\n` +
      "  type: feedback\n---\n\n<body, including a **Why:** line and a **How to apply:** line>\n\n" +
      `Evidence:\n${evidence}\n\nChanges to combine:\n${joined}`;
  }

  let finalText = stripFence(await ask(synth, { timeoutMs: 600_000 }));
  if (!finalText.trim()) return { verdict: "error", detail: "synthesis failed" };

  if (mode === "merge") {
    // No heading means "nothing to add" — do not append that sentence as a rule.
    if (!finalText.trimStart().startsWith("# ")) {
      return { verdict: "no_new_rule", detail: finalText.slice(0, 300) };
    }
    finalText = `${currentContent.replace(/\n+$/, "")}\n\n${finalText.trimStart()}`;
  }

  let finalTarget = targetPath;
  if (mode === "create") {
    const name = finalText.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "reflect-draft";
    finalTarget = join(targetPath, `${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.md`);
  }

  return {
    verdict: "judged",
    target_path: finalTarget,
    new_content: finalText,
    survivor_count: survivors.length,
    keeps,
  };
}

/** Write new content to the target; the previous content is backed up first. */
export function applyContent(targetPath: string, newContent: string, rollbackDir = ROLLBACK_DIR): void {
  const previous = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
  if (previous === newContent) {
    console.log("(unchanged)");
    return;
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  if (previous) {
    mkdirSync(rollbackDir, { recursive: true });
    const backup = join(rollbackDir, `${targetPath.split("/").pop()}.${Math.floor(Date.now() / 1000)}.bak`);
    writeFileSync(backup, previous);
    console.log(`backup: ${backup}`);
  }
  writeFileSync(targetPath, newContent);
  console.log(`applied: ${targetPath}`);
}

export function rollback(backupPath: string, targetPath: string): void {
  copyFileSync(backupPath, targetPath);
  console.log(`restored: ${targetPath} <- ${backupPath}`);
}

/** Find the project memory dir from a recorded transcript path instead of rebuilding the slug. */
export function resolveMemoryDir(db: Database, cwd: string | null): string | null {
  if (!cwd) return null;
  const row = db
    .query("SELECT file_path FROM sessions WHERE cwd=? AND file_path IS NOT NULL ORDER BY last_ts DESC LIMIT 1")
    .get(cwd) as { file_path: string } | null;
  if (!row?.file_path) return null;
  return join(dirname(row.file_path), "memory");
}

/** MEMORY.md is the index loaded into sessions; a memory file without a line here is dead. */
export function appendMemoryIndex(memoryFile: string, content: string): void {
  const name = content.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = content.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const fileName = memoryFile.split("/").pop()!;
  const index = join(dirname(memoryFile), "MEMORY.md");
  const existing = existsSync(index) ? readFileSync(index, "utf8") : "";
  if (existing.includes(fileName)) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(index, `${prefix}- [${name ?? fileName}](${fileName}) — ${description}\n`);
}

export type ProposeOptions = {
  windowDays?: number;
  miners?: MinerEntry[];
  proposalsDir?: string;
  learnedRules?: string;
  rollbackDir?: string;
  autoApply?: boolean;
};

export async function cmdPropose(db: Database, today: string, options: ProposeOptions = {}): Promise<string[]> {
  const windowDays = options.windowDays ?? WINDOW_DAYS();
  const miners = options.miners ?? MINERS;
  const proposalsDir = options.proposalsDir ?? PROPOSALS_DIR;
  const learnedRules = options.learnedRules ?? LEARNED_RULES_PATH;
  const rollbackDir = options.rollbackDir ?? ROLLBACK_DIR;
  const apply = options.autoApply ?? autoApply();
  mkdirSync(proposalsDir, { recursive: true });
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
  const written: string[] = [];

  for (const { slug, label, miner, context } of miners) {
    const evidence = miner(db, since);
    if (!evidence.length) continue;

    const text = await synthesizeProposal(label, evidence, `${context} The evidence covers the last ${windowDays} days.`);
    const path = join(proposalsDir, `${today}-${slug}.md`);
    writeFileSync(path, `${text}\n`);
    written.push(path);
    db.run(
      `INSERT INTO proposal_log(path, slug, created_at, status) VALUES (?,?,?,'pending')
       ON CONFLICT(path) DO UPDATE SET created_at=excluded.created_at, status='pending'`,
      [path, slug, today],
    );
    // Supersede last week's pending proposal for the same slug, or the queue grows weekly.
    db.run("UPDATE proposal_log SET status='superseded' WHERE slug=? AND status='pending' AND path<>?",
           [slug, path]);

    if (!QUALITATIVE_SLUGS.has(slug)) continue;

    let mode: "merge" | "create";
    let targetPath: string;
    let currentContent = "";
    if (slug === "correction-clusters") {
      const memoryDir = resolveMemoryDir(db, (evidence[0]?.cwd as string) ?? null);
      if (!memoryDir) {
        db.run("UPDATE proposal_log SET status='rejected' WHERE path=?", [path]);
        continue;
      }
      mode = "create";
      targetPath = memoryDir;
    } else {
      mkdirSync(dirname(learnedRules), { recursive: true });
      if (!existsSync(learnedRules)) {
        writeFileSync(learnedRules, "# reflect learned rules\n\nQualitative proposals that passed judging accumulate here.\n");
      }
      mode = "merge";
      targetPath = learnedRules;
      currentContent = readFileSync(learnedRules, "utf8");
    }

    const verdict = await judgeQualitative(text, mode, targetPath, currentContent);
    const judgedPath = path.replace(/\.md$/, ".judged.md");
    writeFileSync(judgedPath, `${JSON.stringify(verdict, null, 0)}\n`);
    written.push(judgedPath);

    if (verdict.verdict !== "judged") {
      db.run("UPDATE proposal_log SET status='rejected' WHERE path=?", [path]);
      continue;
    }
    if (!apply) {
      // Review mode (default): keep the judged content next to the proposal; a person applies it.
      const contentPath = path.replace(/\.md$/, ".apply.md");
      writeFileSync(contentPath, verdict.new_content);
      writeFileSync(judgedPath, `${JSON.stringify(verdict, null, 0)}\n\napply with: reflect apply ${verdict.target_path} ${contentPath}\n`);
      written.push(contentPath);
      continue;
    }
    try {
      applyContent(verdict.target_path, verdict.new_content, rollbackDir);
      if (mode === "create") appendMemoryIndex(verdict.target_path, verdict.new_content);
      db.run("UPDATE proposal_log SET status='applied' WHERE path=?", [path]);
    } catch (error) {
      db.run("UPDATE proposal_log SET status='rejected' WHERE path=?", [path]);
      writeFileSync(judgedPath, `${JSON.stringify(verdict)}\n\n(apply failed: ${(error as Error).message})\n`);
    }
  }
  return written;
}

export function listQueue(db: Database): Row[] {
  return rows(db, "SELECT path, slug, created_at FROM proposal_log WHERE status='pending' ORDER BY created_at DESC");
}

export function markProposal(db: Database, path: string, status: string): void {
  db.run("UPDATE proposal_log SET status=? WHERE path=?", [status, path]);
}

/** Snapshot a quantitative metric when an intervention is applied (evaluator baseline). */
export function measureMetric(db: Database, kind: string, param: string,
                              since: string | null = null): number {
  if (kind === "hook_blocks") {
    return statHookFriction(db, { limit: 200, since })
      .filter((r: Row) => r.hook === param)
      .reduce((total: number, r: Row) => total + (r.blocks as number), 0);
  }
  if (kind === "error_rate") {
    for (const row of statTools(db, { limit: 200, since })) {
      if (row.tool_name === param && row.calls) {
        return Math.round((((row.errors as number) ?? 0) / (row.calls as number)) * 10_000) / 10_000;
      }
    }
    return 0;
  }
  throw new Error(`Unknown metric_kind: ${kind}`);
}

export function trackIntervention(db: Database, slug: string, kind: string, param: string,
                                  note = ""): number {
  const baseline = measureMetric(db, kind, param);
  db.run(
    `INSERT INTO interventions(applied_at, proposal_slug, metric_kind, metric_param, baseline_value, note)
     VALUES (?,?,?,?,?,?)`,
    [new Date().toISOString(), slug, kind, param, baseline, note],
  );
  return baseline;
}

export function reviewInterventions(db: Database, minAgeDays = 7): Row[] {
  const cutoff = new Date(Date.now() - minAgeDays * 86_400_000).toISOString();
  const out: Row[] = [];
  for (const row of rows(db, "SELECT * FROM interventions WHERE reviewed_at IS NULL")) {
    if (String(row.applied_at) > cutoff) continue;
    const current = measureMetric(db, String(row.metric_kind), String(row.metric_param),
                                  String(row.applied_at).slice(0, 10));
    const baseline = row.baseline_value as number;
    const delta = baseline ? Math.round(((current - baseline) / baseline) * 1000) / 10 : null;
    db.run("UPDATE interventions SET reviewed_at=?, current_value=?, delta_pct=? WHERE id=?",
           [new Date().toISOString(), current, delta, row.id as number]);
    out.push({ proposal_slug: row.proposal_slug, metric: `${row.metric_kind}:${row.metric_param}`,
               baseline, current, delta_pct: delta, note: row.note });
  }
  return out;
}

export function proposalFiles(): string[] {
  try {
    return readdirSync(PROPOSALS_DIR).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
}
