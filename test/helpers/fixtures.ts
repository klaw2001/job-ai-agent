import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { ProfileSchema, ROOT, type Profile } from "../../src/config.js";
import type { Llm } from "../../src/llm.js";
import type { Job } from "../../src/types.js";

/** The fictional "Jane Doe" example profile -- tests never touch real personal data. */
export function testProfile(over: Partial<Profile> = {}): Profile {
  const raw = parse(fs.readFileSync(path.join(ROOT, "profile", "profile.example.yaml"), "utf8"));
  return { ...ProfileSchema.parse(raw), ...over };
}

export function dummyResume(): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ja-resume-")), "resume.pdf");
  fs.writeFileSync(f, "%PDF-1.4\n% dummy resume for tests\n%%EOF\n");
  return f;
}

export const LETTER = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");

export function testJob(applyUrl: string, over: Partial<Job> = {}): Job {
  return {
    id: "greenhouse:acme:1",
    ats: "greenhouse",
    board: "acme",
    company: "Acme",
    title: "Full Stack Engineer",
    location: "Mumbai, India",
    remote: false,
    url: applyUrl,
    applyUrl,
    description: "Build products with Node.js and Vue.",
    postedAt: null,
    ...over,
  };
}

/** Deterministic stand-in for Claude; records every form question it is asked. */
export function fakeLlm(): { llm: Llm; asked: string[] } {
  const asked: string[] = [];
  const llm: Llm = {
    async json(req) {
      if (req.system.includes("cover letters")) return { letter: LETTER } as never;
      if (req.system.includes("fill in a job application")) {
        const questions = JSON.parse(String(req.user).split("Questions (JSON):\n")[1] as string) as Array<{ id: string; question: string }>;
        asked.push(...questions.map((q) => q.question));
        return {
          answers: questions.map((q) => ({
            id: q.id,
            answer: /why do you want/i.test(q.question)
              ? "Because I build full-stack products end to end."
              : /years of experience.*node/i.test(q.question)
                ? "3"
                : null,
          })),
        } as never;
      }
      throw new Error("unexpected LLM call: " + req.system.slice(0, 60));
    },
  };
  return { llm, asked };
}
