/**
 * Scripts that run INSIDE the browser page. They are plain strings on purpose: tsx/esbuild injects `__name`
 * helpers into serialised functions, which don't exist in the page and make `page.evaluate(fn)` throw.
 */

/**
 * Finds every answerable control, tags it with data-ja-id (radio/button options also get data-ja-opt) and
 * returns a description of each field: label, kind, options, required.
 */
export const EXTRACT_SCRIPT = String.raw`(() => {
  const squash = (s) => (s || '').replace(/[ \s]+/g, ' ').trim();
  const strip = (s) => squash(s).replace(/[*✱]+/g, '').replace(/\(required\)/ig, '').trim();
  const CONTROLS = 'input, select, textarea, button, svg';
  const rawText = (node) => {
    const c = node.cloneNode(true);
    c.querySelectorAll(CONTROLS).forEach((x) => x.remove());
    return squash(c.textContent);
  };
  const shown = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  const idsText = (ids) => ids.split(/\s+/).map((i) => document.getElementById(i)).filter(Boolean).map(rawText).join(' ');

  const groupRaw = (el) => {
    const fs = el.closest('fieldset');
    if (fs) { const lg = fs.querySelector('legend'); if (lg) return rawText(lg); }
    const g = el.closest('[role="radiogroup"],[role="group"]');
    if (g) {
      const lb = g.getAttribute('aria-labelledby');
      if (lb && idsText(lb)) return idsText(lb);
      if (g.getAttribute('aria-label')) return g.getAttribute('aria-label');
    }
    let a = el.parentElement;
    for (let i = 0; i < 5 && a; i++, a = a.parentElement) {
      if (a.tagName === 'LABEL') continue; // a wrapping <label> holds this option's own text, not the question
      const cand = Array.from(a.children).find((c) =>
        !c.contains(el) && /^(LABEL|LEGEND|H[1-6]|P|SPAN|DIV)$/.test(c.tagName) &&
        !c.querySelector('input,select,textarea,button') && rawText(c).length > 2 && rawText(c).length < 300);
      if (cand) return rawText(cand);
    }
    return '';
  };

  const labelRaw = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb && idsText(lb)) return idsText(lb);
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) return rawText(l);
    }
    const wrap = el.closest('label');
    if (wrap && rawText(wrap)) return rawText(wrap);
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    return groupRaw(el) || el.getAttribute('placeholder') || el.getAttribute('name') || '';
  };

  const optionLabel = (el) => {
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return strip(rawText(l)); }
    const wrap = el.closest('label');
    if (wrap && rawText(wrap)) return strip(rawText(wrap));
    const sib = el.nextSibling && squash(el.nextSibling.textContent);
    if (sib) return strip(sib);
    const nxt = el.nextElementSibling;
    if (nxt && squash(nxt.textContent)) return strip(nxt.textContent);
    return strip(el.getAttribute('aria-label') || el.value || '');
  };

  const out = [];
  let n = 0;
  const nextId = () => 'ja-' + (n++);
  const radioGroups = new Map();

  for (const el of Array.from(document.querySelectorAll('input, select, textarea'))) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(type)) continue;
    if (el.disabled) continue;
    const name = el.getAttribute('name') || '';
    if (/g-recaptcha|h-captcha|cf-turnstile/i.test(name)) continue;

    if (type === 'radio') {
      if (!shown(el) && !shown(el.parentElement)) continue;
      const key = name || el.id || groupRaw(el);
      let g = radioGroups.get(key);
      if (!g) {
        const raw = groupRaw(el) || name;
        g = { id: nextId(), kind: 'radio', label: strip(raw), required: !!el.required || /[*✱]|\(required\)/i.test(raw), options: [], inputType: 'radio', name };
        radioGroups.set(key, g);
        out.push(g);
      }
      el.setAttribute('data-ja-id', g.id);
      el.setAttribute('data-ja-opt', String(g.options.length));
      g.options.push(optionLabel(el));
      continue;
    }

    if (type === 'checkbox') {
      if (!shown(el) && !shown(el.parentElement)) continue;
      const raw = labelRaw(el);
      const id = nextId();
      el.setAttribute('data-ja-id', id);
      out.push({ id, kind: 'checkbox', label: strip(raw), required: !!el.required || el.getAttribute('aria-required') === 'true' || /[*✱]|\(required\)/i.test(raw), options: [], inputType: 'checkbox', name });
      continue;
    }

    if (type === 'file') {
      const raw = labelRaw(el);
      const id = nextId();
      el.setAttribute('data-ja-id', id);
      out.push({ id, kind: 'file', label: strip(raw), required: !!el.required || /[*✱]|\(required\)/i.test(raw), options: [], inputType: 'file', name });
      continue;
    }

    if (!shown(el)) continue;
    const raw = labelRaw(el);
    const id = nextId();
    el.setAttribute('data-ja-id', id);
    const required = !!el.required || el.getAttribute('aria-required') === 'true' || /[*✱]|\(required\)/i.test(raw);
    let kind = 'text';
    let options = [];
    if (tag === 'select') {
      kind = 'select';
      options = Array.from(el.options).map((o) => strip(o.textContent)).filter((t) => t && !/^(select|choose|please select|--)/i.test(t));
    } else if (tag === 'textarea') {
      kind = 'textarea';
    } else if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') {
      kind = 'combobox';
    }
    out.push({ id, kind, label: strip(raw), required, options, inputType: type, name });
  }

  // Yes/No button pairs (Ashby-style boolean questions): treat each pair as a radio group.
  const yn = new Map();
  for (const b of Array.from(document.querySelectorAll('button'))) {
    if (!/^(yes|no)$/i.test(squash(b.textContent)) || !shown(b)) continue;
    const p = b.parentElement;
    if (!p) continue;
    if (!yn.has(p)) yn.set(p, []);
    yn.get(p).push(b);
  }
  for (const [p, btns] of yn) {
    if (btns.length < 2) continue;
    const raw = groupRaw(btns[0]);
    const id = nextId();
    btns.forEach((b, i) => { b.setAttribute('data-ja-id', id); b.setAttribute('data-ja-opt', String(i)); });
    out.push({ id, kind: 'radio', label: strip(raw), required: /[*✱]|\(required\)/i.test(raw), options: btns.map((b) => squash(b.textContent)), inputType: 'buttons', name: '' });
  }

  return out;
})()`;

/** True if a captcha widget is actually visible (invisible reCAPTCHA v3 badges are fine and are ignored). */
export const VISIBLE_CAPTCHA_SCRIPT = String.raw`(() => {
  const sel = 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha, .cf-turnstile';
  return Array.from(document.querySelectorAll(sel)).some((el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 40 || r.height < 30 || st.visibility === 'hidden' || st.display === 'none') return false;
    if (r.bottom < 0 || r.right < 0) return false;
    // reCAPTCHA v3 badge / challenge popups are positioned off-screen until needed
    return !/badge/i.test(el.className || '') && r.left > -100;
  });
})()`;
