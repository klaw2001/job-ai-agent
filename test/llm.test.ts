import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { askLlmForFields } from "../src/apply/mapper.js";
import { ProfileSchema } from "../src/config.js";
import { buildProfileFromResume } from "../src/initProfile.js";
import { createLlm, FatalLlmError, RefusalError } from "../src/llm.js";
import { scoreJob } from "../src/match/score.js";
import { writeCoverLetter } from "../src/tailor/coverLetter.js";
import { LETTER, dummyResume, testJob, testProfile } from "./helpers/fixtures.js";

/**
 * No API key is needed here: the real Anthropic SDK is pointed at a local fake of POST /v1/messages that
 * records each request and answers with canned JSON chosen from the requested output schema. This checks that
 * our request construction is what the SDK/API expects, and that responses are parsed and validated.
 */
interface Captured {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, any>;
}
let server: http.Server;
let baseURL: string;
let requests: Captured[] = [];
let respond: (body: Record<string, any>) => { stop_reason?: string; text: string };

const CANNED: Record<string, unknown> = {
  score: { score: 82, location_eligible: true, matched_skills: ["Node.js"], red_flags: [], reasons: ["stack match"] },
  letter: { letter: LETTER },
  answers: { answers: [{ id: "ja-1", answer: "Yes" }, { id: "ja-2", answer: "Not a listed option" }, { id: "ja-3", answer: null }] },
  first_name: {
    first_name: "Jane", last_name: "Doe", email: "jane@example.com", phone: "+91 90000 00000",
    city: "Mumbai", region: "Maharashtra", country: "India", website: "https://example.com", linkedin: "", github: "",
    headline: "Full Stack Developer", summary: "Builds things.", years_experience: 3,
    skills: [{ group: "Backend", items: ["Node.js"] }],
    experience: [{ company: "Example Co", title: "Full Stack Developer", start: "2023-06", end: "Present", bullets: ["Built stuff."] }],
    education: [{ school: "Example University", degree: "B.Sc. IT", start: "2019", end: "2022" }],
  },
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ url: req.url ?? "", headers: req.headers, body });
      const out = respond(body);
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "msg_test", type: "message", role: "assistant", model: body.model,
          content: [{ type: "text", text: out.text }],
          stop_reason: out.stop_reason ?? "end_turn", stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  requests = [];
  respond = (body) => {
    const props = Object.keys(body.output_config?.format?.schema?.properties ?? {});
    const key = Object.keys(CANNED).find((k) => props.includes(k));
    return { text: JSON.stringify(key ? CANNED[key] : {}) };
  };
});

const llm = () => createLlm(new Anthropic({ apiKey: "test-key", baseURL, maxRetries: 0 }));

/** Structured-output schemas must avoid keywords the API rejects. */
function assertSupportedSchema(schema: unknown) {
  const json = JSON.stringify(schema);
  for (const bad of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern"]) {
    expect(json, `schema uses unsupported keyword "${bad}"`).not.toContain(`"${bad}"`);
  }
}

describe("request construction (checked against the real SDK)", () => {
  it("scoreJob sends a structured-output request with fallbacks, and no thinking/sampling/forced-tool params", async () => {
    const score = await scoreJob(llm(), "claude-opus-5-5", testProfile(), testJob("https://x"), 70);
    expect(score).toMatchObject({ value: 82, verdict: "apply", locationEligible: true });

    const req = requests[0]!;
    expect(req.url).toContain("/v1/messages");
    expect(req.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(req.body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default" });
    expect(req.body.output_config.effort).toBe("medium");
    expect(req.body.output_config.format.type).toBe("json_schema");
    assertSupportedSchema(req.body.output_config.format.schema);
    // Opus 5.5 400s on all of these:
    for (const banned of ["thinking", "temperature", "top_p", "top_k", "tool_choice", "budget_tokens"]) {
      expect(req.body).not.toHaveProperty(banned);
    }
    // The posting is delimited as untrusted data and the system prompt says so.
    expect(req.body.system).toMatch(/untrusted/i);
    expect(JSON.stringify(req.body.messages)).toContain("<job_posting>");
  });

  it("CLAUDE_FALLBACKS=off drops the fallback beta entirely", async () => {
    process.env.CLAUDE_FALLBACKS = "off";
    try {
      await scoreJob(llm(), "claude-opus-5-5", testProfile(), testJob("https://x"), 70);
    } finally {
      delete process.env.CLAUDE_FALLBACKS;
    }
    expect(requests[0]!.headers["anthropic-beta"] ?? "").not.toContain("server-side-fallback");
    expect(requests[0]!.body).not.toHaveProperty("fallbacks");
  });

  it("cover letter, form answers and resume extraction all use supported schemas", async () => {
    await writeCoverLetter(llm(), "m", testProfile(), testJob("https://x"));
    const profileOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ja-init-")), "profile.yaml");
    await buildProfileFromResume(llm(), dummyResume(), profileOut);
    for (const r of requests) assertSupportedSchema(r.body.output_config.format.schema);
  });

  it("attaches the resume PDF as a base64 document block", async () => {
    await buildProfileFromResume(llm(), dummyResume(), path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ja-init-")), "p.yaml"));
    const content = requests[0]!.body.messages[0].content as Array<Record<string, any>>;
    const doc = content.find((b) => b.type === "document")!;
    expect(doc.source).toMatchObject({ type: "base64", media_type: "application/pdf" });
    expect(Buffer.from(doc.source.data, "base64").toString()).toContain("%PDF-1.4");
  });
});

describe("resume -> profile.yaml", () => {
  it("writes a file that loads through the same schema the agent uses, with `answers` left null", async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ja-init-")), "profile.yaml");
    await buildProfileFromResume(llm(), dummyResume(), out);
    const profile = ProfileSchema.parse(parseYaml(fs.readFileSync(out, "utf8")));
    expect(profile.name).toEqual({ first: "Jane", last: "Doe" });
    expect(profile.links).toEqual({ website: "https://example.com" }); // empty linkedin/github are dropped, not invented
    expect(profile.skills).toEqual({ Backend: ["Node.js"] });
    expect(profile.answers).toEqual({
      notice_period: null, expected_salary: null, current_salary: null, willing_to_relocate: null, requires_sponsorship: null,
    });
  });
});

describe("form answers", () => {
  const f = (id: string, over: object) => ({ id, kind: "text" as const, label: "q", required: true, options: [], inputType: "text", name: "", ...over });

  it("only accepts answers that are real options, and passes null through", async () => {
    const fields = [
      f("ja-1", { kind: "radio", options: ["Yes", "No"] }),
      f("ja-2", { kind: "select", options: ["A", "B"] }), // model answered something not in the list
      f("ja-3", {}),
    ];
    const out = await askLlmForFields(llm(), "m", testProfile(), testJob("https://x"), fields);
    expect(out.get("ja-1")).toBe("Yes");
    expect(out.get("ja-2")).toBeNull();
    expect(out.get("ja-3")).toBeNull();
  });

  it("makes no API call when there is nothing to ask", async () => {
    await askLlmForFields(llm(), "m", testProfile(), testJob("https://x"), []);
    expect(requests).toHaveLength(0);
  });
});

describe("failure handling", () => {
  it("turns a 401 from the API into a FatalLlmError that says how to fix it", async () => {
    const unauthorized = http.createServer((_req, res) =>
      res
        .writeHead(401, { "content-type": "application/json" })
        .end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })),
    );
    await new Promise<void>((r) => unauthorized.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(unauthorized.address() as AddressInfo).port}`;
      const bad = createLlm(new Anthropic({ apiKey: "nope", baseURL: url, maxRetries: 0 }));
      const err = await bad.json({ model: "m", system: "s", user: "u", schema: z.object({ a: z.string() }) }).catch((e) => e);
      expect(err).toBeInstanceOf(FatalLlmError);
      expect(err.message).toMatch(/ANTHROPIC_API_KEY/);
    } finally {
      await new Promise<void>((r) => unauthorized.close(() => r()));
    }
  });

  it("no credentials at all is also fatal (clear message, not a per-job error)", async () => {
    const saved = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      const none = createLlm(new Anthropic({ baseURL, maxRetries: 0 }));
      await expect(none.json({ model: "m", system: "s", user: "u", schema: z.object({ a: z.string() }) })).rejects.toBeInstanceOf(
        FatalLlmError,
      );
    } finally {
      if (saved.k !== undefined) process.env.ANTHROPIC_API_KEY = saved.k;
      if (saved.t !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.t;
    }
  });

  it("surfaces a safety refusal as RefusalError", async () => {
    respond = () => ({ stop_reason: "refusal", text: "" });
    await expect(llm().json({ model: "m", system: "s", user: "u", schema: z.object({ a: z.string() }) })).rejects.toBeInstanceOf(
      RefusalError,
    );
  });

  it("rejects output that does not match the schema instead of passing garbage downstream", async () => {
    respond = () => ({ text: "I cannot do that." });
    await expect(llm().json({ model: "m", system: "s", user: "u", schema: z.object({ a: z.string() }) })).rejects.toThrow();
  });

  it("a cover letter with a leftover placeholder is rejected", async () => {
    respond = () => ({ text: JSON.stringify({ letter: LETTER + " Dear [Hiring Manager]" }) });
    await expect(writeCoverLetter(llm(), "m", testProfile(), testJob("https://x"))).rejects.toThrow(/placeholder/);
  });
});
