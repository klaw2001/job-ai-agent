import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { models, paths } from "./config.js";
import type { Llm } from "./llm.js";

// No defaults / optional-with-transform here: this schema is sent to the API as the output format.
const ExtractSchema = z.object({
  first_name: z.string(),
  last_name: z.string(),
  email: z.string(),
  phone: z.string(),
  city: z.string(),
  region: z.string().describe("State/province, or empty string if not on the resume"),
  country: z.string(),
  website: z.string().describe("Empty string if not on the resume"),
  linkedin: z.string().describe("Empty string if not on the resume"),
  github: z.string().describe("Empty string if not on the resume"),
  headline: z.string(),
  summary: z.string(),
  years_experience: z.number(),
  skills: z.array(z.object({ group: z.string(), items: z.array(z.string()) })),
  experience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      start: z.string().describe("YYYY-MM"),
      end: z.string().describe("YYYY-MM or the word Present"),
      bullets: z.array(z.string()),
    }),
  ),
  education: z.array(z.object({ school: z.string(), degree: z.string(), start: z.string(), end: z.string() })),
});

const SYSTEM = `Extract the candidate's details from the attached resume PDF into the requested structure.
Copy facts exactly as written; never infer, embellish or add anything that is not on the page.
Use an empty string for any link or field that does not appear on the resume (do NOT guess LinkedIn/GitHub URLs).
Keep every experience bullet as written (you may join a bullet that was wrapped across lines).
Skills: keep the resume's own groupings. years_experience: the figure the resume states (e.g. "3+ years" -> 3).`;

export async function buildProfileFromResume(llm: Llm, resumePath: string, outPath = paths.profile): Promise<string> {
  const pdf = fs.readFileSync(resumePath).toString("base64");
  const r = await llm.json({
    model: models.main(),
    system: SYSTEM,
    effort: "medium",
    schema: ExtractSchema,
    maxTokens: 8000,
    user: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } },
      { type: "text", text: "Extract this resume." },
    ],
  });

  const links = Object.fromEntries(
    Object.entries({ website: r.website, linkedin: r.linkedin, github: r.github }).filter(([, v]) => v.trim()),
  );
  const profile = {
    name: { first: r.first_name, last: r.last_name },
    email: r.email,
    phone: r.phone,
    location: { city: r.city, ...(r.region ? { region: r.region } : {}), country: r.country },
    links,
    headline: r.headline,
    summary: r.summary,
    years_experience: r.years_experience,
    skills: Object.fromEntries(r.skills.map((s) => [s.group, s.items])),
    experience: r.experience,
    education: r.education,
    answers: {
      notice_period: null,
      expected_salary: null,
      current_salary: null,
      willing_to_relocate: null,
      requires_sponsorship: null,
    },
    custom_answers: [],
  };

  const header =
    "# Generated from your resume. Review it -- everything the agent says about you comes from this file.\n" +
    "# Fill in `answers` yourself: they are not on a resume and are never guessed.\n";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, header + stringify(profile, { lineWidth: 100 }));
  return outPath;
}
