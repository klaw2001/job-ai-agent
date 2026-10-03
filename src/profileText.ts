import type { Profile } from "./config.js";

/** Compact, LLM-friendly rendering of the profile. This is the ONLY source of truth about the candidate. */
export function profileToText(p: Profile): string {
  const lines: string[] = [];
  lines.push(`Name: ${p.name.first} ${p.name.last}`);
  lines.push(`Headline: ${p.headline}`);
  lines.push(`Location: ${[p.location.city, p.location.region, p.location.country].filter(Boolean).join(", ")}`);
  lines.push(`Years of professional experience: ${p.years_experience}`);
  lines.push(`Summary: ${p.summary.replace(/\s+/g, " ").trim()}`);
  lines.push("Skills:");
  for (const [group, items] of Object.entries(p.skills)) lines.push(`  ${group}: ${items.join(", ")}`);
  lines.push("Experience:");
  for (const e of p.experience) {
    lines.push(`  ${e.title} at ${e.company} (${e.start} to ${e.end})`);
    for (const b of e.bullets) lines.push(`    - ${b}`);
  }
  lines.push("Education:");
  for (const ed of p.education) lines.push(`  ${ed.degree}, ${ed.school} (${ed.start}-${ed.end})`);
  return lines.join("\n");
}
