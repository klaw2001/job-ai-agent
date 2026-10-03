import type { SearchConfig } from "../config.js";
import type { Job } from "../types.js";
import { escapeRegExp } from "../util.js";

export interface FilterResult {
  ok: boolean;
  reason?: string;
}

/** Whole-word, case-insensitive match so "us" doesn't hit "Austin" and "ios" doesn't hit "bios". */
function termRegex(term: string): RegExp {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term.toLowerCase())}($|[^a-z0-9])`, "i");
}

const anyTerm = (text: string, terms: string[]) => terms.some((t) => termRegex(t).test(text));

export function titleOk(title: string, cfg: SearchConfig["titles"]): FilterResult {
  const t = title.toLowerCase();
  const bad = cfg.exclude.find((x) => termRegex(x).test(t));
  if (bad) return { ok: false, reason: `title excluded by "${bad}"` };
  const hit = cfg.include.some((x) => t.includes(x.toLowerCase()));
  return hit ? { ok: true } : { ok: false, reason: "title matches none of titles.include" };
}

export function locationOk(job: Pick<Job, "location" | "remote">, cfg: SearchConfig["locations"]): FilterResult {
  const loc = job.location.toLowerCase();
  if (anyTerm(loc, cfg.home_terms)) return { ok: true };
  if (anyTerm(loc, cfg.worldwide_terms)) return { ok: true };
  if (job.remote) {
    const lock = cfg.region_lock_terms.find((x) => termRegex(x).test(loc));
    return lock ? { ok: false, reason: `remote but locked to "${lock}"` } : { ok: true };
  }
  return { ok: false, reason: `location "${job.location}" is not a home location and not remote` };
}

export function prefilter(job: Job, search: SearchConfig): FilterResult {
  const t = titleOk(job.title, search.titles);
  if (!t.ok) return t;
  return locationOk(job, search.locations);
}

/** Cheap relevance ordering so the capped LLM budget is spent on the most promising postings first. */
export function priority(job: Job): number {
  const t = job.title.toLowerCase();
  let p = 0;
  if (/full[\s-]?stack/.test(t)) p += 3;
  if (/\bai\b|llm|genai|generative/.test(t)) p += 2;
  if (/node|typescript|javascript|react|vue/.test(t)) p += 1;
  if (/senior|sr\./.test(t)) p -= 1;
  if (/junior|jr\.|associate|\bi\b|\bii\b|\bsde[- ]?[12]\b/.test(t)) p += 1;
  return p;
}
