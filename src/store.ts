import fs from "node:fs";
import path from "node:path";
import type { Job, JobRecord, JobStatus } from "./types.js";

interface StoreFile {
  version: 1;
  jobs: Record<string, JobRecord>;
}

/**
 * Tiny JSON-file store. A personal job search is hundreds of rows, so this beats pulling in a
 * database; the file is human-readable and diffable. Writes are atomic (tmp file + rename).
 */
export class Store {
  private data: StoreFile = { version: 1, jobs: {} };

  constructor(private readonly file: string) {
    if (fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, "utf8")) as StoreFile;
    }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  all(): JobRecord[] {
    return Object.values(this.data.jobs);
  }

  get(id: string): JobRecord | undefined {
    return this.data.jobs[id];
  }

  byStatus(...statuses: JobStatus[]): JobRecord[] {
    return this.all().filter((r) => statuses.includes(r.status));
  }

  /** Insert a job we haven't seen. Existing records are left untouched (status is never reset). */
  addIfNew(job: Job, status: JobStatus, filterReason?: string): boolean {
    if (this.data.jobs[job.id]) return false;
    this.data.jobs[job.id] = {
      job,
      status,
      firstSeen: new Date().toISOString(),
      ...(filterReason ? { filterReason } : {}),
    };
    return true;
  }

  update(id: string, patch: Partial<Omit<JobRecord, "job">>): void {
    const rec = this.data.jobs[id];
    if (!rec) throw new Error(`Unknown job ${id}`);
    Object.assign(rec, patch);
  }

  /** Applications actually submitted (or submitted-but-unconfirmed) since local midnight. */
  submittedToday(now = new Date()): number {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return this.all().filter(
      (r) =>
        (r.status === "applied" || r.status === "submitted_unconfirmed") &&
        r.application &&
        new Date(r.application.at) >= start,
    ).length;
  }

  /**
   * True if we already applied to (or tried to submit to) the same role at the same company
   * under a different posting id -- companies often cross-post the same role per location.
   */
  alreadySubmittedSameRole(job: Job): boolean {
    const key = (j: Job) => `${j.company.toLowerCase()}::${j.title.toLowerCase().trim()}`;
    return this.all().some(
      (r) =>
        r.job.id !== job.id &&
        (r.status === "applied" || r.status === "submitted_unconfirmed") &&
        key(r.job) === key(job),
    );
  }
}
