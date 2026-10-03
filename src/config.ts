import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const paths = {
  profile: path.join(ROOT, "profile", "profile.yaml"),
  resume: path.join(ROOT, "profile", "resume.pdf"),
  search: path.join(ROOT, "config", "search.yaml"),
  dataDir: process.env.JOB_AGENT_DATA_DIR ?? path.join(ROOT, "data"),
};

const nullableStr = z.string().nullable().default(null);

export const ProfileSchema = z.object({
  name: z.object({ first: z.string(), last: z.string() }),
  email: z.string(),
  phone: z.string(),
  location: z.object({
    city: z.string(),
    region: z.string().optional(),
    country: z.string(),
  }),
  links: z
    .object({
      website: z.string().optional(),
      linkedin: z.string().optional(),
      github: z.string().optional(),
    })
    .prefault({}),
  headline: z.string(),
  summary: z.string(),
  years_experience: z.number(),
  skills: z.record(z.string(), z.array(z.string())),
  experience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      start: z.string(),
      end: z.string(),
      bullets: z.array(z.string()).default([]),
    }),
  ),
  education: z
    .array(z.object({ school: z.string(), degree: z.string(), start: z.string(), end: z.string() }))
    .default([]),
  /**
   * Facts the agent may state on forms. Anything left null is NEVER guessed: if a
   * form requires it, the application is paused for you instead.
   */
  answers: z
    .object({
      notice_period: nullableStr, // e.g. "30 days"
      expected_salary: nullableStr, // e.g. "25 LPA"
      current_salary: nullableStr,
      willing_to_relocate: z.boolean().nullable().default(null),
      requires_sponsorship: z.boolean().nullable().default(null),
    })
    .prefault({}),
  /** Your own answers to recurring questions: first regex that matches the question label wins. */
  custom_answers: z.array(z.object({ match: z.string(), answer: z.string() })).default([]),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const SearchSchema = z.object({
  boards: z.object({
    greenhouse: z.array(z.string()).default([]),
    lever: z.array(z.string()).default([]),
    ashby: z.array(z.string()).default([]),
  }),
  titles: z.object({
    include: z.array(z.string()),
    exclude: z.array(z.string()).default([]),
  }),
  locations: z.object({
    /** Location text containing one of these always passes (e.g. your country/cities). */
    home_terms: z.array(z.string()),
    /** "Anywhere"-style remote roles that pass. */
    worldwide_terms: z.array(z.string()).default([]),
    /** Remote roles locked to these regions are dropped. */
    region_lock_terms: z.array(z.string()).default([]),
  }),
  scoring: z
    .object({
      min_score: z.number().default(70),
      max_jobs_per_run: z.number().default(60),
    })
    .prefault({}),
  apply: z
    .object({
      max_per_day: z.number().default(10),
      max_per_run: z.number().default(5),
      delay_seconds: z.tuple([z.number(), z.number()]).default([20, 60]),
    })
    .prefault({}),
});
export type SearchConfig = z.infer<typeof SearchSchema>;

function readYaml(file: string, hint: string): unknown {
  if (!fs.existsSync(file)) throw new Error(`Missing ${path.relative(ROOT, file)}. ${hint}`);
  return parseYaml(fs.readFileSync(file, "utf8"));
}

export function loadProfile(): Profile {
  const raw = readYaml(
    paths.profile,
    "Run `npm run agent -- init` to build it from your resume PDF (or copy profile/profile.example.yaml).",
  );
  const parsed = ProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`profile/profile.yaml is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export function loadSearch(): SearchConfig {
  const raw = readYaml(paths.search, "It ships with the repo -- did you delete it?");
  const parsed = SearchSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`config/search.yaml is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export const models = {
  main: () => process.env.CLAUDE_MODEL || "claude-opus-5-5",
  score: () => process.env.SCORE_MODEL || process.env.CLAUDE_MODEL || "claude-opus-5-5",
};
