import { describe, expect, it } from "vitest";
import { decideField, pickOption } from "../src/apply/mapper.js";
import type { FormField } from "../src/apply/types.js";
import { testProfile } from "./helpers/fixtures.js";

const field = (over: Partial<FormField>): FormField => ({
  id: "ja-0",
  kind: "text",
  label: "",
  required: true,
  options: [],
  inputType: "text",
  name: "",
  ...over,
});

const p = testProfile();

describe("decideField: identity", () => {
  it.each([
    ["First Name", "Jane"],
    ["Last Name", "Doe"],
    ["Full name", "Jane Doe"],
    ["Name", "Jane Doe"],
    ["Preferred first name", "Jane"],
  ])("%s -> %s", (label, value) => {
    expect(decideField(field({ label }), p)).toMatchObject({ kind: "value", value });
  });

  it("does NOT answer 'Name of your current employer' with the candidate's own name", () => {
    expect(decideField(field({ label: "Name of your current employer" }), p)).not.toMatchObject({ value: "Jane Doe" });
  });

  it("uses the input type for e-mail and phone even when the label is odd", () => {
    expect(decideField(field({ label: "Contact", inputType: "email" }), p)).toMatchObject({ value: "jane@example.com" });
    expect(decideField(field({ label: "Reach me on", inputType: "tel" }), p)).toMatchObject({ value: p.phone });
  });

  it("current company/title come from the job marked Present", () => {
    expect(decideField(field({ label: "Current company" }), p)).toMatchObject({ value: "Example Co" });
    expect(decideField(field({ label: "Current job title" }), p)).toMatchObject({ value: "Full Stack Developer" });
  });
});

describe("decideField: never guesses sensitive facts", () => {
  it.each([
    "Are you legally authorized to work in the United States?",
    "Will you now or in the future require visa sponsorship?",
    "Do you have a criminal record?",
    "Are you a protected veteran?",
    "What is your date of birth?",
    "Who referred you?",
  ])("%s -> unresolved when required", (label) => {
    expect(decideField(field({ label }), p).kind).toBe("unresolved");
  });

  it("optional sensitive questions are skipped, not sent to the LLM", () => {
    expect(decideField(field({ label: "Are you legally authorized to work in India?", required: false }), p).kind).toBe("skip");
  });

  it("salary / notice period come only from profile.answers", () => {
    expect(decideField(field({ label: "Expected salary" }), p).kind).toBe("unresolved");
    const withAnswers = testProfile();
    withAnswers.answers.expected_salary = "25 LPA";
    withAnswers.answers.notice_period = "30 days";
    expect(decideField(field({ label: "Expected salary" }), withAnswers)).toMatchObject({ value: "25 LPA" });
    expect(decideField(field({ label: "Notice period" }), withAnswers)).toMatchObject({ value: "30 days" });
  });

  it("boolean answers become Yes/No, null stays unresolved", () => {
    const q = field({ label: "Are you open to relocation?", kind: "radio", options: ["Yes", "No"] });
    expect(decideField(q, p).kind).toBe("unresolved");
    const willing = testProfile();
    willing.answers.willing_to_relocate = false;
    expect(decideField(q, willing)).toMatchObject({ kind: "value", value: "No" });
  });

  it("custom_answers beat every other rule, first match wins", () => {
    const prof = testProfile({
      custom_answers: [
        { match: "authori[sz]ed to work in india", answer: "Yes" },
        { match: "authori[sz]ed", answer: "No" },
      ],
    });
    expect(decideField(field({ label: "Are you legally authorized to work in India?" }), prof)).toMatchObject({
      kind: "value",
      value: "Yes",
      source: "custom",
    });
  });
});

describe("decideField: demographics, consent, files", () => {
  it("picks the 'decline' option for EEO questions and never guesses", () => {
    const g = field({ label: "Gender", kind: "select", required: false, options: ["Male", "Female", "I don't wish to answer"] });
    expect(decideField(g, p)).toMatchObject({ kind: "value", value: "I don't wish to answer" });
    expect(decideField({ ...g, options: ["Male", "Female"] }, p).kind).toBe("skip");
    expect(decideField({ ...g, required: true, options: ["Male", "Female"] }, p).kind).toBe("unresolved");
  });

  it("'race' must be a whole word (does not trigger on 'embrace')", () => {
    expect(decideField(field({ label: "Tell us how you embrace change", kind: "textarea" }), p).kind).toBe("ask_llm");
  });

  it("ticks only REQUIRED consent boxes", () => {
    const box = (over: Partial<FormField>) => field({ kind: "checkbox", inputType: "checkbox", ...over });
    expect(decideField(box({ label: "I agree to the Privacy Policy" }), p).kind).toBe("consent");
    expect(decideField(box({ label: "I agree to the Privacy Policy", required: false }), p).kind).toBe("skip");
    expect(decideField(box({ label: "Send me marketing e-mails" }), p).kind).toBe("unresolved");
  });

  it("routes file inputs", () => {
    const f = (label: string, required = true) => decideField(field({ kind: "file", label, required }), p);
    expect(f("Resume/CV")).toEqual({ kind: "file", which: "resume" });
    expect(f("Cover Letter", false)).toEqual({ kind: "file", which: "cover_letter" });
    expect(f("Portfolio PDF").kind).toBe("unresolved");
    expect(f("Transcript", false).kind).toBe("skip");
  });

  it("missing LinkedIn is left empty, not invented", () => {
    expect(decideField(field({ label: "LinkedIn Profile", required: false }), p).kind).toBe("skip");
  });

  it("open-ended questions go to the LLM", () => {
    expect(decideField(field({ label: "Why do you want to work here?", kind: "textarea" }), p).kind).toBe("ask_llm");
  });
});

describe("pickOption", () => {
  const opts = ["United States", "India", "India (+91)", "Decline to self-identify"];
  it("prefers exact, then prefix/contains, then option-contained-in-value", () => {
    expect(pickOption(opts, "india")).toBe("India");
    expect(pickOption(["India (+91)", "United States (+1)"], "India")).toBe("India (+91)");
    expect(pickOption(["Mumbai", "Pune"], "Mumbai, Maharashtra, India")).toBe("Mumbai");
    expect(pickOption(opts, "Atlantis")).toBeNull();
    expect(pickOption(opts, "")).toBeNull();
  });
});
