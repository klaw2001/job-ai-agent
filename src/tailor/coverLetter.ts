import { z } from "zod";
import type { Profile } from "../config.js";
import { type Llm, UNTRUSTED_NOTE } from "../llm.js";
import { profileToText } from "../profileText.js";
import type { Job } from "../types.js";

const LetterSchema = z.object({ letter: z.string() });

const SYSTEM = `You write short, honest cover letters for a software engineer.

Hard rules:
- Use ONLY facts present in <candidate>. Never invent employers, projects, metrics, numbers, tools, degrees or years.
  If the posting asks for something the candidate has not done, simply do not claim it.
- 150-220 words, first person, plain confident tone. No clichés ("passionate", "I am writing to apply",
  "dynamic", "team player"), no bullet lists, no placeholders like [Company] or [Your Name].
- Name the company and the exact role once. Connect 2-3 of the candidate's real projects/skills to what the role needs.
- End with a one-line sign-off using the candidate's full name.

${UNTRUSTED_NOTE}`;

export async function writeCoverLetter(llm: Llm, model: string, profile: Profile, job: Job): Promise<string> {
  const { letter } = await llm.json({
    model,
    system: SYSTEM,
    effort: "medium",
    schema: LetterSchema,
    user:
      `<candidate>\n${profileToText(profile)}\n</candidate>\n\n` +
      `<job_posting>\nCompany: ${job.company}\nTitle: ${job.title}\nLocation: ${job.location}\n\n` +
      `${job.description.slice(0, 8000)}\n</job_posting>`,
  });
  return validateLetter(letter);
}

export function validateLetter(raw: string): string {
  const letter = raw.trim();
  if (/\[[^\]]{1,40}\]/.test(letter)) throw new Error("Cover letter contains an unfilled [placeholder]");
  const words = letter.split(/\s+/).length;
  if (words < 80 || words > 320) throw new Error(`Cover letter has ${words} words (expected ~150-220)`);
  return letter;
}
