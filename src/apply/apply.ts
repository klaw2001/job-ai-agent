import fs from "node:fs";
import path from "node:path";
import type { Browser, Frame, Page } from "playwright";
import type { Profile } from "../config.js";
import { FatalLlmError, type Llm } from "../llm.js";
import { writeCoverLetter } from "../tailor/coverLetter.js";
import type { ApplyMode, Job, JobStatus } from "../types.js";
import { askLlmForFields, decideField, pickOption, worthAnswering } from "./mapper.js";
import { type Ctx, hasVisibleCaptcha, scanFields, setValue, tickConsent, uploadFile } from "./fill.js";
import type { Decision, FormField } from "./types.js";

export interface ApplyEnv {
  llm: Llm;
  model: string;
  profile: Profile;
  resumePath: string;
  browser: Browser;
  /** Asks the human a question in the terminal (review mode). */
  ask: (question: string) => Promise<string>;
  log?: (msg: string) => void;
  /** How long to wait for the application form to appear (default 25s). */
  formTimeoutMs?: number;
}

export interface ApplyOutcome {
  status: Extract<JobStatus, "dry_run" | "applied" | "submitted_unconfirmed" | "needs_human" | "failed">;
  notes: string[];
  unresolved: string[];
}

const CLOSED = /no longer (available|accepting)|position (has been|is) (filled|closed)|job (is )?(not found|closed)|this job has expired|page (you are looking for|not found)/i;
const CONFIRMED =
  /application (has been |was )?(successfully )?(submitted|received)|thank you for (applying|your application|submitting)|we(?:'ve| have) received your application|successfully submitted/i;

async function bodyText(frame: Frame): Promise<string> {
  try {
    return (await frame.evaluate("document.body ? document.body.innerText : ''")) as string;
  } catch {
    return "";
  }
}

async function allText(page: Page): Promise<string> {
  return (await Promise.all(page.frames().map(bodyText))).join("\n");
}

/** Polls every frame until a form with an e-mail or file field is on screen. */
async function waitForForm(page: Page, timeoutMs = 25_000): Promise<Ctx | null> {
  const deadline = Date.now() + timeoutMs;
  const probe =
    "Array.from(document.querySelectorAll('input[type=email], input[type=file], input[name*=email i], textarea')).some(" +
    "e => e.type === 'file' || (e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0))";
  while (Date.now() < deadline) {
    // Prefer an embedded ATS iframe (company career pages embed Greenhouse this way) over the host page.
    const frames = [...page.frames()].sort((a) => (a === page.mainFrame() ? 1 : -1));
    for (const frame of frames) {
      try {
        if ((await frame.evaluate(probe)) === true) return frame;
      } catch {
        /* navigating or cross-origin */
      }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function clickSubmit(ctx: Ctx): Promise<boolean> {
  const candidates = [
    ctx.getByRole("button", { name: /^\s*submit( application)?\s*$/i }),
    ctx.getByRole("button", { name: /submit/i }),
    ctx.locator('button[type="submit"], input[type="submit"]'),
    ctx.getByRole("button", { name: /^\s*apply( now)?\s*$/i }),
  ];
  for (const c of candidates) {
    const btn = c.last();
    if ((await c.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click({ timeout: 10_000 });
      return true;
    }
  }
  return false;
}

async function waitForConfirmation(page: Page, textBefore: string, urlBefore: string, formCtx: Ctx): Promise<boolean> {
  const hadConfirmText = CONFIRMED.test(textBefore);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(700);
    const text = await allText(page);
    if (!hadConfirmText && CONFIRMED.test(text)) return true;
    const formGone =
      (await formCtx.evaluate("document.querySelectorAll('input[type=email], input[type=file]').length").catch(() => 0)) === 0;
    if (page.url() !== urlBefore && formGone) return true;
  }
  return false;
}

export async function applyToJob(env: ApplyEnv, job: Job, mode: ApplyMode, dir: string): Promise<ApplyOutcome> {
  const log = env.log ?? (() => undefined);
  const notes: string[] = [];
  const unresolved: string[] = [];
  fs.mkdirSync(dir, { recursive: true });

  const finish = (status: ApplyOutcome["status"]): ApplyOutcome => ({ status, notes, unresolved });

  // 1. Cover letter (best effort: most forms don't require one).
  let letter: string | null = null;
  let letterPath: string | null = null;
  try {
    letter = await writeCoverLetter(env.llm, env.model, env.profile, job);
    letterPath = path.join(dir, "cover_letter.txt");
    fs.writeFileSync(letterPath, letter + "\n");
    notes.push("cover letter generated");
  } catch (e) {
    if (e instanceof FatalLlmError) throw e;
    notes.push(`cover letter skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  const context = await env.browser.newContext({ viewport: { width: 1280, height: 1700 }, locale: "en-IN" });
  const page = await context.newPage();
  const shot = (name: string) => page.screenshot({ path: path.join(dir, name), fullPage: true }).catch(() => undefined);

  try {
    log(`opening ${job.applyUrl}`);
    await page.goto(job.applyUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });

    const ctx = await waitForForm(page, env.formTimeoutMs);
    if (!ctx) {
      await shot("no_form.png");
      notes.push(CLOSED.test(await allText(page)) ? "posting appears to be closed" : "no application form found on the page");
      return finish("failed");
    }

    // 2. Scan + decide
    const fields = await scanFields(ctx);
    log(`found ${fields.length} fields`);
    const decisions = new Map<string, Decision>(fields.map((f) => [f.id, decideField(f, env.profile)]));

    const pending = fields.filter((f) => decisions.get(f.id)?.kind === "ask_llm");
    const toAsk = pending.filter(worthAnswering);
    for (const f of pending.filter((x) => !toAsk.includes(x))) decisions.set(f.id, { kind: "skip", reason: "optional" });
    if (toAsk.length) {
      let answers = new Map<string, string | null>();
      try {
        answers = await askLlmForFields(env.llm, env.model, env.profile, job, toAsk);
      } catch (e) {
        if (e instanceof FatalLlmError) throw e;
        notes.push(`LLM could not answer questions: ${e instanceof Error ? e.message : String(e)}`);
      }
      for (const f of toAsk) {
        const ans = answers.get(f.id) ?? null;
        decisions.set(
          f.id,
          ans
            ? { kind: "value", value: ans, source: "llm" }
            : f.required
              ? { kind: "unresolved", reason: `no grounded answer for "${f.label}"` }
              : { kind: "skip", reason: "no grounded answer" },
        );
      }
    }

    // 3. Fill
    for (const f of fields) {
      const d = decisions.get(f.id) as Decision;
      try {
        await applyDecision(ctx, f, d, env.resumePath, letter, letterPath, notes, unresolved);
      } catch (e) {
        const why = e instanceof Error ? e.message.split("\n")[0] : String(e);
        if (f.required) unresolved.push(`${f.label || f.name}: could not fill (${why})`);
        else notes.push(`skipped optional "${f.label}": ${why}`);
      }
    }

    fs.writeFileSync(
      path.join(dir, "fields.json"),
      JSON.stringify(fields.map((f) => ({ label: f.label, kind: f.kind, required: f.required, decision: decisions.get(f.id)?.kind })), null, 2),
    );
    await shot("filled.png");
    const captcha = await hasVisibleCaptcha(page);
    if (captcha) notes.push("a captcha is on the page");

    // 4. Mode
    if (mode === "dry-run") return finish(unresolved.length ? "needs_human" : "dry_run");

    if (mode === "review") {
      console.log(`\nForm filled for ${job.company} -- ${job.title}. Review it in the browser window.`);
      if (unresolved.length) console.log(`Needs you:\n  - ${unresolved.join("\n  - ")}`);
      const answer = await env.ask("Submit it yourself in the browser, then type 'y' here (anything else = not submitted): ");
      if (answer.trim().toLowerCase().startsWith("y")) {
        notes.push("submitted manually after review");
        return finish("applied");
      }
      return finish(unresolved.length ? "needs_human" : "dry_run");
    }

    // mode === "auto"
    if (unresolved.length) return finish("needs_human");
    if (captcha) return finish("needs_human");

    const textBefore = await allText(page);
    const urlBefore = page.url();
    if (!(await clickSubmit(ctx))) {
      notes.push("could not find a submit button");
      return finish("needs_human");
    }
    const ok = await waitForConfirmation(page, textBefore, urlBefore, ctx);
    await shot("after_submit.png");
    if (ok) return finish("applied");
    if (await hasVisibleCaptcha(page)) {
      notes.push("a captcha appeared after clicking submit");
      return finish("needs_human");
    }
    const errors = (await ctx.evaluate("document.querySelectorAll(':invalid, [aria-invalid=true]').length").catch(() => 0)) as number;
    if (errors > 0) {
      notes.push(`form shows ${errors} invalid field(s) after submit`);
      return finish("needs_human");
    }
    notes.push("clicked submit but saw no confirmation -- check your e-mail / the company's portal");
    return finish("submitted_unconfirmed");
  } catch (e) {
    if (e instanceof FatalLlmError) throw e;
    await shot("error.png");
    notes.push(`error: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    return finish("failed");
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function applyDecision(
  ctx: Ctx,
  f: FormField,
  d: Decision,
  resumePath: string,
  letter: string | null,
  letterPath: string | null,
  notes: string[],
  unresolved: string[],
): Promise<void> {
  const need = (reason: string) => {
    if (f.required) unresolved.push(`${f.label || f.name}: ${reason}`);
    else notes.push(`left empty "${f.label}": ${reason}`);
  };

  switch (d.kind) {
    case "value": {
      let value = d.value;
      if (f.options.length && (f.kind === "select" || f.kind === "radio" || f.kind === "combobox")) {
        const opt = pickOption(f.options, value);
        if (!opt) return need(`no option matches "${value}"`);
        value = opt;
      }
      await setValue(ctx, f, value);
      notes.push(`${f.label}: filled (${d.source})`);
      return;
    }
    case "file":
      if (d.which === "resume") await uploadFile(ctx, f, resumePath);
      else if (letterPath) await uploadFile(ctx, f, letterPath);
      else return need("no cover letter available");
      notes.push(`${f.label}: uploaded ${d.which}`);
      return;
    case "cover_letter_text":
      if (!letter) return need("no cover letter available");
      await setValue(ctx, f, letter);
      notes.push(`${f.label}: cover letter pasted`);
      return;
    case "consent":
      await tickConsent(ctx, f);
      notes.push(`${f.label}: consent ticked (required by the form)`);
      return;
    case "skip":
      notes.push(`left empty "${f.label}": ${d.reason}`);
      return;
    case "unresolved":
      unresolved.push(`${f.label || f.name}: ${d.reason}`);
      return;
    case "ask_llm":
      return;
  }
}
