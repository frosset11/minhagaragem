// Redraws a vehicle's photo as a clean vector-style illustration (OpenAI image edit).
// Returns the image as base64; the app resizes it to 1000x1000, stores it and makes it the vehicle's photo.
import { cors, gate, json } from '../_shared/ai.ts';

const MODEL = 'gpt-image-2.5-sunburst'; // OpenAI's image model for edits where precision matters most
const QUALITY = 'high';

const PROMPT = `Using the provided reference photograph, create a high-quality, detailed vector-style cartoon illustration of the exact vehicle shown.

ILLUSTRATION STYLE:

* Premium automotive vector illustration with a semi-realistic cartoon aesthetic.
* Clean, crisp black outlines defining the vehicle’s silhouette, body panels, and important details.
* Smooth, layered shading with subtle gradients and simplified reflections.
* Glossy paint finish with stylized highlights that emphasize the vehicle’s curves and bodywork.
* Detailed but simplified rendering, balancing realistic automotive accuracy with a polished digital illustration aesthetic.
* Sharp, precise edges and clean geometric shapes.
* Professional automotive artwork, similar to high-end vector car illustrations.
* NOT photorealistic, NOT 3D rendered, NOT overly cartoonish.


VEHICLE ACCURACY:

* Preserve the exact vehicle model, generation, body shape, proportions, and distinctive design features from the reference photograph.
* Maintain the original paint color, wheels, headlights, grille, mirrors, bumpers, badges, and accessories.
* Accurately reproduce the vehicle’s wheels, including their design, spoke pattern, and finish.
* Preserve the original camera perspective, showing the vehicle from the same front three-quarter angle as the reference.
* Reproduce visible license plate details whenever possible.
* Maintain realistic vehicle proportions without exaggeration or distortion.


LIGHTING & DETAILS:

* Soft, neutral studio lighting.
* Clean, glossy reflections on the bodywork.
* Subtle stylized reflections across the windshield and windows.
* Detailed headlights, grille, wheel spokes, and body contours.
* Smooth shadows that provide depth without looking photorealistic.


BACKGROUND & COMPOSITION:

* Solid light grey background (#E5E5E5), with a very subtle gradient for depth.
* Soft, natural elliptical shadow beneath the vehicle.
* No environment, road, trees, buildings, or additional objects.
* No borders, rounded corners, or app icon framing.
* Center the vehicle horizontally and vertically.
* Leave comfortable negative space around the entire vehicle.
* Ensure the complete vehicle is visible, without cropping any part.


OUTPUT:

* Square composition.
* 1000 × 1000 pixels.
* High-resolution, sharp, clean digital illustration.
* Consistent professional vector illustration aesthetic.


IMPORTANT: The final image should look like a professionally illustrated version of the actual car photograph, not a generic rendering of the same model. Prioritize accuracy to the reference vehicle while maintaining the clean vector-cartoon style.`;

const openaiKey = (): string | null => {
  for (const k of ['OPENAI_API_KEY', 'OPENAI_KEY', 'openai_api_key']) { const t = Deno.env.get(k); if (t && t.trim()) return t.trim(); }
  return null;
};
const mediaPath = (u: string) => { const m = /\/object\/(?:public|sign|authenticated)\/media\/([^?]+)/.exec(u || ''); return m ? decodeURIComponent(m[1]) : null; };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({})) as { garage_id?: string; vehicle_id?: string };
    const g = await gate(req, body.garage_id, 'illustrate', false);
    if ('fail' in g) return g.fail;
    const key = openaiKey();
    if (!key) return json({ error: 'missing_key', message: 'Illustrations aren\'t set up yet. Try again later.' }, 503);

    const { data: v } = await g.sb.from('vehicles').select('id, photo_url, garage_id').eq('id', body.vehicle_id ?? '').eq('garage_id', body.garage_id).maybeSingle();
    if (!v) return json({ error: 'no_vehicle', message: 'That vehicle wasn\'t found in this garage.' }, 404);
    const path = mediaPath(v.photo_url || '');
    if (!path) return json({ error: 'no_photo', message: 'Add a photo of the vehicle first.' }, 400);
    const { data: file, error: dlErr } = await g.sb.storage.from('media').download(path);
    if (dlErr || !file) return json({ error: 'no_photo', message: 'The photo couldn\'t be read. Upload it again and retry.' }, 400);
    const type = file.type || (path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
    if (!/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: 'bad_photo', message: 'Illustrations need a JPG, PNG or WebP photo. Upload the photo in one of those formats and try again.' }, 400);

    const form = new FormData();
    form.append('model', MODEL);
    form.append('image', new File([file], 'reference.' + type.split('/')[1], { type }));
    form.append('prompt', PROMPT);
    form.append('size', '1024x1024'); // the app scales it to 1000 x 1000
    form.append('quality', QUALITY);
    form.append('n', '1');
    const res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
    const text = await res.text();
    if (!res.ok) {
      let reason = ''; try { reason = JSON.parse(text)?.error?.message || ''; } catch (_) { reason = text.slice(0, 200); }
      console.error('openai', res.status, text.slice(0, 1000));
      const code = (() => { try { const e = JSON.parse(text)?.error; return `${e?.type || ''} ${e?.code || ''}`; } catch (_) { return ''; } })();
      // 429 also means "out of credit" (insufficient_quota): that's on the platform's account, not the user
      const message = /insufficient_quota|credit|billing/i.test(code) ? 'Illustrations are unavailable right now. Try again later.'
        : res.status === 429 ? 'Too many illustrations at once. Wait a minute and try again.'
        : res.status >= 500 ? 'The illustrator is busy right now. Try again in a minute.'
        : /safety|moderation/i.test(reason) ? 'That photo couldn\'t be illustrated. Try a different photo of the vehicle.'
        : `The illustrator couldn't take this request (${res.status}). Try again, or contact support if it keeps happening.`;
      return json({ error: 'openai', message, detail: reason }, 502);
    }
    const out = JSON.parse(text);
    let b64: string | null = out?.data?.[0]?.b64_json ?? null;
    if (!b64 && out?.data?.[0]?.url) { const r = await fetch(out.data[0].url); const buf = new Uint8Array(await r.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); b64 = btoa(s); }
    if (!b64) { console.error('no image', text.slice(0, 500)); return json({ error: 'no_image', message: 'No illustration came back. Try again.' }, 502); }
    await g.record({ input_tokens: out?.usage?.input_tokens, output_tokens: out?.usage?.output_tokens });
    return json({ ok: true, image: b64 });
  } catch (e) {
    console.error(e);
    return json({ error: 'exception', message: 'Something went wrong drawing the illustration. Try again.' }, 500);
  }
});
