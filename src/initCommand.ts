import fs from "node:fs";
import { paths } from "./config.js";
import { buildProfileFromResume } from "./initProfile.js";
import type { Llm } from "./llm.js";

export async function initProfileFromResume(llm: Llm, resumePath: string, force: boolean): Promise<string> {
  if (!fs.existsSync(resumePath)) {
    throw new Error(`Resume not found at ${resumePath}. Pass --resume <file.pdf> or copy it to profile/resume.pdf.`);
  }
  if (fs.existsSync(paths.profile) && !force) {
    throw new Error(`${paths.profile} already exists. Use --force to overwrite it.`);
  }
  // The apply step uploads profile/resume.pdf, so keep a copy there if the resume came from elsewhere.
  if (resumePath !== paths.resume && !fs.existsSync(paths.resume)) fs.copyFileSync(resumePath, paths.resume);
  return buildProfileFromResume(llm, resumePath);
}
