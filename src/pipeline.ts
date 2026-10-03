import path from "node:path";
import type { ApplyOutcome } from "./apply/apply.js";
import { type Profile, type SearchConfig, paths } from "./config.js";
import { FatalLlmError, type Llm } from "./llm.js";
import { prefilter, priority } from "./match/filter.js";
import { scoreJob } from "./match/score.js";
import { type Fetcher, discoverJobs } from "./sources/index.js";
import type { Store } from "./store.js";
import type { ApplyMode, Job } from "./types.js";
import { mapLimit, randomBetween, safeFileName, sleep } from "./util.js";

type Log = (msg: string) => void;

// ---------------------------------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------------------------------

export async function runDiscover(store: Store, search: SearchConfig, getJson?: Fetcher) {
  const { jobs, errors } = await discoverJobs(search.boards, getJson);
  let added = 0;
  let filtered = 0;
  for (const job of jobs) {
    const verdict = prefilter(job, search);
    const isNew = store.addIfNew(job, verdict.ok ? "new" : "filtered_out", verdict.reason);
    if (isNew) {
      if (verdict.ok) added++;
      else filtered++;
    }
  }
  store.save();
  return { fetched: jobs.length, newMatching: added, newFiltered: filtered, errors };
}

// ---------------------------------------------------------------------------------------------------
// score
// ---------------------------------------------------------------------------------------------------

export async function runScore(
  store: Store,
  llm: Llm,
  model: string,
  profile: Profile,
  search: SearchConfig,
  opts: { limit?: number; log?: Log } = {},
) {
  const log = opts.log ?? (() => undefined);
  const cap = opts.limit ?? search.scoring.max_jobs_per_run;
  const queue = store
    .byStatus("new")
    .sort((a, b) => priority(b.job) - priority(a.job))
    .slice(0, cap);

  let good = 0;
  let low = 0;
  const failures: string[] = [];
  try {
    await mapLimit(queue, 3, async (rec) => {
      try {
        const score = await scoreJob(llm, model, profile, rec.job, search.scoring.min_score);
        store.update(rec.job.id, { score, status: score.verdict === "apply" ? "scored" : "low_match" });
        if (score.verdict === "apply") good++;
        else low++;
        log(`${String(score.value).padStart(3)}  ${rec.job.company} -- ${rec.job.title} (${rec.job.location})`);
      } catch (e) {
        if (e instanceof FatalLlmError) throw e; // same failure for every job: stop now, once
        // Leave the job as "new" so the next run retries it.
        failures.push(`${rec.job.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  } finally {
    store.save(); // keep whatever was scored before an abort
  }
  return { scored: queue.length - failures.length, good, low, failures, remaining: store.byStatus("new").length };
}

// ---------------------------------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------------------------------

export interface ApplyOptions {
  mode: ApplyMode;
  limit?: number;
  /** Apply to this one job id regardless of its status (except ones already submitted). */
  jobId?: string;
}

export async function runApply(
  store: Store,
  search: SearchConfig,
  applyOne: (job: Job, dir: string) => Promise<ApplyOutcome>,
  opts: ApplyOptions,
  log: Log = () => undefined,
  wait: (ms: number) => Promise<void> = sleep,
) {
  const results: Array<{ job: Job; outcome: ApplyOutcome }> = [];

  let queue;
  if (opts.jobId) {
    const rec = store.get(opts.jobId);
    if (!rec) throw new Error(`Unknown job id ${opts.jobId}`);
    if (rec.status === "applied" || rec.status === "submitted_unconfirmed") {
      throw new Error(`Already submitted to ${rec.job.company} -- ${rec.job.title}; refusing to apply twice.`);
    }
    queue = [rec];
  } else {
    queue = store
      .byStatus("scored", "dry_run")
      .filter((r) => r.score?.verdict === "apply" && r.job.ats)
      .sort((a, b) => (b.score?.value ?? 0) - (a.score?.value ?? 0));
  }

  const perRun = Math.min(opts.limit ?? search.apply.max_per_run, search.apply.max_per_run);
  let submittedThisRun = 0;
  let attempted = 0;

  for (const rec of queue) {
    if (attempted >= perRun) break;
    if (opts.mode !== "dry-run" && store.submittedToday() >= search.apply.max_per_day) {
      log(`daily cap of ${search.apply.max_per_day} submitted applications reached -- stopping`);
      break;
    }
    if (store.alreadySubmittedSameRole(rec.job)) {
      store.update(rec.job.id, { status: "needs_human", filterReason: "same role at this company was already applied to" });
      log(`skip ${rec.job.company} -- ${rec.job.title}: already applied to the same role`);
      continue;
    }

    if (attempted > 0 && opts.mode !== "review") {
      const [lo, hi] = search.apply.delay_seconds;
      await wait((opts.mode === "auto" ? randomBetween(lo, hi) : 3) * 1000);
    }
    attempted++;

    log(`\n>>> ${rec.job.company} -- ${rec.job.title}  [${rec.job.id}]`);
    const dir = path.join(paths.dataDir, "applications", safeFileName(rec.job.id));
    let outcome: ApplyOutcome;
    try {
      outcome = await applyOne(rec.job, dir);
    } catch (e) {
      if (e instanceof FatalLlmError) throw e;
      outcome = { status: "failed", notes: [`error: ${e instanceof Error ? e.message : String(e)}`], unresolved: [] };
    }
    store.update(rec.job.id, {
      status: outcome.status,
      application: {
        at: new Date().toISOString(),
        mode: opts.mode,
        notes: outcome.notes,
        unresolved: outcome.unresolved,
        artifactsDir: dir,
      },
    });
    store.save(); // persist after every job: a crash must never lose the record of a submitted application
    if (outcome.status === "applied" || outcome.status === "submitted_unconfirmed") submittedThisRun++;
    results.push({ job: rec.job, outcome });
    log(`    -> ${outcome.status}${outcome.unresolved.length ? `  (needs you: ${outcome.unresolved.join("; ")})` : ""}`);
  }
  return { results, submittedThisRun };
}
