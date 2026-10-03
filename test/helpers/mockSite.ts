import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Submission {
  page: string;
  data: Record<string, string>;
}

const SUBMIT_SCRIPT = `
<script>
const form = document.querySelector('form');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const obj = {};
  for (const [k, v] of new FormData(form).entries()) obj[k] = v instanceof File ? 'file:' + v.name : v;
  await fetch('/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: location.pathname, data: obj }) });
  document.body.innerHTML = '<h1>Thanks!</h1><p>Your application has been submitted.</p>';
});
document.querySelectorAll('.yesno').forEach((g) => g.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  g.querySelector('input[type=hidden]').value = b.textContent;
  g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
})));
const cb = document.getElementById('loc');
if (cb) {
  const lb = document.getElementById('lb');
  const opts = ['Mumbai', 'Bengaluru', 'Remote'];
  const render = (q) => { lb.innerHTML = ''; opts.filter((o) => o.toLowerCase().includes((q || '').toLowerCase())).forEach((o) => {
    const li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = o;
    li.addEventListener('mousedown', (ev) => { ev.preventDefault(); cb.value = o; lb.hidden = true; });
    lb.appendChild(li); }); lb.hidden = false; };
  cb.addEventListener('click', () => render(''));
  cb.addEventListener('input', () => render(cb.value));
}
</script>`;

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px sans-serif;margin:30px;max-width:720px}div.f{margin:10px 0}label{display:block;font-weight:600}
input,select,textarea{width:340px;padding:6px}input[type=radio],input[type=checkbox]{width:auto}.yesno button.on{background:#ccd}</style>
</head><body><h2>${title}</h2>${body}${SUBMIT_SCRIPT}</body></html>`;

// Greenhouse-style: <label for>, asterisks, hidden file input, selects, a combobox, consent checkbox.
const GREENHOUSE = (extra = "") =>
  page(
    "Acme - Full Stack Engineer",
    `<form>
<div class="f"><label for="first_name">First Name *</label><input id="first_name" name="first_name" required></div>
<div class="f"><label for="last_name">Last Name *</label><input id="last_name" name="last_name" required></div>
<div class="f"><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
<div class="f"><label for="phone">Phone</label><input id="phone" name="phone" type="tel"></div>
<div class="f"><label for="resume">Resume/CV *</label><button type="button">Attach</button><input id="resume" name="resume" type="file" style="display:none"></div>
<div class="f"><label for="linkedin">LinkedIn Profile</label><input id="linkedin" name="linkedin"></div>
<div class="f"><label for="website">Website</label><input id="website" name="website"></div>
<div class="f"><label for="loc">Location (City) *</label><input id="loc" name="loc" role="combobox" aria-haspopup="listbox" autocomplete="off" required><ul role="listbox" id="lb" hidden></ul></div>
<div class="f"><label for="country">Country *</label><select id="country" name="country" required><option value="">Select...</option><option>United States</option><option>India</option></select></div>
<div class="f"><label for="q1">Why do you want to work at Acme? *</label><textarea id="q1" name="why" required></textarea></div>
<div class="f"><label for="q2">How many years of experience do you have with Node.js? *</label><input id="q2" name="node_years" type="number" required></div>
<div class="f"><label for="gender">Gender</label><select id="gender" name="gender"><option value="">Select...</option><option>Male</option><option>Female</option><option>Decline to self-identify</option></select></div>
${extra}
<div class="f"><label><input type="checkbox" name="privacy" required> I agree to the Privacy Policy *</label></div>
<button type="submit">Submit Application</button></form>`,
  );

const LEVER = (extra = "") =>
  page(
    "Beta Corp - Software Engineer (Lever)",
    `<form>
<label><div class="application-label">Full name<span class="required">✱</span></div><div class="application-field"><input name="name" required></div></label>
<label><div class="application-label">Email<span class="required">✱</span></div><div class="application-field"><input name="email" type="email" required></div></label>
<label><div class="application-label">Phone</div><div class="application-field"><input name="phone"></div></label>
<label><div class="application-label">Current company</div><div class="application-field"><input name="org"></div></label>
<label><div class="application-label">Resume/CV<span class="required">✱</span></div><div class="application-field"><input type="file" name="resume"></div></label>
<label><div class="application-label">LinkedIn URL</div><div class="application-field"><input name="urls[LinkedIn]"></div></label>
<div class="application-question"><div class="application-label">Are you legally authorized to work in India?<span class="required">✱</span></div>
<ul><li><label><input type="radio" name="cards[auth]" value="Yes" required><span>Yes</span></label></li><li><label><input type="radio" name="cards[auth]" value="No"><span>No</span></label></li></ul></div>
${extra}
<button type="submit">Submit application</button></form>`,
  );

const ASHBY = page(
  "Gamma AI - Product Engineer (Ashby)",
  `<form>
<div class="f"><label for="_systemfield_name">Name</label><input id="_systemfield_name" name="_systemfield_name" required></div>
<div class="f"><label for="_systemfield_email">Email</label><input id="_systemfield_email" name="_systemfield_email" type="email" required></div>
<div class="f"><label for="_systemfield_resume">Resume</label><input id="_systemfield_resume" name="_systemfield_resume" type="file"></div>
<div class="f"><label>Are you willing to work from our Mumbai office 3 days a week? *</label>
<div class="yesno"><button type="button">Yes</button><button type="button">No</button><input type="hidden" name="office_ok"></div></div>
<button type="submit">Submit Application</button></form>`,
);

const CAPTCHA = (() =>
  page(
    "Delta - Backend Engineer",
    `<form>
<div class="f"><label for="first_name">First Name *</label><input id="first_name" name="first_name" required></div>
<div class="f"><label for="last_name">Last Name *</label><input id="last_name" name="last_name" required></div>
<div class="f"><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
<div class="g-recaptcha" style="width:304px;height:78px;border:1px solid #999">I'm not a robot</div>
<button type="submit">Submit Application</button></form>`,
  ))();

const CLOSED = page("Job not found", "<p>Sorry, this job is no longer available.</p>");

const SALARY = `<div class="f"><label for="sal">What are your salary expectations? *</label><input id="sal" name="salary"></div>`;
const AUTH_RADIO = `<fieldset><legend>Are you legally authorized to work in India? *</legend>
<label><input type="radio" name="auth" value="Yes"> Yes</label><label><input type="radio" name="auth" value="No"> No</label></fieldset>`;
const SECURITY = `<div class="f"><label for="sc">Security code (sent to your email) *</label><input id="sc" name="code"></div>`;

const ROUTES: Record<string, string> = {
  "/greenhouse": GREENHOUSE(),
  "/greenhouse-salary": GREENHOUSE(SALARY),
  "/greenhouse-auth": GREENHOUSE(AUTH_RADIO),
  "/greenhouse-code": GREENHOUSE(SECURITY),
  "/lever": LEVER(),
  "/ashby": ASHBY,
  "/captcha": CAPTCHA,
  "/closed": CLOSED,
};

export async function startMockSite(): Promise<{
  url: string;
  submissions: Submission[];
  close: () => Promise<void>;
}> {
  const submissions: Submission[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/submit") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        submissions.push(JSON.parse(body) as Submission);
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
      return;
    }
    const html = ROUTES[req.url ?? ""];
    if (!html) return void res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    submissions,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
