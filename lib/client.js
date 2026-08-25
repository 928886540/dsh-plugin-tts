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

      const SETTINGS_KEY = "dsh-gmi-minimax-tts-v1";
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
        autoRead: false
      };

      function copy(o) { return Object.assign({}, o); }
      function loadSettings() {
        try {
          const raw = localStorage.getItem(SETTINGS_KEY);
          return Object.assign(copy(DEFAULTS), raw ? JSON.parse(raw) : {});
        } catch (_) { return copy(DEFAULTS); }
      }
      const shared = window.__dshGmiTtsShared || (window.__dshGmiTtsShared = {
        settings: loadSettings(),
        audioEl: null,
        speaking: false,
        currentText: "",
        speakToken: 0,
        lastSeqBySession: new Map(),
        listeners: new Set()
      });
      if (!shared.settings) shared.settings = loadSettings();

      function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(shared.settings)); } catch (_) {}
        notify();
      }
      function notify() {
        for (const fn of shared.listeners) { try { fn(); } catch (_) {} }
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
      function stopSpeaking() {
        shared.speakToken += 1;
        shared.speaking = false;
        shared.currentText = "";
        if (shared.audioEl) {
          try { shared.audioEl.pause(); } catch (_) {}
          try { shared.audioEl.removeAttribute("src"); shared.audioEl.load(); } catch (_) {}
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
        notify();
        try {
          const result = await rpcSpeak(text);
          if (token !== shared.speakToken) return { ok: false, error: "interrupted" };
          if (!result || result.error) {
            shared.speaking = false; shared.currentText = ""; notify();
            return { ok: false, error: String(result && result.error || "语音生成失败") };
          }
          const el = shared.audioEl;
          if (!el) {
            shared.speaking = false; shared.currentText = ""; notify();
            return { ok: false, error: "audio unavailable" };
          }
          el.onended = () => {
            if (token === shared.speakToken) { shared.speaking = false; shared.currentText = ""; notify(); }
          };
          el.onerror = () => {
            if (token === shared.speakToken) { shared.speaking = false; shared.currentText = ""; notify(); }
          };
          el.src = result.url;
          await el.play();
          return { ok: true, source };
        } catch (e) {
          if (token === shared.speakToken) { shared.speaking = false; shared.currentText = ""; notify(); }
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
        ".dsh-gmi-tts-field input,.dsh-gmi-tts-field select,.dsh-gmi-tts-field textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-divider-primary);background:var(--dsw-alias-bg-primary);color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;font:inherit}" +
        ".dsh-gmi-tts-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}" +
        ".dsh-gmi-tts-preview{display:flex;gap:8px}" +
        ".dsh-gmi-tts-preview input{flex:1}" +
        ".dsh-gmi-tts-primary{border:0;border-radius:8px;padding:8px 14px;background:var(--dsw-alias-brand-primary);color:white;cursor:pointer}" +
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
        react.useEffect(() => () => { shared.audioEl = null; }, []);
        return react.createElement("audio", {
          ref: el => { shared.audioEl = el; },
          style: { display: "none" },
          preload: "auto"
        });
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
            if (n && n.kind === "assistant" && typeof n.messageId === "string" && n.seq > maxSeq) {
              maxSeq = n.seq; newest = n;
            }
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
          type: "button",
          className: "dsh-gmi-tts-btn",
          "data-active": on || undefined,
          title: on ? "GMI 自动朗读：开" : "GMI 自动朗读：关",
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
        return react.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: 4 } },
          react.createElement("button", {
            type: "button",
            className: "dsh-gmi-tts-btn",
            "data-active": active || undefined,
            disabled: !plain || undefined,
            title: active ? "停止朗读" : "GMI MiniMax 朗读",
            onClick: async () => {
              const r = await speakText(plain, "manual");
              if (r && !r.ok && r.error !== "interrupted") {
                setErr(r.error); setTimeout(() => setErr(""), 5000);
              }
            }
          }, active ? "⏹ 停止" : "🔊 朗读"),
          err ? react.createElement("span", { className: "dsh-gmi-tts-error", title: err }, "⚠") : null
        );
      }
      slots.inject("conversation.chat.assistant-actions", () => slots.register(
        { name: "conversation.chat.assistant-actions", key: "gmi-tts-read", id: "gmi-tts-read", order: 20 },
        ReadAloudButton
      ));

      function Field(props) {
        return react.createElement("div", { className: "dsh-gmi-tts-field" },
          react.createElement("label", null, props.label),
          props.children,
          props.help ? react.createElement("div", { className: "dsh-gmi-tts-desc" }, props.help) : null
        );
      }

      function SettingsPanel() {
        const [cfg, setCfg] = react.useState(() => Object.assign({}, shared.settings));
        const [preview, setPreview] = react.useState("你好，这是 GMI Cloud MiniMax Speech 2.8 HD 测试。");
        const [msg, setMsg] = react.useState("");
        const [ok, setOk] = react.useState(false);
        const patch = (key, value) => setCfg(c => Object.assign({}, c, { [key]: value }));
        const persist = () => {
          shared.settings = Object.assign({}, cfg);
          saveSettings();
          setOk(true); setMsg("配置已保存"); setTimeout(() => setMsg(""), 2500);
        };
        const previewNow = async () => {
          shared.settings = Object.assign({}, cfg);
          saveSettings();
          setMsg("正在提交 GMI 任务并等待生成……"); setOk(true);
          const r = await speakText(preview, "preview");
          if (!r || !r.ok) { setOk(false); setMsg(String(r && r.error || "试听失败")); }
          else setMsg("生成成功，正在播放");
        };
        const input = (key, type, extra) => react.createElement("input", Object.assign({
          type: type || "text",
          value: cfg[key],
          onChange: e => patch(key, type === "number" ? Number(e.target.value) : e.target.value)
        }, extra || {}));
        const select = (key, values) => react.createElement("select", {
          value: cfg[key], onChange: e => patch(key, e.target.value)
        }, values.map(v => react.createElement("option", { key: v[0], value: v[0] }, v[1])));

        return react.createElement("div", { className: "dsh-gmi-tts-panel" },
          react.createElement("div", { className: "dsh-gmi-tts-title" }, "GMI MiniMax 语音"),
          react.createElement("div", { className: "dsh-gmi-tts-desc" }, "DSH Host 直接调用 GMI Cloud，因此不受浏览器 OPTIONS/CORS 限制。流程：提交任务 → request_id → 轮询 → 下载 MP3 → 本地播放。"),
          react.createElement(Field, { label: "GMI API Key", help: "保存在当前 DSH Web 的 localStorage；发送到本机 DSH Host，再由 Host 作为 Bearer 调用 GMI。" }, input("apiKey", "password", { autoComplete: "off" })),
          react.createElement(Field, { label: "API Endpoint" }, input("endpoint")),
          react.createElement(Field, { label: "模型" }, input("model")),
          react.createElement(Field, { label: "voice_id", help: "先用 GMI 文档示例 English_expressive_narrator 测通；确认其它 voice_id 可用后直接填。" }, input("voiceId")),
          react.createElement(Field, { label: "情绪" }, select("emotion", [
            ["auto","auto"],["calm","calm"],["happy","happy"],["sad","sad"],["angry","angry"],["fearful","fearful"],["disgusted","disgusted"],["surprised","surprised"]
          ])),
          react.createElement("div", { className: "dsh-gmi-tts-grid" },
            react.createElement(Field, { label: "speed" }, input("speed", "number", { min: .5, max: 2, step: .1 })),
            react.createElement(Field, { label: "vol" }, input("vol", "number", { min: 0, max: 10, step: .1 })),
            react.createElement(Field, { label: "pitch" }, input("pitch", "number", { min: -12, max: 12, step: 1 }))
          ),
          react.createElement("div", { className: "dsh-gmi-tts-grid" },
            react.createElement(Field, { label: "sample rate" }, select("sampleRate", [["8000","8000"],["16000","16000"],["22050","22050"],["24000","24000"],["32000","32000"],["44100","44100"]])),
            react.createElement(Field, { label: "bitrate" }, select("bitrate", [["32000","32000"],["64000","64000"],["128000","128000"],["256000","256000"]])),
            react.createElement(Field, { label: "channel" }, select("channel", [["1","1 - mono"],["2","2 - stereo"]]))
          ),
          react.createElement("div", { className: "dsh-gmi-tts-grid" },
            react.createElement(Field, { label: "vm_pitch" }, input("vmPitch", "number", { min: -100, max: 100, step: 1 })),
            react.createElement(Field, { label: "intensity" }, input("intensity", "number", { min: -100, max: 100, step: 1 })),
            react.createElement(Field, { label: "timbre" }, input("timbre", "number", { min: -100, max: 100, step: 1 }))
          ),
          react.createElement(Field, { label: "sound_effects" }, select("soundEffects", [["","none"],["spacious_echo","spacious_echo"],["auditorium_echo","auditorium_echo"],["lofi_telephone","lofi_telephone"],["robotic","robotic"]])),
          react.createElement("div", { style: { display: "flex", gap: 8 } },
            react.createElement("button", { type: "button", className: "dsh-gmi-tts-primary", onClick: persist }, "保存配置")
          ),
          react.createElement(Field, { label: "试听" },
            react.createElement("div", { className: "dsh-gmi-tts-preview" },
              react.createElement("input", { value: preview, onChange: e => setPreview(e.target.value) }),
              react.createElement("button", { type: "button", className: "dsh-gmi-tts-primary", onClick: previewNow }, "生成并播放")
            )
          ),
          msg ? react.createElement("div", { className: ok ? "dsh-gmi-tts-ok" : "dsh-gmi-tts-error" }, msg) : null
        );
      }

      slots.inject("settings.plugins.tab", () => slots.register(
        { name: "settings.plugins.tab", key: "tts", id: "tts", order: 20, label: () => "GMI 语音" },
        SettingsPanel
      ));
    };

    exports.apply = apply;
    return module.exports;
  }
});
