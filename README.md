# job-ai-agent

Finds jobs on company career boards, scores each one against **your resume** with Claude, and fills in the application forms for you. By default it stops *before* submitting; you decide how much autonomy it gets.

```
discover ──► score ──► apply
 public ATS    Claude     browser (Playwright) fills the form,
 job boards    0-100      attaches your resume + a tailored cover letter
```

## Quick start

```bash
npm install
npx playwright install chromium      # the browser it drives
cp .env.example .env                 # then put your ANTHROPIC_API_KEY in it

# 1. Your resume -> profile/profile.yaml (review it; fill in the `answers:` section yourself)
cp /path/to/resume.pdf profile/resume.pdf
npm run agent -- init

# 2. Find and rank jobs
npm run agent -- discover
npm run agent -- score
npm run agent -- status

# 3. Apply
npm run agent -- apply                  # dry-run: fills forms, saves screenshots, submits NOTHING
npm run agent -- apply --mode review    # opens a visible browser; YOU click submit
npm run agent -- apply --mode auto      # submits by itself (daily-capped, stops on anything uncertain)
```

`npm run agent -- run --mode dry-run` does discover → score → apply in one go.

## Where jobs come from

The public job-board APIs of **Greenhouse, Lever and Ashby** — the same data a company's own careers page shows. `config/search.yaml` lists the company boards to watch (a starter list of ~30 boards with India or remote openings is included — add the companies you actually care about), plus title and location filters. A board token is the slug in the URL: `jobs.lever.co/<token>`, `job-boards.greenhouse.io/<token>`, `jobs.ashbyhq.com/<token>`.

Filters run first and cost nothing; only postings that pass are sent to Claude for scoring. A job is "worth applying to" when its score is ≥ `scoring.min_score` (default 70) **and** you could realistically work from where the role is based — that verdict is computed in code, not left to the model.

**Not supported on purpose:** LinkedIn, Naukri, Indeed and similar. Their terms forbid automated applying and accounts get banned. Use the boards above and apply to those by hand.

## Safety rules (these are tested)

- **Dry-run is the default.** Nothing is submitted unless you pass `--mode review` (you click submit) or `--mode auto`.
- **Facts come only from `profile/profile.yaml`.** Cover letters and form answers are grounded in it; the model is told to return `null` rather than invent employers, numbers or tech you haven't listed.
- **Sensitive questions are never guessed or sent to the model:** work authorisation, visa/sponsorship, salary, notice period, criminal record, date of birth, and so on. They are answered from `answers:` / `custom_answers:` in your profile — otherwise the application is paused (`needs_human`) and the question is shown in `status`.
- **Demographic (EEO) questions** get "decline to answer" if offered, otherwise are left blank.
- **It stops instead of pushing through:** visible captchas, e-mailed verification codes, required fields it can't answer, unrecognised forms.
- **Never applies twice** to the same posting or to the same role at the same company, and respects `apply.max_per_day`. State is saved after every application.
- Job descriptions are treated as untrusted text: embedded instructions ("ignore previous instructions…") are not followed.

## Your profile

`init` asks Claude to extract `profile/profile.yaml` from your resume PDF — check it, it is the only source of truth about you. Then fill in what a resume doesn't say:

```yaml
answers:
  notice_period: "30 days"
  expected_salary: "25 LPA"
  willing_to_relocate: true
  requires_sponsorship: false
custom_answers:                      # first matching regex wins, used verbatim
  - match: "authori[sz]ed to work in india"
    answer: "Yes"
```

If an application lands in `needs_human`, add the missing answer here and retry it: `npm run agent -- apply --job <id>` (ids are printed by `status`).

`profile/profile.yaml`, `profile/resume.pdf`, `.env` and `data/` are **gitignored** — don't commit them; this repo may be public.

## Commands

| Command | What it does |
|---|---|
| `init [--resume f.pdf] [--force]` | Build `profile/profile.yaml` from your resume |
| `discover` | Fetch postings from the configured boards and filter them |
| `score [--limit n]` | Score new matches with Claude (capped by `scoring.max_jobs_per_run`) |
| `apply [--mode m] [--limit n] [--job id]` | Fill (and optionally submit) applications, best score first |
| `status [--all]` | Applied / needs you / ready / waiting, with links and reasons |
| `run [--mode m]` | `discover` → `score` → `apply` |

Each application leaves a folder in `data/applications/<job>/`: `filled.png` (what the form looked like), `cover_letter.txt`, `fields.json`, and `after_submit.png` if it submitted.

## Configuration

- `config/search.yaml` — boards, title/location filters, score threshold, `apply.max_per_day`, `max_per_run`, delay between applications.
- `.env` — `ANTHROPIC_API_KEY`; optional `CLAUDE_MODEL` (default `claude-opus-5-5`) and `SCORE_MODEL` (e.g. `claude-haiku-4-5` for cheaper bulk scoring); `CLAUDE_FALLBACKS=off` if your account rejects the server-side fallback beta; `BROWSER_EXECUTABLE_PATH` for a custom Chromium.

## How the form filler works

It does not hard-code selectors per ATS (they change constantly). It scans the page, reads each field's visible label, and decides an answer per field: profile facts first, then your `custom_answers`, then Claude for open questions (grounded in the profile, choosing only from the listed options for dropdowns). Handles `<label for>`, wrapping labels, fieldsets, custom comboboxes, hidden file inputs and Yes/No button pairs, in the page or inside an embedded Greenhouse iframe.

## Honest limitations

- **Tested against local mock forms** shaped like Greenhouse / Lever / Ashby pages (`test/helpers/mockSite.ts`), **not against live employer forms**, and the Claude calls are tested against a fake API server, not the real one. Real forms vary — start with `dry-run` and look at the screenshots before trusting `auto`.
- Greenhouse and Lever often add captchas or e-mail verification codes; those applications correctly stop at `needs_human` and you finish them by hand (the form is already filled in `review` mode).
- Custom widgets it doesn't recognise end up in `needs_human` rather than being guessed.
- "Applied" in `auto` mode means a confirmation message was detected; if none was, the status is `submitted_unconfirmed` — check your e-mail.
- Automated applying may be against some employers' terms. You are responsible for what is sent in your name.

## Development

```bash
npm test            # unit + pipeline + LLM-contract + browser e2e tests (needs Chromium)
npm run typecheck
```

```
src/
  sources/    greenhouse.ts lever.ts ashby.ts   -> normalised Job
  match/      filter.ts (cheap) score.ts (Claude)
  tailor/     coverLetter.ts
  apply/      pageScripts.ts (in-page scanner)  mapper.ts (field decisions)  fill.ts  apply.ts (modes, submit, confirm)
  pipeline.ts store.ts llm.ts config.ts cli.ts
```
