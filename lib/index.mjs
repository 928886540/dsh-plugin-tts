// GMI Cloud MiniMax Speech 2.8 HD provider for DSH.
// Host-side submission + polling. The final signed media URL is returned directly
// to the browser <audio> element, avoiding a second Node-side download hop.
import { createHash } from 'node:crypto';

export const name = 'tts';
export const inject = ['webServer'];

const DEFAULT_ENDPOINT = 'https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests';
const DEFAULT_MODEL = 'minimax-tts-speech-2.8-hd';
const DEFAULT_VOICE = 'English_expressive_narrator';
const POLL_INTERVAL_MS = 800;
const POLL_TIMEOUT_MS = 180000;

function writeJson(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function hashText(s) {
  return createHash('sha256').update(String(s || '')).digest('hex').slice(0, 16);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readJsonResponse(res, label) {
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch (_) {}
  if (!res.ok) {
    const detail = data && (data.message || data.error || data.detail)
      ? JSON.stringify(data)
      : text;
    throw new Error(`${label} HTTP ${res.status}: ${String(detail || res.statusText).slice(0, 800)}`);
  }
  if (!data) throw new Error(`${label} returned non-JSON: ${text.slice(0, 500)}`);
  return data;
}

function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const n = (v, fallback, min, max) => {
    let x = Number(v);
    if (!Number.isFinite(x)) x = fallback;
    return Math.min(max, Math.max(min, x));
  };
  const allowedEmotion = new Set(['auto', 'calm', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised']);
  const emotion = allowedEmotion.has(String(c.emotion || 'auto')) ? String(c.emotion || 'auto') : 'auto';
  return {
    apiKey: String(c.apiKey || '').trim(),
    endpoint: String(c.endpoint || DEFAULT_ENDPOINT).trim().replace(/\/+$/, ''),
    model: String(c.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    voiceId: String(c.voiceId || DEFAULT_VOICE).trim() || DEFAULT_VOICE,
    emotion,
    speed: n(c.speed, 1, 0.5, 2),
    vol: n(c.vol, 1, 0, 10),
    pitch: Math.round(n(c.pitch, 0, -12, 12)),
    sampleRate: String(c.sampleRate || '32000'),
    bitrate: String(c.bitrate || '128000'),
    channel: String(c.channel || '2') === '1' ? '1' : '2',
    vmPitch: Math.round(n(c.vmPitch, 0, -100, 100)),
    intensity: Math.round(n(c.intensity, 0, -100, 100)),
    timbre: Math.round(n(c.timbre, 0, -100, 100)),
    soundEffects: String(c.soundEffects || '')
  };
}

function buildGmiBody(text, cfg) {
  return {
    model: cfg.model,
    payload: {
      text,
      voice_id: cfg.voiceId,
      speed: String(cfg.speed),
      vol: String(cfg.vol),
      pitch: String(cfg.pitch),
      emotion: cfg.emotion,
      language_boost: 'auto',
      format: 'mp3',
      audio_sample_rate: cfg.sampleRate,
      bitrate: cfg.bitrate,
      channel: cfg.channel,
      vm_pitch: cfg.vmPitch,
      intensity: cfg.intensity,
      timbre: cfg.timbre,
      sound_effects: cfg.soundEffects
    }
  };
}

function mediaUrlFrom(data) {
  const list = data && data.outcome && data.outcome.media_urls;
  return Array.isArray(list) && list[0] && list[0].url ? String(list[0].url) : '';
}

async function submitGmi(text, cfg, signal) {
  let res;
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildGmiBody(text, cfg)),
      signal
    });
  } catch (e) {
    throw new Error(`GMI submit network error: ${String(e && e.message || e)}`);
  }
  return readJsonResponse(res, 'GMI submit');
}

async function pollGmi(requestId, cfg, signal) {
  const statusUrl = `${cfg.endpoint}/${encodeURIComponent(requestId)}`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = null;
  let consecutiveNetworkErrors = 0;

  while (Date.now() < deadline) {
    let res;
    try {
      res = await fetch(statusUrl, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal
      });
      consecutiveNetworkErrors = 0;
    } catch (e) {
      consecutiveNetworkErrors += 1;
      if (consecutiveNetworkErrors >= 8) {
        throw new Error(`GMI status network error after job submission: ${String(e && e.message || e)}`);
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const data = await readJsonResponse(res, 'GMI status');
    last = data;
    const status = String(data && data.status || '').toLowerCase();
    const mediaUrl = mediaUrlFrom(data);
    if (mediaUrl) return { mediaUrl, data };
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(`GMI task ${status}: ${JSON.stringify(data).slice(0, 800)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`GMI task timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s: ${JSON.stringify(last || {}).slice(0, 500)}`);
}

async function synthesizeGmi(text, cfg) {
  if (!cfg.apiKey) throw new Error('GMI API Key is empty. Open Settings -> Plugins -> GMI Voice and fill it first.');
  if (!/^https:\/\//i.test(cfg.endpoint)) throw new Error('GMI endpoint must be an https:// URL');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS + 15000);
  try {
    const submitted = await submitGmi(text, cfg, controller.signal);
    let mediaUrl = mediaUrlFrom(submitted);
    const requestId = String(submitted && submitted.request_id || '').trim();
    if (!mediaUrl) {
      if (!requestId) throw new Error(`GMI did not return request_id: ${JSON.stringify(submitted).slice(0, 800)}`);
      const polled = await pollGmi(requestId, cfg, controller.signal);
      mediaUrl = polled.mediaUrl;
    }
    if (!mediaUrl) throw new Error('GMI task succeeded but did not return an audio URL');
    return { mediaUrl, requestId };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('GMI request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function apply(ctx) {
  const webServer = ctx.get('webServer');
  if (!webServer) return;

  const cache = new Map();

  const speakDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-tts-api/speak',
    async handler(req, res) {
      try {
        let body = '';
        for await (const chunk of req) body += chunk;
        let parsed = null;
        try { parsed = JSON.parse(body || '{}'); } catch (_) {}
        const text = String(parsed && parsed.text || '').trim();
        if (!text) return writeJson(res, 400, { error: 'empty text' });
        if (text.length > 10000) return writeJson(res, 400, { error: 'text too long (max 10000 chars)' });

        const cfg = normalizeConfig(parsed && parsed.config);
        const cacheKey = hashText(JSON.stringify({ text, ...cfg, apiKey: hashText(cfg.apiKey) }));
        const hit = cache.get(cacheKey);
        if (hit && hit.url && Date.now() - hit.at < 10 * 60 * 1000) {
          return writeJson(res, 200, {
            url: hit.url,
            cached: true,
            provider: 'gmi-minimax',
            model: cfg.model
          });
        }

        const result = await synthesizeGmi(text, cfg);
        cache.set(cacheKey, { url: result.mediaUrl, at: Date.now() });
        while (cache.size > 60) cache.delete(cache.keys().next().value);

        writeJson(res, 200, {
          url: result.mediaUrl,
          provider: 'gmi-minimax',
          model: cfg.model,
          request_id: result.requestId || undefined
        });
      } catch (e) {
        writeJson(res, 500, { error: String(e && e.message || e) });
      }
    }
  });

  const diagDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-tts-api/gmi-diagnose',
    async handler(req, res) {
      writeJson(res, 200, {
        ok: true,
        provider: 'gmi-minimax',
        endpoint: DEFAULT_ENDPOINT,
        model: DEFAULT_MODEL,
        playback: 'direct-media-url'
      });
    }
  });

  ctx.effect(() => () => {
    try { speakDisposer && speakDisposer(); } catch (_) {}
    try { diagDisposer && diagDisposer(); } catch (_) {}
    cache.clear();
  }, 'dsh-plugin-tts-gmi: cleanup');
}
