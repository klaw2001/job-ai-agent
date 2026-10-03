import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApplyOutcome } from "../src/apply/apply.js";
import { loadSearch } from "../src/config.js";
import { FatalLlmError, type Llm } from "../src/llm.js";
import { runApply, runDiscover, runScore } from "../src/pipeline.js";
import type { Fetcher } from "../src/sources/index.js";
import { Store } from "../src/store.js";
import type { Job } from "../src/types.js";
import { testJob, testProfile } from "./helpers/fixtures.js";

const search = loadSearch();
let file: string;
let store: Store;
beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ja-store-")), "store.json");
  store = new Store(file);
});

const ghJob = (id: number, title: string, location: string) => ({
  id,
  title,
  absolute_url: `https://boards.greenhouse.io/acme/jobs/${id}`,
  location: { name: location },
  content: "&lt;p&gt;Build things&lt;/p&gt;",
  company_name: "Acme",
});

const fetcher =
  (jobs: unknown[]): Fetcher =>
  async () => ({ jobs });

describe("runDiscover", () => {
  const jobs = [
    ghJob(1, "Full Stack Engineer", "Bengaluru, India"),
    ghJob(2, "Staff Software Engineer", "Bengaluru, India"),
    ghJob(3, "Backend Engineer", "San Francisco"),
  ];
  const oneBoard = { ...search, boards: { greenhouse: ["acme"], lever: [], ashby: [] } };

  it("stores matches as 'new' and the rest as 'filtered_out' with a reason", async () => {
    const r = await runDiscover(store, oneBoard, fetcher(jobs));
    expect(r).toMatchObject({ fetched: 3, newMatching: 1, newFiltered: 2 });
    expect(store.get("greenhouse:acme:1")?.status).toBe("new");
    expect(store.get("greenhouse:acme:2")?.filterReason).toMatch(/staff/);
    expect(store.get("greenhouse:acme:3")?.filterReason).toMatch(/location/);
    expect(new Store(file).all()).toHaveLength(3); // persisted
  });

  it("is idempotent and never resets the status of a job it has already seen", async () => {
    await runDiscover(store, oneBoard, fetcher(jobs));
    store.update("greenhouse:acme:1", { status: "applied" });
    const again = await runDiscover(store, oneBoard, fetcher(jobs));
    expect(again).toMatchObject({ newMatching: 0, newFiltered: 0 });
    expect(store.get("greenhouse:acme:1")?.status).toBe("applied");
    expect(store.all()).toHaveLength(3);
  });
});

describe("runScore", () => {
  /** Score is encoded in the title: "... [87]"; "[loc]" marks a location the candidate can't work from. */
  const scorer: Llm = {
    async json(req) {
      const title = /Title: (.*)/.exec(String(req.user))?.[1] ?? "";
      if (title.includes("[boom]")) throw new Error("API down");
      const score = Number(/\[(\d+)\]/.exec(title)?.[1] ?? 50);
      return {
        score,
        location_eligible: !title.includes("[loc]"),
        matched_skills: ["Node.js"],
        red_flags: [],
        reasons: ["ok"],
      } as never;
    },
  };
  const add = (n: number, title: string) => store.addIfNew(testJob("https://x/" + n, { id: `j${n}`, title }), "new");

  it("decides the verdict in code: threshold AND location eligibility", async () => {
    add(1, "Full Stack Engineer [85]");
    add(2, "Backend Engineer [60]");
    add(3, "Full Stack Engineer [95] [loc]");
    await runScore(store, scorer, "m", testProfile(), search);
    expect(store.get("j1")?.status).toBe("scored");
    expect(store.get("j2")?.status).toBe("low_match");
    expect(store.get("j3")?.status).toBe("low_match"); // 95 but can't work from there
    expect(store.get("j3")?.score).toMatchObject({ value: 95, verdict: "skip", locationEligible: false });
  });

  it("clamps out-of-range scores", async () => {
    add(1, "Full Stack Engineer [250]");
    await runScore(store, scorer, "m", testProfile(), search);
    expect(store.get("j1")?.score?.value).toBe(100);
  });

  it("one failing job doesn't abort the rest and stays 'new' for the next run", async () => {
    add(1, "Full Stack Engineer [90]");
    add(2, "Backend Engineer [boom]");
    const r = await runScore(store, scorer, "m", testProfile(), search);
    expect(r.failures).toHaveLength(1);
    expect(store.get("j1")?.status).toBe("scored");
    expect(store.get("j2")?.status).toBe("new");
  });

  it("a credentials failure aborts the whole run: healthy workers stop draining the queue", async () => {
    let calls = 0;
    const flaky: Llm = {
      async json() {
        if (++calls === 1) throw new FatalLlmError("bad key");
        await new Promise((r) => setTimeout(r, 20)); // the other two workers are healthy and slow
        return { score: 90, location_eligible: true, matched_skills: [], red_flags: [], reasons: [] } as never;
      },
    };
    for (let n = 1; n <= 20; n++) add(n, `Full Stack Engineer ${n}`);
    await expect(runScore(store, flaky, "m", testProfile(), search)).rejects.toBeInstanceOf(FatalLlmError);
    await new Promise((r) => setTimeout(r, 150)); // let in-flight calls settle before counting
    expect(calls).toBe(3); // only the requests already in flight (concurrency 3); the other 17 were never sent
  });

  it("respects the per-run cap, best-looking titles first", async () => {
    add(1, "Senior Software Engineer [80]");
    add(2, "Full Stack AI Engineer [80]");
    add(3, "Software Engineer II [80]");
    await runScore(store, scorer, "m", testProfile(), search, { limit: 1 });
    expect(store.get("j2")?.status).toBe("scored");
    expect(store.byStatus("new")).toHaveLength(2);
  });
});

describe("runApply", () => {
  const scored = (n: number, value: number, over: Partial<Job> = {}) => {
    store.addIfNew(testJob("https://x/" + n, { id: `j${n}`, title: `Role ${n}`, ...over }), "scored");
    store.update(`j${n}`, {
      score: { value, verdict: "apply", locationEligible: true, matchedSkills: [], redFlags: [], reasons: [] },
    });
  };
  const outcome = (status: ApplyOutcome["status"], unresolved: string[] = []): ApplyOutcome => ({ status, notes: [], unresolved });
  const noWait = async () => undefined;
  const cfg = (apply: Partial<typeof search.apply>) => ({ ...search, apply: { ...search.apply, ...apply } });

  it("goes best score first and honours the per-run cap", async () => {
    scored(1, 72);
    scored(2, 95);
    scored(3, 80);
    const order: string[] = [];
    await runApply(store, cfg({ max_per_run: 2 }), async (job) => (order.push(job.id), outcome("dry_run")), { mode: "dry-run" }, undefined, noWait);
    expect(order).toEqual(["j2", "j3"]);
    expect(store.get("j1")?.status).toBe("scored");
  });

  it("stops at the daily cap of SUBMITTED applications, counting earlier runs today", async () => {
    scored(1, 90);
    scored(2, 91);
    scored(3, 92);
    const apply = async () => outcome("applied");
    const first = await runApply(store, cfg({ max_per_day: 2, max_per_run: 5 }), apply, { mode: "auto" }, undefined, noWait);
    expect(first.submittedThisRun).toBe(2);
    const second = await runApply(store, cfg({ max_per_day: 2, max_per_run: 5 }), apply, { mode: "auto" }, undefined, noWait);
    expect(second.results).toHaveLength(0);
    expect(store.byStatus("scored")).toHaveLength(1);
  });

  it("dry-runs don't consume the daily cap and can be promoted to a real run later", async () => {
    scored(1, 90);
    await runApply(store, cfg({ max_per_day: 1 }), async () => outcome("dry_run"), { mode: "dry-run" }, undefined, noWait);
    expect(store.submittedToday()).toBe(0);
    const real = await runApply(store, cfg({ max_per_day: 1 }), async () => outcome("applied"), { mode: "auto" }, undefined, noWait);
    expect(real.submittedThisRun).toBe(1);
  });

  it("skips a cross-posted duplicate of a role already applied to", async () => {
    scored(1, 90, { title: "Full Stack Engineer", location: "Mumbai" });
    scored(2, 85, { title: "Full Stack Engineer", location: "Pune" });
    let calls = 0;
    await runApply(store, search, async () => (calls++, outcome("applied")), { mode: "auto" }, undefined, noWait);
    expect(calls).toBe(1);
    expect(store.get("j2")?.status).toBe("needs_human");
    expect(store.get("j2")?.filterReason).toMatch(/already applied/);
  });

  it("a crash while applying marks that job 'failed' and carries on", async () => {
    scored(1, 95);
    scored(2, 90);
    const r = await runApply(
      store,
      search,
      async (job) => {
        if (job.id === "j1") throw new Error("browser died");
        return outcome("dry_run");
      },
      { mode: "dry-run" },
      undefined,
      noWait,
    );
    expect(store.get("j1")?.status).toBe("failed");
    expect(store.get("j1")?.application?.notes[0]).toMatch(/browser died/);
    expect(store.get("j2")?.status).toBe("dry_run");
    expect(r.results).toHaveLength(2);
  });

  it("persists after every job, so a crash can't lose a submitted application", async () => {
    scored(1, 95);
    scored(2, 90);
    // Observe from inside the second application; assert afterwards (runApply swallows errors thrown by applyOne).
    let j1OnDiskWhileApplyingJ2: string | undefined;
    await runApply(
      store,
      search,
      async (job) => {
        if (job.id === "j2") j1OnDiskWhileApplyingJ2 = new Store(file).get("j1")?.status;
        return outcome("applied");
      },
      { mode: "auto" },
      undefined,
      noWait,
    );
    expect(j1OnDiskWhileApplyingJ2).toBe("applied");
  });

  it("never applies twice to the same job, even when asked by id", async () => {
    scored(1, 95);
    store.update("j1", { status: "applied" });
    await expect(
      runApply(store, search, async () => outcome("applied"), { mode: "auto", jobId: "j1" }, undefined, noWait),
    ).rejects.toThrow(/refusing to apply twice/);
  });

  it("--job re-attempts a needs_human job (e.g. after you added custom_answers)", async () => {
    scored(1, 95);
    store.update("j1", { status: "needs_human" });
    const r = await runApply(store, search, async () => outcome("applied"), { mode: "auto", jobId: "j1" }, undefined, noWait);
    expect(r.submittedThisRun).toBe(1);
    expect(store.get("j1")?.status).toBe("applied");
  });

  it("does not auto-retry jobs that need a human or failed", async () => {
    scored(1, 95);
    store.update("j1", { status: "needs_human" });
    scored(2, 94);
    store.update("j2", { status: "failed" });
    const r = await runApply(store, search, async () => outcome("applied"), { mode: "auto" }, undefined, noWait);
    expect(r.results).toHaveLength(0);
  });
});
