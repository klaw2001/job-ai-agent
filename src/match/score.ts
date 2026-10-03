import { z } from "zod";
import type { Profile } from "../config.js";
import { type Llm, UNTRUSTED_NOTE } from "../llm.js";
import { profileToText } from "../profileText.js";
import type { Job, Score } from "../types.js";

const ScoreSchema = z.object({
  score: z.number().describe("0-100 overall fit"),
  location_eligible: z.boolean(),
  matched_skills: z.array(z.string()),
  red_flags: z.array(z.string()),
  reasons: z.array(z.string()),
});

const SYSTEM = `You are a pragmatic technical recruiter judging whether ONE candidate should apply to ONE job.
Judge only from the candidate profile and the job posting provided. Be calibrated and a little skeptical:
a score of 70+ must mean "this candidate would be a credible applicant and should apply".

Scoring guide (sum to 100):
- 40: overlap between the stack/skills the posting requires and what the candidate has actually done.
- 25: seniority fit. The candidate's real experience is given in years. Postings that require clearly more
  (e.g. 6+ years, "staff", team-lead scope) must score low overall even if the stack matches.
- 20: role and domain fit (full-stack / backend / frontend / applied-AI product engineering is a good fit;
  pure ML research, hardware, security, sales engineering etc. are not).
- 15: practicality: can the candidate realistically take this job?

location_eligible: true only if the candidate could actually work this role from where they live, per the posting
(on-site/hybrid in their country or city, or remote that is open to their country/time zone). Remote roles that are
restricted to other countries, or on-site roles elsewhere, are false. If the posting is silent, lean true for "Remote".

${UNTRUSTED_NOTE}
Keep matched_skills, red_flags and reasons short (max 5 items each, one line per item).`;

export async function scoreJob(
  llm: Llm,
  model: string,
  profile: Profile,
  job: Job,
  minScore: number,
): Promise<Score> {
  const description = job.description.slice(0, 12_000); // postings beyond this are boilerplate
  const out = await llm.json({
    model,
    system: SYSTEM,
    effort: "medium",
    schema: ScoreSchema,
    user:
      `<candidate>\n${profileToText(profile)}\n</candidate>\n\n` +
      `<job_posting>\nCompany: ${job.company}\nTitle: ${job.title}\nLocation: ${job.location}\n` +
      `Remote: ${job.remote ? "yes" : "unspecified/no"}\n\n${description}\n</job_posting>`,
  });

  const value = Math.max(0, Math.min(100, Math.round(out.score)));
  return {
    value,
    // The verdict is decided here, in code -- never by the model.
    verdict: value >= minScore && out.location_eligible ? "apply" : "skip",
    locationEligible: out.location_eligible,
    matchedSkills: out.matched_skills,
    redFlags: out.red_flags,
    reasons: out.reasons,
  };
}
