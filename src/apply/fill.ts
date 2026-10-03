import { chromium, type Browser, type Frame, type Locator, type Page } from "playwright";
import { EXTRACT_SCRIPT, VISIBLE_CAPTCHA_SCRIPT } from "./pageScripts.js";
import type { FormField } from "./types.js";

export type Ctx = Page | Frame;

export async function launchBrowser(headless: boolean): Promise<Browser> {
  const executablePath = process.env.BROWSER_EXECUTABLE_PATH || undefined;
  // Chromium refuses to start as root (containers, CI) unless its sandbox is disabled.
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  return chromium.launch({ headless, executablePath, args: asRoot ? ["--no-sandbox"] : [] });
}

const byId = (ctx: Ctx, id: string): Locator => ctx.locator(`[data-ja-id="${id}"]`);

/** Reads all fields on the form, plus the option list of custom dropdown (combobox) fields. */
export async function scanFields(ctx: Ctx): Promise<FormField[]> {
  const fields = (await ctx.evaluate(EXTRACT_SCRIPT)) as FormField[];
  for (const f of fields) {
    if (f.kind !== "combobox") continue;
    const loc = byId(ctx, f.id).first();
    try {
      await loc.click({ timeout: 2000 });
      await ctx.waitForTimeout(250);
      const opts = await ctx.locator('[role="option"]').allInnerTexts();
      f.options = opts.map((o) => o.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 80);
      await loc.press("Escape", { timeout: 1000 }).catch(() => undefined);
    } catch {
      f.options = [];
    }
  }
  return fields;
}

export async function hasVisibleCaptcha(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      if ((await frame.evaluate(VISIBLE_CAPTCHA_SCRIPT)) === true) return true;
    } catch {
      /* cross-origin or detached frame */
    }
  }
  return false;
}

export async function setValue(ctx: Ctx, f: FormField, value: string): Promise<void> {
  const loc = byId(ctx, f.id).first();
  switch (f.kind) {
    case "text":
    case "textarea":
      await loc.fill(value, { timeout: 5000 });
      return;
    case "select":
      try {
        await loc.selectOption({ label: value }, { timeout: 5000 });
      } catch {
        await loc.selectOption({ value }, { timeout: 5000 });
      }
      return;
    case "combobox": {
      await loc.click({ timeout: 5000 });
      await loc.pressSequentially(value.slice(0, 40), { delay: 15 });
      await ctx.waitForTimeout(350);
      const option = ctx.locator('[role="option"]').filter({ hasText: value }).first();
      if (await option.count()) await option.click({ timeout: 3000 });
      else await loc.press("Enter");
      return;
    }
    case "radio": {
      const idx = f.options.findIndex((o) => o === value);
      if (idx < 0) throw new Error(`option "${value}" not found`);
      const opt = ctx.locator(`[data-ja-id="${f.id}"][data-ja-opt="${idx}"]`).first();
      if (f.inputType === "buttons") {
        await opt.click({ timeout: 5000 });
        return;
      }
      try {
        await opt.check({ force: true, timeout: 3000 });
      } catch {
        await opt.dispatchEvent("click"); // custom-styled radios whose <input> has no box
      }
      return;
    }
    default:
      throw new Error(`cannot set a value on a ${f.kind} field`);
  }
}

export async function tickConsent(ctx: Ctx, f: FormField): Promise<void> {
  const loc = byId(ctx, f.id).first();
  try {
    await loc.check({ force: true, timeout: 3000 });
  } catch {
    await loc.dispatchEvent("click");
  }
}

export async function uploadFile(ctx: Ctx, f: FormField, filePath: string): Promise<void> {
  await byId(ctx, f.id).first().setInputFiles(filePath, { timeout: 10_000 });
}
