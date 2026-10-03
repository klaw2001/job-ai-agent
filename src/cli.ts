import fs from "node:fs";
import readline from "node:readline/promises";
import { Command } from "commander";
import { launchBrowser } from "./apply/fill.js";
import { applyToJob } from "./apply/apply.js";
import { loadProfile, loadSearch, models, paths } from "./config.js";
import { initProfileFromResume } from "./initCommand.js";
import { createLlm } from "./llm.js";
import { runApply, runDiscover, runScore } from "./pipeline.js";
import { Store } from "./store.js";
import type { ApplyMode, JobRecord } from "./types.js";
import path from "node:path";

if (typeof process.loadEnvFile === "function" && fs.existsSync(".env")) process.loadEnvFile(".env");

const store = () => new Store(path.join(paths.dataDir, "store.json"));
const say = (m: string) => console.log(m);

const program = new Command("job-agent").description(
  "Finds jobs on public ATS boards, scores them against your resume with Claude, and fills in the applications.",
);

program
  .command("init")
  .description("Build profile/profile.yaml from your resume PDF")
  .option("--resume <file>", "path to your resume PDF", paths.resume)
  .option("--force", "overwrite an existing profile.yaml")
  .action(async (o: { resume: string; force?: boolean }) => {
    const out = await initProfileFromResume(createLlm(), o.resume, !!o.force);
    say(`Wrote ${out}\nReview it, then fill in the \`answers\` section (notice period, salary, ...) yourself.`);
  });

async function discoverCmd() {
  const r = await runDiscover(store(), loadSearch());
  say(`Fetched ${r.fetched} postings: ${r.newMatching} new matches, ${r.newFiltered} new non-matches.`);
  for (const e of r.errors) say(`  ! ${e}`);
}

async function scoreCmd(limit?: number) {
  const r = await runScore(store(), createLlm(), models.score(), loadProfile(), loadSearch(), { limit, log: say });
  say(`\nScored ${r.scored}: ${r.good} worth applying to, ${r.low} below the bar. ${r.remaining} still unscored.`);
  for (const f of r.failures) say(`  ! ${f}`);
}

program
  .command("discover")
  .description("Fetch postings from the configured company boards and filter them by title/location")
  .action(discoverCmd);

program
  .command("score")
  .description("Score new matches against your profile with Claude")
  .option("--limit <n>", "max postings to score this run", (v) => parseInt(v, 10))
  .action((o: { limit?: number }) => scoreCmd(o.limit));

const MODES: ApplyMode[] = ["dry-run", "review", "auto"];

program
  .command("apply")
  .description("Fill in applications for the best-scoring jobs (default: dry-run -- nothing is submitted)")
  .option("--mode <mode>", `${MODES.join(" | ")}`, "dry-run")
  .option("--limit <n>", "max applications this run", (v) => parseInt(v, 10))
  .option("--job <id>", "apply to one specific job id (see `status`)")
  .action((o: { mode: string; limit?: number; job?: string }) => applyCmd(o.mode, o.limit, o.job));

async function applyCmd(modeArg: string, limit?: number, jobId?: string) {
  if (!MODES.includes(modeArg as ApplyMode)) throw new Error(`--mode must be one of ${MODES.join(", ")}`);
  const mode = modeArg as ApplyMode;
  const search = loadSearch();
  const profile = loadProfile();
  if (!fs.existsSync(paths.resume)) throw new Error(`Missing ${paths.resume} -- put your resume PDF there.`);

  const browser = await launchBrowser(mode !== "review"); // review needs a visible window
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const llm = createLlm();
    const r = await runApply(
      store(),
      search,
      (job, dir) =>
        applyToJob(
          { llm, model: models.main(), profile, resumePath: paths.resume, browser, ask: (q) => rl.question(q), log: say },
          job,
          mode,
          dir,
        ),
      { mode, limit, jobId },
      say,
    );
    say(`\nDone. ${r.results.length} attempted, ${r.submittedThisRun} submitted. Run \`status\` for details.`);
  } finally {
    rl.close();
    await browser.close();
  }
}

program
  .command("status")
  .description("Show what happened to every job")
  .option("--all", "include filtered-out and low-match jobs")
  .action((o: { all?: boolean }) => {
    const recs = store().all();
    const counts: Record<string, number> = {};
    for (const r of recs) counts[r.status] = (counts[r.status] ?? 0) + 1;
    say(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join("   ") || "(no jobs yet -- run `discover`)");

    const show = (title: string, list: JobRecord[], detail?: (r: JobRecord) => string[]) => {
      if (!list.length) return;
      say(`\n== ${title} ==`);
      for (const r of list.sort((a, b) => (b.score?.value ?? 0) - (a.score?.value ?? 0))) {
        say(`${String(r.score?.value ?? "-").padStart(3)}  ${r.job.company} -- ${r.job.title} (${r.job.location})`);
        say(`     ${r.job.id}\n     ${r.job.url}`);
        for (const d of detail?.(r) ?? []) say(`     ${d}`);
      }
    };
    show("Applied", store().byStatus("applied", "submitted_unconfirmed"), (r) =>
      r.status === "submitted_unconfirmed" ? ["submitted but no confirmation was detected -- check your e-mail"] : [],
    );
    show("Needs you", store().byStatus("needs_human"), (r) => [
      ...(r.application?.unresolved ?? []).map((u) => `- ${u}`),
      ...(r.filterReason ? [r.filterReason] : []),
      `finish by hand: ${r.job.applyUrl}`,
    ]);
    show("Ready (dry-run done, not submitted)", store().byStatus("dry_run"), (r) => [`screenshot: ${r.application?.artifactsDir}/filled.png`]);
    show("Scored, waiting to apply", store().byStatus("scored"), (r) => r.score?.reasons.slice(0, 2).map((x) => `+ ${x}`) ?? []);
    show("Failed", store().byStatus("failed"), (r) => r.application?.notes.slice(-2) ?? []);
    if (o.all) {
      show("Below the bar", store().byStatus("low_match"), (r) => r.score?.redFlags.slice(0, 2).map((x) => `! ${x}`) ?? []);
      show("Filtered out", store().byStatus("filtered_out"), (r) => [r.filterReason ?? ""]);
    }
  });

program
  .command("run")
  .description("discover -> score -> apply, in one go")
  .option("--mode <mode>", `${MODES.join(" | ")}`, "dry-run")
  .action(async (o: { mode: string }) => {
    await discoverCmd();
    await scoreCmd();
    await applyCmd(o.mode);
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(`\nError: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
