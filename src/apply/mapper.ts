import { z } from "zod";
import type { Profile } from "../config.js";
import { type Llm, UNTRUSTED_NOTE } from "../llm.js";
import { profileToText } from "../profileText.js";
import type { Job } from "../types.js";
import type { Decision, FormField } from "./types.js";

/** Questions with legal/personal weight: answered ONLY from the profile or custom_answers, never by the LLM. */
const SENSITIVE =
  /authori[sz]|work permit|right to work|eligible to work|legally|\bvisa\b|sponsor|immigration|citizen|salary|compensation|\bctc\b|notice period|gender|\bsex\b|\brace\b|ethnic|hispanic|latino|veteran|disabilit|sexual|orientation|transgender|pronoun|criminal|convict|felony|background check|clearance|drug|date of birth|\bdob\b|\bage\b|religio|marital|referr/i;

const EEO =
  /gender|\bsex\b|\brace\b|ethnic|hispanic|latino|veteran|disabilit|sexual|orientation|transgender|pronoun|religio|marital/i;

const DECLINE = /decline|prefer not|do not wish|don'?t wish|rather not|not to (say|answer|disclose|identify)|choose not/i;

const CONSENT =
  /privacy|terms|consent|i agree|agree to|acknowledge|gdpr|data (processing|protection)|candidate (privacy|data)|certify|accurate/i;

const fullName = (p: Profile) => `${p.name.first} ${p.name.last}`;
const place = (p: Profile) => [p.location.city, p.location.region, p.location.country].filter(Boolean).join(", ");

function yesNo(v: boolean | null): string | null {
  return v === null ? null : v ? "Yes" : "No";
}

/** Pick the option that best matches `want` (exact, then contains, either direction). */
export function pickOption(options: string[], want: string): string | null {
  const w = want.trim().toLowerCase();
  if (!w) return null;
  const lower = options.map((o) => o.toLowerCase().trim());
  let i = lower.indexOf(w);
  if (i < 0) i = lower.findIndex((o) => o.startsWith(w) || o.includes(w));
  if (i < 0) i = lower.findIndex((o) => o.length > 1 && w.includes(o));
  return i >= 0 ? (options[i] as string) : null;
}

/**
 * Deterministic part of the mapping. Returns `ask_llm` only for fields that are not sensitive and that no
 * rule could answer.
 */
export function decideField(f: FormField, p: Profile): Decision {
  const label = f.label.toLowerCase();
  const name = f.name.toLowerCase();
  const text = `${label} ${name}`;
  const needs = (reason: string): Decision =>
    f.required ? { kind: "unresolved", reason } : { kind: "skip", reason };

  // --- files -------------------------------------------------------------------------------
  if (f.kind === "file") {
    if (/cover/.test(text)) return { kind: "file", which: "cover_letter" };
    if (/resume|\bcv\b|curriculum/.test(text) || f.label === "") return { kind: "file", which: "resume" };
    return needs(`file upload "${f.label}"`);
  }

  // --- the user's own answers always win --------------------------------------------------------
  for (const c of p.custom_answers) {
    if (new RegExp(c.match, "i").test(f.label)) return { kind: "value", value: c.answer, source: "custom" };
  }

  // --- consent boxes: tick only when the form forces it ---------------------------------------------
  if (f.kind === "checkbox") {
    return f.required && CONSENT.test(label) ? { kind: "consent" } : needs(`checkbox "${f.label}"`);
  }

  // --- demographic (EEO) questions: choose "decline to answer" if offered, otherwise leave blank -----
  if (EEO.test(text)) {
    const decline = f.options.find((o) => DECLINE.test(o));
    if (decline) return { kind: "value", value: decline, source: "default" };
    return needs(`demographic question "${f.label}" (no decline option)`);
  }

  // --- codes e-mailed to the candidate during submission: only a human can read the inbox ----------------
  if (/security code|verification code|one[- ]time (code|password)|\botp\b/.test(text)) {
    return needs("a verification code is e-mailed during submission");
  }

  // --- identity ------------------------------------------------------------------------------------
  const v = (value: string, source: "profile" | "default" = "profile"): Decision => ({ kind: "value", value, source });
  if (/first name|given name|\bfname\b|preferred (first )?name/.test(text)) return v(p.name.first);
  if (/last name|surname|family name|\blname\b/.test(text)) return v(p.name.last);
  if (/^(full |legal |your |candidate )?name$/.test(label) || /\b(full|legal|your) name\b/.test(label) || name === "_systemfield_name") {
    return v(fullName(p));
  }
  if (f.inputType === "email" || /e-?mail/.test(text)) return v(p.email);
  if (f.inputType === "tel" || /phone|mobile|contact number/.test(text)) return v(p.phone);
  if (/linkedin/.test(text)) return p.links.linkedin ? v(p.links.linkedin) : needs("LinkedIn URL not in profile");
  if (/github/.test(text)) return p.links.github ? v(p.links.github) : needs("GitHub URL not in profile");
  if (/website|portfolio|personal (site|url)|^url\b|other (site|link)/.test(text)) {
    return p.links.website ? v(p.links.website) : needs("website not in profile");
  }
  if (/^country\b|country of (residence|current)/.test(label)) return v(p.location.country);
  if (/\bcity\b|current location|where are you (currently )?(based|located)|^location\b|location \(city\)/.test(text)) {
    return v(place(p));
  }
  const current = p.experience.find((e) => /present|current/i.test(e.end));
  if (/current (company|employer)|present (company|employer)/.test(text)) {
    return current ? v(current.company) : needs("no current employer in profile");
  }
  if (/current (title|role|position|job)/.test(text)) {
    return current ? v(current.title) : needs("no current title in profile");
  }

  // --- facts the user must supply (never guessed) ---------------------------------------------------
  const a = p.answers;
  if (/notice period/.test(text)) return a.notice_period ? v(a.notice_period) : needs("notice_period not set in profile");
  if (/(expected|desired|target).*(salary|ctc|compensation)|salary expectation/.test(text)) {
    return a.expected_salary ? v(a.expected_salary) : needs("expected_salary not set in profile");
  }
  if (/current.*(salary|ctc|compensation)/.test(text)) {
    return a.current_salary ? v(a.current_salary) : needs("current_salary not set in profile");
  }
  if (/relocat/.test(text)) {
    const yn = yesNo(a.willing_to_relocate);
    return yn ? v(yn) : needs("willing_to_relocate not set in profile");
  }
  if (/sponsor/.test(text)) {
    const yn = yesNo(a.requires_sponsorship);
    return yn ? v(yn) : needs("requires_sponsorship not set in profile");
  }
  if (/how did you (hear|find)|where did you (hear|find)|hear about (us|this)|referral source|lead source/.test(label)) {
    // True for anyone using this tool: they found the role on the company's own careers board.
    return v("Company careers page", "default");
  }

  // --- cover letter pasted into a text box -------------------------------------------------------------
  if (f.kind === "textarea" && /cover letter/.test(label)) return { kind: "cover_letter_text" };

  // --- anything else sensitive is never sent to the LLM ---------------------------------------------------
  if (SENSITIVE.test(text)) return needs(`sensitive question "${f.label}" -- add it to custom_answers`);

  return { kind: "ask_llm" };
}

// ---------------------------------------------------------------------------------------------------
// LLM answers for the remaining, non-sensitive questions
// ---------------------------------------------------------------------------------------------------

const AnswersSchema = z.object({
  answers: z.array(z.object({ id: z.string(), answer: z.string().nullable() })),
});

const SYSTEM = `You fill in a job application form on behalf of the candidate described in <candidate>.

Rules:
- Use ONLY facts from <candidate>. If the profile does not clearly support an answer, return null for that id.
  Never invent employers, numbers, tools, certifications or years of experience with a specific technology
  (if the profile does not list a technology, the candidate has no stated experience with it: return null).
- For select / radio / combobox fields, "answer" must be EXACTLY one of the listed options.
- For numeric inputs answer with digits only.
- Short-answer text: 1-3 sentences. Longer free-text ("why do you want this job", "tell us about..."): 60-120 words,
  first person, specific to this company and role, drawn from the candidate's real experience.
- Do not answer anything about work authorisation, visa, salary, notice period, demographics or legal status.

${UNTRUSTED_NOTE}`;

export async function askLlmForFields(
  llm: Llm,
  model: string,
  p: Profile,
  job: Job,
  fields: FormField[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (fields.length === 0) return result;

  const questions = fields.map((f) => ({
    id: f.id,
    question: f.label,
    type: f.kind === "text" ? f.inputType : f.kind,
    ...(f.options.length ? { options: f.options.slice(0, 60) } : {}),
    required: f.required,
  }));

  const out = await llm.json({
    model,
    system: SYSTEM,
    effort: "medium",
    schema: AnswersSchema,
    user:
      `<candidate>\n${profileToText(p)}\n</candidate>\n\n` +
      `<job_posting>\nCompany: ${job.company}\nTitle: ${job.title}\n\n${job.description.slice(0, 5000)}\n</job_posting>\n\n` +
      `Questions (JSON):\n${JSON.stringify(questions, null, 2)}`,
  });

  for (const f of fields) {
    const raw = out.answers.find((x) => x.id === f.id)?.answer ?? null;
    if (raw === null || !raw.trim()) {
      result.set(f.id, null);
    } else if (f.options.length) {
      // Never trust the model to stay within the option list.
      result.set(f.id, pickOption(f.options, raw));
    } else {
      result.set(f.id, raw.trim());
    }
  }
  return result;
}

/** Optional free-text questions worth spending an LLM call on ("cover letter", "why us"); other optionals stay empty. */
export function worthAnswering(f: FormField): boolean {
  if (f.required) return true;
  return f.kind === "textarea" && /why|cover letter|tell us|describe|motivat/i.test(f.label);
}
