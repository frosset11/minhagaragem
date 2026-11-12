// /s/<token>: the address of a shared dossier. Messaging apps (WhatsApp, iMessage, Slack…) read this small page
// for the preview card — the car's name and picture — and people's browsers go straight on to the dossier at /#/share/<token>.
// It asks the `dossier` function only for the name and icon picture ({ meta: true }), which isn't counted as a view.
const SUPA = 'https://ovthmjsyjxjlimcxgqmo.supabase.co';
const KEY = 'sb_publishable_er9iB2nm-wn6XdEFPcpkog_diC_LDzE'; // the public key, the same one the app uses
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function lookUp(token) {
  try {
    const r = await fetch(`${SUPA}/functions/v1/dossier`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY },
      body: JSON.stringify({ token, meta: true }), signal: AbortSignal.timeout(4000)
    });
    const j = await r.json();
    return j && j.ok ? j : null;
  } catch (e) { return null; }
}

function page(token, meta, origin) {
  const to = token ? `/#/share/${token}` : '/';
  const title = meta && meta.title ? `${meta.title} · Vehicle dossier` : 'Vehicle dossier · AUTODEX';
  const desc = 'Specifications, history and service records, shared by the owner. Read-only.';
  const img = meta && meta.photo ? meta.photo : `${origin}/icons/icon-512.png`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex,nofollow">
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="AUTODEX">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}"><meta property="og:url" content="${esc(origin + (token ? '/s/' + token : '/'))}">
<meta name="twitter:card" content="${meta && meta.photo ? 'summary_large_image' : 'summary'}"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(img)}">
<meta http-equiv="refresh" content="0;url=${esc(to)}">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111827;color:#f6f1e8;font:16px system-ui,-apple-system,'Segoe UI',sans-serif}a{color:#c7a668}</style>
</head><body><p><a href="${esc(to)}">Open the dossier</a></p><script>location.replace(${JSON.stringify(to)});</script></body></html>`;
}

module.exports = async (req, res) => {
  const raw = String((req.query && req.query.token) || '');
  const token = /^[0-9a-f]{36}$/.test(raw) ? raw : '';
  const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host || 'autodex-garage.vercel.app'}`;
  const meta = token ? await lookUp(token) : null;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(page(token, meta, origin));
};
module.exports.page = page;
