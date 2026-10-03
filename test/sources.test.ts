import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverJobs, type Fetcher } from "../src/sources/index.js";
import { decodeEntities, htmlToText } from "../src/util.js";

const fixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8"));

const fakeFetch: Fetcher = async (url) => {
  if (url.includes("greenhouse")) return fixture("greenhouse.json");
  if (url.includes("lever")) return fixture("lever.json");
  if (url.includes("ashby")) return fixture("ashby.json");
  throw new Error("unexpected url " + url);
};

describe("discoverJobs (real captured API payloads)", () => {
  it("normalises all three sources", async () => {
    const { jobs, errors } = await discoverJobs({ greenhouse: ["groww"], lever: ["cred"], ashby: ["cursor"] }, fakeFetch);
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(9);

    for (const j of jobs) {
      expect(j.id.startsWith(`${j.ats}:${j.board}:`)).toBe(true);
      expect(j.title).toBeTruthy();
      expect(j.url).toMatch(/^https:\/\//);
      expect(j.applyUrl).toMatch(/^https:\/\//);
    }

    const gh = jobs.find((j) => j.ats === "greenhouse")!;
    expect(gh.location).toContain("India");
    // Greenhouse ships HTML that was itself HTML-escaped; no tags or entities may survive.
    expect(gh.description).not.toMatch(/<\/?[a-z][^>]*>|&lt;|&gt;|&amp;/i);
    expect(gh.description.length).toBeGreaterThan(50);

    const ashby = jobs.find((j) => j.ats === "ashby")!;
    expect(ashby.applyUrl).toMatch(/\/application$/);

    const lever = jobs.find((j) => j.ats === "lever")!;
    expect(lever.applyUrl).toMatch(/\/apply$/);
  });

  it("isolates a failing board instead of aborting the run", async () => {
    const flaky: Fetcher = async (url) => {
      if (url.includes("api.lever.co")) throw new Error("HTTP 404");
      return fakeFetch(url);
    };
    const { jobs, errors } = await discoverJobs({ greenhouse: ["groww"], lever: ["typo"], ashby: [] }, flaky);
    expect(jobs).toHaveLength(3);
    expect(errors).toEqual(["lever/typo: HTTP 404"]);
  });
});

describe("html helpers", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("A &amp; B &#39;x&#39; &#x41; &nbsp;&unknown;")).toBe("A & B 'x' A  &unknown;");
  });
  it("turns block HTML into readable lines", () => {
    expect(htmlToText("<p>Hello</p><ul><li>One</li><li>Two &amp; three</li></ul>")).toBe("Hello\n\n- One\n- Two & three");
  });
});
