import type { Job } from "../types.js";
import { htmlToText } from "../util.js";
import type { Fetcher } from "./index.js";

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  workplaceType?: string;
  descriptionPlain?: string;
  additionalPlain?: string;
  createdAt?: number;
  categories?: { location?: string; allLocations?: string[] };
  lists?: Array<{ text?: string; content?: string }>;
}

/** https://github.com/lever/postings-api */
export async function fetchLever(board: string, getJson: Fetcher): Promise<Job[]> {
  const data = (await getJson(`https://api.lever.co/v0/postings/${board}?mode=json`)) as LeverPosting[];
  return data.map((p): Job => {
    const locations = p.categories?.allLocations?.length ? p.categories.allLocations : [p.categories?.location ?? ""];
    const location = locations.filter(Boolean).join(" | ");
    const sections = (p.lists ?? []).map((l) => `${l.text ?? ""}\n${htmlToText(l.content ?? "")}`);
    return {
      id: `lever:${board}:${p.id}`,
      ats: "lever",
      board,
      company: board,
      title: p.text.trim(),
      location,
      remote: p.workplaceType === "remote" || /remote/i.test(location),
      url: p.hostedUrl,
      applyUrl: p.applyUrl ?? `${p.hostedUrl}/apply`,
      description: [p.descriptionPlain ?? "", ...sections, p.additionalPlain ?? ""].filter(Boolean).join("\n\n"),
      postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
    };
  });
}
