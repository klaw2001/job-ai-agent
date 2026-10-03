export type Ats = "greenhouse" | "lever" | "ashby";

/** A job posting normalised across all ATS sources. */
export interface Job {
  /** Globally unique: `${ats}:${board}:${externalId}` */
  id: string;
  ats: Ats;
  /** Board token used to fetch the posting (e.g. "databricks"). */
  board: string;
  company: string;
  title: string;
  location: string;
  remote: boolean;
  /** Public posting URL. */
  url: string;
  /** URL of the application form. */
  applyUrl: string;
  /** Plain-text description. */
  description: string;
  postedAt: string | null;
}

export type JobStatus =
  | "new" // discovered, passed the cheap filters, not scored yet
  | "filtered_out" // rejected by title/location filters
  | "low_match" // scored below threshold
  | "scored" // good match, waiting to be applied to
  | "dry_run" // form filled and screenshotted but not submitted
  | "applied" // submitted and a confirmation was seen
  | "submitted_unconfirmed" // submit clicked, but no confirmation message was detected
  | "needs_human" // the agent stopped: captcha, unanswerable required question, ...
  | "failed"; // error while applying

export interface Score {
  value: number; // 0-100
  verdict: "apply" | "skip";
  locationEligible: boolean;
  matchedSkills: string[];
  redFlags: string[];
  reasons: string[];
}

export type ApplyMode = "dry-run" | "review" | "auto";

export interface ApplicationRecord {
  at: string;
  mode: ApplyMode;
  /** Free-form notes: fields filled, things skipped, why it stopped. */
  notes: string[];
  /** Required questions the agent refused to guess. */
  unresolved: string[];
  /** Directory with the screenshot and cover letter. */
  artifactsDir: string;
}

export interface JobRecord {
  job: Job;
  status: JobStatus;
  firstSeen: string;
  filterReason?: string;
  score?: Score;
  application?: ApplicationRecord;
}
