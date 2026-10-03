import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyToJob, type ApplyEnv } from "../src/apply/apply.js";
import { launchBrowser } from "../src/apply/fill.js";
import type { Profile } from "../src/config.js";
import type { ApplyMode } from "../src/types.js";
import { dummyResume, fakeLlm, testJob, testProfile } from "./helpers/fixtures.js";
import { startMockSite } from "./helpers/mockSite.js";

// Needs a Chromium: `npx playwright install chromium`, or set BROWSER_EXECUTABLE_PATH.
let browser: Browser;
let site: Awaited<ReturnType<typeof startMockSite>>;
const resumePath = dummyResume();

beforeAll(async () => {
  browser = await launchBrowser(true);
  site = await startMockSite();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await site?.close();
});
beforeEach(() => {
  site.submissions.length = 0;
});

async function run(
  route: string,
  mode: ApplyMode,
  opts: { profile?: Profile; ask?: string; closed?: boolean } = {},
) {
  const { llm, asked } = fakeLlm();
  const env: ApplyEnv = {
    llm,
    model: "test",
    profile: opts.profile ?? testProfile(),
    resumePath,
    browser,
    ask: async () => opts.ask ?? "n",
    formTimeoutMs: 3000,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ja-app-"));
  const outcome = await applyToJob(env, testJob(site.url + route), mode, dir);
  return { outcome, asked, dir };
}

describe("dry-run mode", () => {
  it("fills a Greenhouse-style form, saves a screenshot and NEVER submits", async () => {
    const { outcome, dir } = await run("/greenhouse", "dry-run");
    expect(outcome.unresolved).toEqual([]);
    expect(outcome.status).toBe("dry_run");
    expect(site.submissions).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "filled.png"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "cover_letter.txt"), "utf8")).toContain("word0");
  }, 60_000);
});

describe("auto mode", () => {
  it("fills every field of a Greenhouse-style form from the profile, then submits and sees the confirmation", async () => {
    const { outcome, asked } = await run("/greenhouse", "auto");
    expect(outcome.unresolved).toEqual([]);
    expect(outcome.status).toBe("applied");
    expect(site.submissions).toHaveLength(1);
    expect(site.submissions[0]?.data).toMatchObject({
      first_name: "Jane",
      last_name: "Doe",
      email: "jane@example.com",
      phone: "+91 90000 00000",
      resume: "file:resume.pdf",
      website: "https://example.com",
      loc: "Mumbai", // custom dropdown: option picked from the list the page offered
      country: "India",
      why: "Because I build full-stack products end to end.",
      node_years: "3",
      gender: "Decline to self-identify", // demographic question -> "decline", never a guess
      privacy: "on", // required consent box
    });
    expect(site.submissions[0]?.data.linkedin).toBe(""); // not in profile -> left empty, not invented
    // Only genuinely open questions reach the LLM -- identity/country/gender are handled by rules.
    expect(asked.sort()).toEqual(
      ["How many years of experience do you have with Node.js?", "Why do you want to work at Acme?"].sort(),
    );
  }, 60_000);

  it("handles Lever-style wrapper labels and uses custom_answers for the authorization question", async () => {
    const profile = testProfile({ custom_answers: [{ match: "authori[sz]ed to work in india", answer: "Yes" }] });
    const { outcome } = await run("/lever", "auto", { profile });
    expect(outcome.status).toBe("applied");
    expect(site.submissions[0]?.data).toMatchObject({
      name: "Jane Doe",
      email: "jane@example.com",
      org: "Example Co", // "Current company" from the most recent job
      resume: "file:resume.pdf",
      "cards[auth]": "Yes",
    });
  }, 60_000);

  it("clicks Yes/No button pairs (Ashby-style) when the profile has an answer", async () => {
    const profile = testProfile({ custom_answers: [{ match: "mumbai office", answer: "Yes" }] });
    const { outcome } = await run("/ashby", "auto", { profile });
    expect(outcome.status).toBe("applied");
    expect(site.submissions[0]?.data).toMatchObject({
      _systemfield_name: "Jane Doe",
      _systemfield_email: "jane@example.com",
      office_ok: "Yes",
    });
  }, 60_000);

  it("refuses to guess work authorization: stops, submits nothing, and says why", async () => {
    const { outcome, asked } = await run("/greenhouse-auth", "auto");
    expect(outcome.status).toBe("needs_human");
    expect(outcome.unresolved.join("\n")).toMatch(/legally authorized to work in India/i);
    expect(site.submissions).toHaveLength(0);
    expect(asked.join("\n")).not.toMatch(/authorized/i); // sensitive questions never go to the LLM
  }, 60_000);

  it("refuses to guess salary unless the profile provides it", async () => {
    const blocked = await run("/greenhouse-salary", "auto");
    expect(blocked.outcome.status).toBe("needs_human");
    expect(blocked.outcome.unresolved.join("\n")).toMatch(/expected_salary not set/);
    expect(blocked.asked.join("\n")).not.toMatch(/salary/i);
    expect(site.submissions).toHaveLength(0);

    const profile = testProfile();
    profile.answers.expected_salary = "25 LPA";
    const ok = await run("/greenhouse-salary", "auto", { profile });
    expect(ok.outcome.status).toBe("applied");
    expect(site.submissions[0]?.data.salary).toBe("25 LPA");
  }, 90_000);

  it("stops at an e-mailed verification code (only the human can read the inbox)", async () => {
    const { outcome } = await run("/greenhouse-code", "auto");
    expect(outcome.status).toBe("needs_human");
    expect(outcome.unresolved.join("\n")).toMatch(/verification code/);
    expect(site.submissions).toHaveLength(0);
  }, 60_000);

  it("does not submit when a visible captcha is on the page", async () => {
    const { outcome } = await run("/captcha", "auto");
    expect(outcome.status).toBe("needs_human");
    expect(outcome.notes.join("\n")).toMatch(/captcha/);
    expect(site.submissions).toHaveLength(0);
  }, 60_000);

  it("reports a missing form instead of crashing", async () => {
    const { outcome } = await run("/closed", "auto");
    expect(outcome.status).toBe("failed");
    expect(outcome.notes.join("\n")).toMatch(/posting appears to be closed|no application form/i);
  }, 60_000);
});

describe("review mode", () => {
  it("never clicks submit itself; records 'applied' only if the human says they submitted", async () => {
    const yes = await run("/greenhouse", "review", { ask: "y" });
    expect(yes.outcome.status).toBe("applied");
    expect(yes.outcome.notes.join("\n")).toMatch(/submitted manually/);
    const no = await run("/greenhouse", "review", { ask: "n" });
    expect(no.outcome.status).toBe("dry_run");
    expect(site.submissions).toHaveLength(0); // the agent itself never submitted
  }, 90_000);
});
