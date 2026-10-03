import type { SearchConfig } from "../config.js";
import type { Job } from "../types.js";
import { mapLimit } from "../util.js";
import { fetchAshby } from "./ashby.js";
import { fetchGreenhouse } from "./greenhouse.js";
import { fetchLever } from "./lever.js";

export type Fetcher = (url: string) => Promise<unknown>;

export const httpJson: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: { "user-agent": "job-ai-agent/0.1 (personal job search)", accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export interface DiscoverResult {
  jobs: Job[];
  /** One entry per board that failed -- a bad token must not abort the whole run. */
  errors: string[];
}

export async function discoverJobs(boards: SearchConfig["boards"], getJson: Fetcher = httpJson): Promise<DiscoverResult> {
  const tasks: Array<{ label: string; run: () => Promise<Job[]> }> = [
    ...boards.greenhouse.map((t) => ({ label: `greenhouse/${t}`, run: () => fetchGreenhouse(t, getJson) })),
    ...boards.lever.map((t) => ({ label: `lever/${t}`, run: () => fetchLever(t, getJson) })),
    ...boards.ashby.map((t) => ({ label: `ashby/${t}`, run: () => fetchAshby(t, getJson) })),
  ];

  const jobs: Job[] = [];
  const errors: string[] = [];
  await mapLimit(tasks, 4, async (t) => {
    try {
      jobs.push(...(await t.run()));
    } catch (e) {
      errors.push(`${t.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return { jobs, errors };
}
