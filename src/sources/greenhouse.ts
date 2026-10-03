import type { Job } from "../types.js";
import { decodeEntities, htmlToText } from "../util.js";
import type { Fetcher } from "./index.js";

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  content?: string;
  company_name?: string;
  first_published?: string;
  updated_at?: string;
}

/** https://developers.greenhouse.io/job-board.html#list-jobs */
export async function fetchGreenhouse(board: string, getJson: Fetcher): Promise<Job[]> {
  const data = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`)) as {
    jobs?: GhJob[];
  };
  return (data.jobs ?? []).map((j): Job => {
    const location = j.location?.name ?? "";
    return {
      id: `greenhouse:${board}:${j.id}`,
      ats: "greenhouse",
      board,
      company: j.company_name ?? board,
      title: j.title.trim(),
      location,
      remote: /remote/i.test(location),
      url: j.absolute_url,
      applyUrl: j.absolute_url,
      // `content` is HTML that has itself been HTML-escaped, so unescape once before stripping tags.
      description: htmlToText(decodeEntities(j.content ?? "")),
      postedAt: j.first_published ?? j.updated_at ?? null,
    };
  });
}
