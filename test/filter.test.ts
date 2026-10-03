import { describe, expect, it } from "vitest";
import { loadSearch } from "../src/config.js";
import { locationOk, prefilter, priority, titleOk } from "../src/match/filter.js";
import type { Job } from "../src/types.js";

const search = loadSearch();

const job = (over: Partial<Job>): Job => ({
  id: "x",
  ats: "greenhouse",
  board: "b",
  company: "c",
  title: "Full Stack Engineer",
  location: "Bengaluru, India",
  remote: false,
  url: "u",
  applyUrl: "u",
  description: "",
  postedAt: null,
  ...over,
});

describe("titleOk", () => {
  it.each([
    ["Full Stack Developer", true],
    ["Software Engineer, Growth", true],
    ["Applied AI Engineer", true],
    ["Staff Software Engineer", false],
    ["Principal Backend Engineer", false],
    ["Engineering Manager, Backend", false],
    ["iOS Software Engineer", false],
    ["Senior Security Engineer", false],
    ["Account Executive", false],
  ])("%s -> %s", (title, ok) => {
    expect(titleOk(title, search.titles).ok).toBe(ok);
  });

  it("does not exclude on substrings (ios inside 'bios', 'qa' inside 'aqaba')", () => {
    expect(titleOk("Backend Engineer, Biosciences Platform", search.titles).ok).toBe(true);
  });
});

describe("locationOk", () => {
  it.each([
    ["Bengaluru-VTP, India", false, true],
    ["Mumbai", false, true],
    ["hyderabad", false, true],
    ["Remote", true, true],
    ["Remote - India", true, true],
    ["Remote - APAC", true, true],
    ["Remote - US", true, false],
    ["Remote (EMEA)", true, false],
    ["San Francisco", false, false],
    ["London | Remote - Europe", true, false],
    ["San Francisco | Bengaluru", false, true],
  ])("%s (remote=%s) -> %s", (location, remote, ok) => {
    expect(locationOk({ location, remote }, search.locations).ok).toBe(ok);
  });

  it("matches region-lock terms as whole words only ('us' must not hit 'Cyprus')", () => {
    expect(locationOk({ location: "Remote - Cyprus", remote: true }, search.locations).ok).toBe(true);
    expect(locationOk({ location: "Remote - US", remote: true }, search.locations).ok).toBe(false);
  });
});

describe("prefilter", () => {
  it("passes a matching India full-stack role", () => {
    expect(prefilter(job({}), search).ok).toBe(true);
  });
  it("reports the first failing reason", () => {
    const r = prefilter(job({ title: "Staff Engineer" }), search);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/staff/);
  });
});

describe("priority", () => {
  it("ranks full-stack AI roles above generic senior ones", () => {
    expect(priority(job({ title: "Full Stack AI Engineer" }))).toBeGreaterThan(
      priority(job({ title: "Senior Software Engineer" })),
    );
  });
});
