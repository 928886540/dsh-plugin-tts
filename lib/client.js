// GMI Cloud MiniMax TTS client for DSH Web.
window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-plugin-tts",
  factory: require => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    const apply = ctx => {
      const slots = ctx.get("slots");
      if (!slots) return;

      const SETTINGS_KEY = "dsh-gmi-minimax-tts-v3";
      const LEGACY_KEYS = ["dsh-gmi-minimax-tts-v2", "dsh-gmi-minimax-tts-v1"];
      const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
      const DEFAULTS = {
        apiKey: "",
        endpoint: "https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests",
        model: "minimax-tts-speech-2.8-hd",
        voiceId: "English_expressive_narrator",
        emotion: "auto",
        speed: 1,
        vol: 1,
        pitch: 0,
        sampleRate: "32000",
        bitrate: "128000",
        channel: "2",
        vmPitch: 0,
        intensity: 0,
        timbre: 0,
        soundEffects: "",
        autoRead: false,
        progressive: true,
        chunkChars: 90
      };

      function loadSettings() {
        try {
          let raw = localStorage.getItem(SETTINGS_KEY);
          if (!raw) for (const key of LEGACY_KEYS) { raw = localStorage.getItem(key); if (raw) break; }
          return Object.assign({}, DEFAULTS, raw ? JSON.parse(raw) : {});
        } catch (_) { return Object.assign({}, DEFAULTS); }
      }

      const shared = window.__dshGmiTtsShared || (window.__dshGmiTtsShared = {
        settings: loadSettings(),
        audioEl: null,
        spareEl: null,
        speaking: false,
        currentText: "",
        currentJobId: null,
        chunkProgress: null,
        speakToken: 0,
        lastSeqBySession: new Map(),
        listeners: new Set(),
        unlocked: false
      });
      shared.settings = Object.assign({}, DEFAULTS, shared.settings || loadSettings());

      function notify() {
        for (const fn of shared.listeners) { try { fn(); } catch (_) {} }
      }
      function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(shared.settings)); } catch (_) {}
        notify();
      }
      function useSharedForce() {
        const [, setN] = react.useState(0);
        react.useEffect(() => {
          const fn = () => setN(n => n + 1);
          shared.listeners.add(fn);
          return () => shared.listeners.delete(fn);
        }, []);
      }
      function plainText(text) {
        return String(text || "")
          .replace(/```[\s\S]*?```/g, " ")
          .replace(/`([^`]*)`/g, "$1")
          .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
          .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/^#{1,6}\s+/gm, "")
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/\*([^*]+)\*/g, "$1")
          .replace(/__([^_]+)__/g, "$1")
          .replace(/~~([^~]+)~~/g, "$1")
          .replace(/^\s*[-*+]\s+/gm, "")
          .replace(/^\s*\d+\.\s+/gm, "")
          .replace(/[ \t]+/g, " ")
          .replace(/\s*\n\s*/g, " ")
          .trim();
      }
      function extractText(blocks) {
        let text = "";
        if (blocks) for (const b of blocks) {
          if (b && b.kind === "text" && typeof b.text === "string") text += (text ? "\n" : "") + b.text;
        }
        return text;
      }

      // Browsers/WebViews can lose the user activation while we wait several seconds
      // for GMI. Unlock the actual audio element on pointerdown/click, before any await.
      function unlockAudio() {
        const els = [shared.audioEl, shared.spareEl].filter(Boolean);
        if (!els.length) return;
        for (const el of els) {
          try {
            const oldVolume = el.volume;
            el.volume = 0;
            el.src = SILENT_WAV;
            el.load();
            const p = el.play();
            if (p && p.then) p.then(() => {
              try { el.pause(); el.currentTime = 0; el.volume = oldVolume == null ? 1 : oldVolume; } catch (_) {}
              shared.unlocked = true;
            }).catch(() => { try { el.volume = oldVolume == null ? 1 : oldVolume; } catch (_) {} });
          } catch (_) {}
        }
      }

      function installUnlockListeners() {
        const handler = () => unlockAudio();
        for (const ev of ["pointerdown", "mousedown", "touchstart", "keydown"]) {
          try { document.addEventListener(ev, handler, true); } catch (_) {}
        }
        return () => {
          for (const ev of ["pointerdown", "mousedown", "touchstart", "keydown"]) {
            try { document.removeEventListener(ev, handler, true); } catch (_) {}
          }
        };
      }
      ctx.effect(installUnlockListeners, "dsh-gmi-tts:audio-unlock");

      async function cancelJob() {
        const id = shared.currentJobId;
        shared.currentJobId = null;
        if (!id) return;
        try { await fetch("/dsh-tts-api/gmi-next?job=" + encodeURIComponent(id) + "&cancel=1"); } catch (_) {}
      }
      function stopSpeaking() {
        shared.speakToken += 1;
        shared.speaking = false;
        shared.currentText = "";
        shared.chunkProgress = null;
        cancelJob();
        for (const el of [shared.audioEl, shared.spareEl]) {
          if (!el) continue;
          try { el.pause(); } catch (_) {}
          try { el.removeAttribute("src"); el.load(); } catch (_) {}
        }
        notify();
      }

      async function rpcSpeak(text) {
        const response = await fetch("/dsh-tts-api/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, config: shared.settings })
        });
        const data = await response.json().catch(() => ({ error: "HTTP " + response.status }));
        if (!response.ok && !data.error) data.error = "HTTP " + response.status;
        return data;
      }
      async function fetchNext(jobId) {
        const r = await fetch("/dsh-tts-api/gmi-next?job=" + encodeURIComponent(jobId));
        const d = await r.json().catch(() => ({ done: true, error: "HTTP " + r.status }));
        if (!r.ok && !d.error) d.error = "HTTP " + r.status;
        return d;
      }

      function playUrl(el, url, token, label) {
        return new Promise((resolve, reject) => {
          if (!el) return reject(new Error("audio unavailable"));
          let settled = false;
          const cleanup = () => {
            el.onended = null;
            el.onerror = null;
          };
          const ok = () => { if (settled) return; settled = true; cleanup(); resolve(); };
          const fail = () => {
            if (settled) return;
            settled = true;
            cleanup();
            const mediaErr = el.error && el.error.code ? " mediaError=" + el.error.code : "";
            reject(new Error((label || "音频") + "播放失败" + mediaErr));
          };
          el.onended = ok;
          el.onerror = fail;
          try {
            el.pause();
            el.volume = 1;
            el.src = url;
            el.load();
            const p = el.play();
            if (p && p.catch) p.catch(e => {
              if (settled) return;
              settled = true;
              cleanup();
              const name = e && e.name ? e.name + ": " : "";
              reject(new Error((label || "音频") + "无法开始播放：" + name + String(e && e.message || e)));
            });
          } catch (e) {
            settled = true; cleanup(); reject(e);
          }
          if (token !== shared.speakToken) ok();
        });
      }

      async function playSingle(url, token) {
        await playUrl(shared.audioEl, url, token, "音频");
      }

      // Keep playing on ONE audio element. The spare element is preload-only.
      // This avoids WebView autoplay blocking when alternating between two players.
      async function playProgressive(jobId, initial, total, token) {
        const queue = initial.slice();
        let cursor = 0;
        let done = false;
        let inFlight = null;
        const player = shared.audioEl;
        const preloader = shared.spareEl;
        if (!player) throw new Error("audio unavailable");

        const topUp = () => {
          if (done || inFlight || token !== shared.speakToken) return inFlight;
          inFlight = fetchNext(jobId).then(r => {
            inFlight = null;
            if (r && r.error) { done = true; throw new Error(r.error); }
            if (r && r.url) queue.push(r.url);
            if (!r || r.done || r.more === false) done = true;
            return r;
          });
          return inFlight;
        };

        while (token === shared.speakToken) {
          while (cursor >= queue.length && !done) {
            await topUp();
            if (cursor >= queue.length && !done) await new Promise(r => setTimeout(r, 100));
          }
          if (cursor >= queue.length) break;

          if (queue.length - cursor < 2 && !done) topUp().catch(() => {});
          const url = queue[cursor];
          const next = queue[cursor + 1];
          if (next && preloader) {
            try { preloader.src = next; preloader.load(); } catch (_) {}
          }
          shared.chunkProgress = { index: cursor + 1, total };
          notify();
          await playUrl(player, url, token, "第 " + (cursor + 1) + " 段");
          cursor += 1;
        }
        if (inFlight) await inFlight.catch(e => { throw e; });
      }

      async function speakText(rawText, source) {
        const text = plainText(rawText);
        if (!text) return { ok: false, error: "没有可朗读文本" };
        if (shared.speaking && shared.currentText === text) {
          stopSpeaking();
          return { ok: true, stopped: true };
        }
        stopSpeaking();
        if (!shared.settings.apiKey) return { ok: false, error: "请先在 设置 → 插件 → GMI 语音 填写 API Key" };
        const token = ++shared.speakToken;
        shared.speaking = true;
        shared.currentText = text;
        shared.chunkProgress = null;
        notify();
        try {
          const result = await rpcSpeak(text);
          if (token !== shared.speakToken) return { ok: false, error: "interrupted" };
          if (!result || result.error) throw new Error(String(result && result.error || "语音生成失败"));

          if (Array.isArray(result.chunks) && result.chunks.length && result.jobId) {
            shared.currentJobId = result.jobId;
            await playProgressive(result.jobId, result.chunks, result.total || result.chunks.length, token);
          } else if (result.url) {
            await playSingle(result.url, token);
          } else {
            throw new Error("接口没有返回音频 URL");
          }

          if (token === shared.speakToken) {
            shared.speaking = false;
            shared.currentText = "";
            shared.currentJobId = null;
            shared.chunkProgress = null;
            notify();
          }
          return { ok: true, source };
        } catch (e) {
          if (token === shared.speakToken) {
            shared.speaking = false;
            shared.currentText = "";
            shared.currentJobId = null;
            shared.chunkProgress = null;
            notify();
          }
          return { ok: false, error: String(e && e.message || e) };
        }
      }

      const CSS =
        ".dsh-gmi-tts-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px}" +
        ".dsh-gmi-tts-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
        ".dsh-gmi-tts-btn[data-active=true]{color:var(--dsw-alias-brand-primary)}" +
        ".dsh-gmi-tts-panel{padding:16px;display:flex;flex-direction:column;gap:14px;max-width:760px}" +
        ".dsh-gmi-tts-title{font-size:18px;font-weight:700}" +
        ".dsh-gmi-tts-desc{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}" +
        ".dsh-gmi-tts-field{display:flex;flex-direction:column;gap:6px}" +
        ".dsh-gmi-tts-field label{font-size:12px;font-weight:600}" +
        ".dsh-gmi-tts-field input,.dsh-gmi-tts-field select{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-divider-primary);background:var(--dsw-alias-bg-primary);color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;font:inherit}" +
        ".dsh-gmi-tts-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}" +
        ".dsh-gmi-tts-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}" +
        ".dsh-gmi-tts-primary{border:0;border-radius:8px;padding:8px 14px;background:var(--dsw-alias-brand-primary);color:white;cursor:pointer}" +
        ".dsh-gmi-tts-secondary{border:1px solid var(--dsw-alias-divider-primary);border-radius:8px;padding:8px 14px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}" +
        ".dsh-gmi-tts-error{white-space:pre-wrap;color:var(--dsw-alias-label-danger,#ef4444);font-size:12px}" +
        ".dsh-gmi-tts-ok{white-space:pre-wrap;color:var(--dsw-alias-label-success,#16a34a);font-size:12px}" +
        "@media(max-width:700px){.dsh-gmi-tts-grid{grid-template-columns:1fr}}";
      function insertCss() {
        const tag = document.createElement("style");
        tag.dataset.pluginCss = "dsh-gmi-minimax-tts";
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => { if (tag.parentNode) tag.parentNode.removeChild(tag); };
      }
      ctx.effect(insertCss, "dsh-gmi-minimax-tts:styles");

      function AudioHost() {
        react.useEffect(() => () => { shared.audioEl = null; shared.spareEl = null; }, []);
        return react.createElement("div", { style: { display: "none" } },
          react.createElement("audio", { ref: el => { shared.audioEl = el; }, preload: "auto" }),
          react.createElement("audio", { ref: el => { shared.spareEl = el; }, preload: "auto" })
        );
      }
      slots.inject("shell.overlay", () => slots.register(
        { name: "shell.overlay", key: "gmi-tts-audio-host", id: "gmi-tts-audio-host", order: 1000 },
        AudioHost
      ));

      function AutoReadToggle(props) {
        useSharedForce();
        const on = !!shared.settings.autoRead;
        react.useEffect(() => {
          const session = props.session;
          if (!session) return;
          let maxSeq = -1, newest = null;
          if (session.nodes) for (const n of session.nodes) {
            if (n && n.kind === "assistant" && typeof n.messageId === "string" && n.seq > maxSeq) { maxSeq = n.seq; newest = n; }
          }
          if (!newest) return;
          const key = props.sessionId;
          const prev = shared.lastSeqBySession.get(key);
          if (prev === undefined) { shared.lastSeqBySession.set(key, maxSeq); return; }
          if (maxSeq > prev) {
            shared.lastSeqBySession.set(key, maxSeq);
            if (shared.settings.autoRead) {
              const text = extractText(newest.blocks);
              if (text.trim()) speakText(text, "auto");
            }
          }
        }, [props.session]);
        return react.createElement("button", {
          type: "button", className: "dsh-gmi-tts-btn", "data-active": on || undefined,
          title: on ? "GMI 自动朗读：开" : "GMI 自动朗读：关",
          onPointerDown: unlockAudio,
          onClick: () => { shared.settings.autoRead = !on; saveSettings(); if (on) stopSpeaking(); }
        }, "🎧 ", on ? "自动朗读 ON" : "自动朗读");
      }
      slots.inject("conversation.input.left", () => slots.register(
        { name: "conversation.input.left", key: "gmi-tts-autoread", id: "gmi-tts-autoread", order: 20 },
        AutoReadToggle
      ));

      function ReadAloudButton(props) {
        useSharedForce();
        const useSession = props.useSession;
        let nodes = null;
        if (useSession) nodes = useSession(s => s.nodes);
        let node = null;
        if (nodes) for (const n of nodes) {
          if (n && n.kind === "assistant" && n.messageId === props.messageId) { node = n; break; }
        }
        const plain = plainText(node ? extractText(node.blocks) : "");
        const active = shared.speaking && !!plain && shared.currentText === plain;
        const [err, setErr] = react.useState("");
        const cp = shared.chunkProgress;
        const label = active && cp && cp.total > 1 ? "⏹ " + cp.index + "/" + cp.total : (active ? "⏹ 停止" : "🔊 朗读");
        return react.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: 4 } },
          react.createElement("button", {
            type: "button", className: "dsh-gmi-tts-btn", "data-active": active || undefined,
            disabled: !plain || undefined, title: active ? "停止朗读" : "GMI MiniMax 朗读",
            onPointerDown: unlockAudio,
            onClick: async () => {
              unlockAudio();
              const r = await speakText(plain, "manual");
              if (r && !r.ok && r.error !== "interrupted") {
                setErr(r.error); setTimeout(() => setErr(""), 8000);
              }
            }
          }, label),
          err ? react.createElement("span", { className: "dsh-gmi-tts-error", title: err }, "⚠") : null
        );
      }
      slots.inject("conversation.chat.assistant-actions", () => slots.register(
        { name: "conversation.chat.assistant-actions", key: "gmi-tts-read", id: "gmi-tts-read", order: 20 },
        ReadAloudButton
      ));

      function Field(props) {
        return react.createElement("div", { className: "dsh-gmi-tts-field" },
          react.createElement("label", null, props.label), props.children,
          props.help ? react.createElement("div", { className: "dsh-gmi-tts-desc" }, props.help) : null
        );
      }

      function SettingsPanel() {
        const [cfg, setCfg] = react.useState(() => Object.assign({}, shared.settings));
        const [preview, setPreview] = react.useState("你好，这是 GMI Cloud MiniMax Speech 2.8 HD 测试。现在开启分段渐进播放。");
        const [msg, setMsg] = react.useState("");
        const [ok, setOk] = react.useState(false);
        const [updating, setUpdating] = react.useState(false);
        const patch = (key, value) => setCfg(c => Object.assign({}, c, { [key]: value }));
        const input = (key, type, extra) => react.createElement("input", Object.assign({
          type: type || "text", value: cfg[key],
          onChange: e => patch(key, type === "number" ? Number(e.target.value) : e.target.value)
        }, extra || {}));
        const select = (key, values) => react.createElement("select", {
          value: cfg[key], onChange: e => patch(key, e.target.value)
        }, values.map(v => react.createElement("option", { key: v[0], value: v[0] }, v[1])));
        const persist = () => {
          shared.settings = Object.assign({}, cfg); saveSettings();
          setOk(true); setMsg("配置已保存"); setTimeout(() => setMsg(""), 2500);
        };
        const previewNow = async () => {
          unlockAudio();
          shared.settings = Object.assign({}, cfg); saveSettings();
          setMsg("正在生成首段……后续段会边播边生成"); setOk(true);
          const r = await speakText(preview, "preview");
          if (!r || !r.ok) { setOk(false); setMsg(String(r && r.error || "试听失败")); }
          else if (r.stopped) { setOk(false); setMsg("已停止播放"); }
          else { setOk(true); setMsg("播放完成"); }
        };
        const updateNow = async () => {
          setUpdating(true); setOk(true); setMsg("正在从 GitHub 更新插件……");
          try {
            const r = await fetch("/dsh-tts-api/self-update", { method: "POST" });
            const d = await r.json().catch(() => null);
            if (!r.ok || !d || d.error) throw new Error(d && d.error || "HTTP " + r.status);
            setMsg("更新完成。请重启 dsh web 后生效。");
          } catch (e) {
            setOk(false); setMsg("更新失败：" + String(e && e.message || e));
          } finally { setUpdating(false); }
        };

        return react.createElement("div", { className: "dsh-gmi-tts-panel" },
          react.createElement("div", { className: "dsh-gmi-tts-title" }, "GMI MiniMax 语音"),
          react.createElement("div", { className: "dsh-gmi-tts-desc" },
            "GMI 本身是异步整段生成。本插件通过分段实现渐进播放；本版还会在点击时预先解锁 WebView 音频，避免生成完却无声。"
          ),
          Field({ label: "GMI API Key", children: input("apiKey", "password") }),
          Field({ label: "API Endpoint", children: input("endpoint") }),
          react.createElement("div", { className: "dsh-gmi-tts-grid" },
            Field({ label: "模型", children: input("model") }),
            Field({ label: "Voice ID", children: input("voiceId") }),
            Field({ label: "情感", children: select("emotion", [["auto","auto"],["calm","calm"],["happy","happy"],["sad","sad"],["angry","angry"],["fearful","fearful"],["surprised","surprised"]]) }),
            Field({ label: "语速", children: input("speed", "number", { step: "0.1", min: "0.5", max: "2" }) }),
            Field({ label: "音量", children: input("vol", "number", { step: "0.1" }) }),
            Field({ label: "音调", children: input("pitch", "number", { min: "-12", max: "12" }) }),
            Field({ label: "采样率", children: select("sampleRate", [["16000","16000"],["24000","24000"],["32000","32000"],["44100","44100"]]) }),
            Field({ label: "Bitrate", children: select("bitrate", [["64000","64000"],["128000","128000"],["256000","256000"]]) }),
            Field({ label: "Channel", children: select("channel", [["1","Mono"],["2","Stereo"]]) }),
            Field({ label: "每段字符数", children: input("chunkChars", "number", { min: "30", max: "300" }), help: "建议中文 60~100。越小首段越快，但请求次数更多。" })
          ),
          react.createElement("label", { className: "dsh-gmi-tts-row" },
            react.createElement("input", { type: "checkbox", checked: cfg.progressive !== false, onChange: e => patch("progressive", e.target.checked) }),
            "长文本渐进播放（推荐）"
          ),
          react.createElement("div", { className: "dsh-gmi-tts-row" },
            react.createElement("button", { type: "button", className: "dsh-gmi-tts-primary", onClick: persist }, "保存配置"),
            react.createElement("button", { type: "button", className: "dsh-gmi-tts-secondary", disabled: updating, onClick: updateNow }, updating ? "更新中…" : "检查并更新插件")
          ),
          Field({ label: "试听文本", children: react.createElement("div", { className: "dsh-gmi-tts-row" },
            react.createElement("input", { style: { flex: 1 }, value: preview, onChange: e => setPreview(e.target.value) }),
            react.createElement("button", { type: "button", className: "dsh-gmi-tts-primary", onPointerDown: unlockAudio, onClick: previewNow }, "试听")
          ) }),
          msg ? react.createElement("div", { className: ok ? "dsh-gmi-tts-ok" : "dsh-gmi-tts-error" }, msg) : null
        );
      }

      slots.inject("settings.plugins.tab", () => slots.register(
        { name: "settings.plugins.tab", key: "gmi-tts", id: "gmi-tts", order: 20, label: () => "GMI 语音" },
        SettingsPanel
      ));
    };

    exports.apply = apply;
    return module.exports;
  }
});