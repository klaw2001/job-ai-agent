import type { Job } from "../types.js";
import { htmlToText } from "../util.js";
import type { Fetcher } from "./index.js";

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  isRemote?: boolean;
  isListed?: boolean;
  workplaceType?: string;
  jobUrl: string;
  applyUrl?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  publishedAt?: string;
}

/** https://developers.ashbyhq.com/docs/public-job-posting-api */
export async function fetchAshby(board: string, getJson: Fetcher): Promise<Job[]> {
  const data = (await getJson(`https://api.ashbyhq.com/posting-api/job-board/${board}`)) as { jobs?: AshbyJob[] };
  return (data.jobs ?? [])
    .filter((j) => j.isListed !== false)
    .map((j): Job => {
      const location = [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)]
        .filter((s): s is string => !!s)
        .join(" | ");
      return {
        id: `ashby:${board}:${j.id}`,
        ats: "ashby",
        board,
        company: board,
        title: j.title.trim(),
        location,
        remote: j.isRemote === true || j.workplaceType === "Remote" || /remote/i.test(location),
        url: j.jobUrl,
        applyUrl: j.applyUrl ?? `${j.jobUrl}/application`,
        description: j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? ""),
        postedAt: j.publishedAt ?? null,
      };
    });
}
