// GMI Cloud MiniMax Speech 2.8 HD provider for DSH.
// Progressive playback is implemented by splitting long text into sentence chunks:
// GMI itself is an async request-queue API (not a true streaming audio API), so the
// plugin starts playing chunk 1 while later chunks are generated in the background.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export const name = 'tts';
export const inject = ['webServer'];

const DEFAULT_ENDPOINT = 'https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests';
const DEFAULT_MODEL = 'minimax-tts-speech-2.8-hd';
const DEFAULT_VOICE = 'English_expressive_narrator';
const POLL_INTERVAL_MS = 800;
const POLL_TIMEOUT_MS = 180000;
const UPDATE_REPO = 'github:928886540/dsh-plugin-tts#main';

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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
    soundEffects: String(c.soundEffects || ''),
    progressive: c.progressive !== false,
    chunkChars: Math.round(n(c.chunkChars, 90, 30, 300))
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
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
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
  let networkErrors = 0;
  while (Date.now() < deadline) {
    let res;
    try {
      res = await fetch(statusUrl, { headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal });
      networkErrors = 0;
    } catch (e) {
      networkErrors++;
      if (networkErrors >= 8) throw new Error(`GMI status network error: ${String(e && e.message || e)}`);
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
  throw new Error(`GMI task timed out: ${JSON.stringify(last || {}).slice(0, 500)}`);
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

function isLatinHeavy(text) {
  let latin = 0, cjk = 0;
  for (const ch of String(text || '')) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x4e00 && cp <= 0x9fff) cjk++;
    else if (/[A-Za-z0-9]/.test(ch)) latin++;
  }
  return latin > cjk * 2;
}

function splitText(text, chunkChars) {
  const maxChars = isLatinHeavy(text) ? Math.min(300, chunkChars * 2) : chunkChars;
  const src = String(text || '').trim();
  if (src.length <= maxChars) return [src];
  const sentences = src.match(/[^。！？；.!?;]+[。！？；.!?;]?/g) || [src];
  const out = [];
  let cur = '';
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if (s.length <= maxChars) {
      if (cur && cur.length + s.length > maxChars) flush();
      cur += s;
      continue;
    }
    const segs = s.match(/[^，、,]+[，、,]?/g) || [s];
    for (const seg0 of segs) {
      const seg = seg0.trim();
      if (!seg) continue;
      if (cur && cur.length + seg.length > maxChars) flush();
      if (seg.length > maxChars) {
        flush();
        for (let i = 0; i < seg.length; i += maxChars) out.push(seg.slice(i, i + maxChars));
      } else cur += seg;
    }
  }
  flush();
  return out.filter(Boolean);
}

function runSelfUpdate() {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
    const args = ['plugin', '--profile', 'web', 'add', UPDATE_REPO];
    const child = spawn(cmd, args, { shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error('更新超时（120 秒）'));
    }, 120000);
    child.stdout && child.stdout.on('data', d => { stdout += String(d); });
    child.stderr && child.stderr.on('data', d => { stderr += String(d); });
    child.on('error', err => { clearTimeout(timer); reject(new Error(`无法启动 dsh 更新命令：${err.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, output: (stdout || stderr).trim().slice(-2000) });
      else reject(new Error(`dsh 更新失败（exit ${code}）：${(stderr || stdout).trim().slice(-1200)}`));
    });
  });
}

export function apply(ctx) {
  const webServer = ctx.get('webServer');
  if (!webServer) return;

  const cache = new Map();
  const jobs = new Map();
  let jobSeq = 0;

  async function synthCached(text, cfg) {
    const key = hashText(JSON.stringify({ text, ...cfg, apiKey: hashText(cfg.apiKey) }));
    const hit = cache.get(key);
    if (hit && hit.url && Date.now() - hit.at < 10 * 60 * 1000) return { mediaUrl: hit.url, cached: true };
    const r = await synthesizeGmi(text, cfg);
    cache.set(key, { url: r.mediaUrl, at: Date.now() });
    while (cache.size > 100) cache.delete(cache.keys().next().value);
    return r;
  }

  async function nextChunk(job) {
    if (!job || job.cancelled || job.nextIndex >= job.parts.length) return { done: true };
    const index = job.nextIndex++;
    const text = job.parts[index];
    try {
      const r = await synthCached(text, job.cfg);
      return { url: r.mediaUrl, index: index + 1, total: job.parts.length, more: job.nextIndex < job.parts.length };
    } catch (e) {
      return { error: String(e && e.message || e), index: index + 1, total: job.parts.length, done: true };
    }
  }

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
        const parts = cfg.progressive ? splitText(text, cfg.chunkChars) : [text];

        if (parts.length > 1) {
          const id = `gmi-${Date.now().toString(36)}-${(++jobSeq).toString(36)}`;
          const job = { id, cfg, parts, nextIndex: 0, cancelled: false, createdAt: Date.now() };
          jobs.set(id, job);
          const first = await nextChunk(job);
          if (first.error) { jobs.delete(id); return writeJson(res, 500, { error: first.error }); }
          return writeJson(res, 200, {
            jobId: id,
            chunks: [first.url],
            total: parts.length,
            progressive: true,
            provider: 'gmi-minimax',
            model: cfg.model
          });
        }

        const result = await synthCached(text, cfg);
        writeJson(res, 200, { url: result.mediaUrl, provider: 'gmi-minimax', model: cfg.model, progressive: false });
      } catch (e) {
        writeJson(res, 500, { error: String(e && e.message || e) });
      }
    }
  });

  const nextDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-tts-api/gmi-next',
    async handler(req, res) {
      const q = new URL(req.url || '', 'http://x').searchParams;
      const id = q.get('job') || '';
      const job = jobs.get(id);
      if (!job) return writeJson(res, 200, { done: true, gone: true });
      if (q.get('cancel') === '1') {
        job.cancelled = true;
        jobs.delete(id);
        return writeJson(res, 200, { done: true, cancelled: true });
      }
      const r = await nextChunk(job);
      if (r.done || r.error || job.nextIndex >= job.parts.length) jobs.delete(id);
      writeJson(res, 200, r);
    }
  });

  const updateDisposer = webServer.register({
    kind: 'exact',
    path: '/dsh-tts-api/self-update',
    async handler(req, res) {
      if (req.method && String(req.method).toUpperCase() !== 'POST') return writeJson(res, 405, { error: 'POST required' });
      try {
        const r = await runSelfUpdate();
        writeJson(res, 200, { ok: true, restartRequired: true, output: r.output });
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
        playback: 'progressive-chunks',
        note: 'GMI itself is async/non-streaming; long text is split into chunks for progressive playback.'
      });
    }
  });

  const gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) if (now - job.createdAt > 10 * 60 * 1000) jobs.delete(id);
  }, 60000);
  if (gcTimer.unref) gcTimer.unref();

  ctx.effect(() => () => {
    clearInterval(gcTimer);
    for (const disposer of [speakDisposer, nextDisposer, updateDisposer, diagDisposer]) {
      try { disposer && disposer(); } catch (_) {}
    }
    jobs.clear();
    cache.clear();
  }, 'dsh-plugin-tts-gmi: cleanup');
}
