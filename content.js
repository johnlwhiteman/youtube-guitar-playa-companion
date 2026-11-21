// YouTube Guitar Playa Companion — content script
// A/B loop + pitch-preserving speed control + metronome + saved sessions.
(() => {
  const prev = window.__ygcInstance;
  if (prev && prev.alive()) return;
  try {
    if (prev) prev.teardown();
  } catch (e) {}
  const me = { alive: () => extensionAlive(), teardown: () => teardown() };
  window.__ygcInstance = me;

  // ---------- state ----------
  const state = {
    videoId: null,
    a: null,
    b: null,
    looping: false,
    speed: 1,
    loopCount: 0,
    waiting: false,
    waitTimer: null,
    saved: [],
    settings: {
      delay: 0, // seconds of silence between loops
      collapsed: false,
      metroOpen: true, // metronome section unfolded
      trainer: { on: false, step: 5, limit: 100, start: null }, // change speed each loop
      theme: "dark", // system | light | dark  (Night by default)
      metronome: { bpm: 120, beats: 4, accent: true, vol: 70, cat: true },
      hidden: false,
      pos: null, // {left, top}
    },
  };
  let dead = false; // set when the extension is removed, disabled or reloaded
  let enforceSpeedUntil = 0;

  // ---------- helpers ----------
  // The main video is the biggest one on the page (YouTube also keeps small hover-preview players around).
  let mainVideo = null;
  const getVideo = () => {
    const vids = document.querySelectorAll("#movie_player video, video.html5-main-video");
    let best = null,
      area = -1;
    vids.forEach((v) => {
      const r = v.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > area) {
        area = a;
        best = v;
      }
    });
    if (best !== mainVideo) {
      if (mainVideo) mainVideo.removeAttribute("data-ygc-main");
      mainVideo = best;
    }
    if (best && !best.hasAttribute("data-ygc-main")) best.setAttribute("data-ygc-main", "");
    return best;
  };
  const isAd = () => !!document.querySelector("#movie_player.ad-showing");
  const getVideoId = () => {
    const u = new URL(location.href);
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const m = u.pathname.match(/^\/(shorts|live)\/([^/?#]+)/);
    return m ? m[2] : null;
  };
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  // speed is shown in percent: 25% … 500%
  const SPEED_MIN = 0.25, SPEED_MAX = 5;
  const fmtSpeed = (r) => `${Math.round(r * 100)}%`;
  function parseSpeed(t) {
    t = String(t).trim().toLowerCase().replace(/\s/g, "").replace(",", ".");
    if (t === "normal") return 1;
    const mult = /x|×/.test(t); // "0.8x" also works
    let n = parseFloat(t.replace(/[%x×]/g, ""));
    if (!isFinite(n)) return null;
    if (!mult) n /= 100; // plain numbers are percent: "80" or "80%"
    return n >= SPEED_MIN - 1e-9 && n <= SPEED_MAX + 1e-9 ? n : null;
  }
  const round2 = (x) => Math.round(x * 100) / 100;

  function fmt(t) {
    if (t == null || isNaN(t)) return "";
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, "0")}`;
  }
  function parseTime(str) {
    str = String(str).trim();
    if (!str) return null;
    const parts = str.split(":").map(Number);
    if (parts.some((p) => isNaN(p))) return null;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }

  // ---------- storage ----------
  const store = {
    get: (k) =>
      new Promise((r) => {
        try {
          chrome.storage.local.get(k, (o) => r(o ? o[k] : undefined));
        } catch (e) {
          r(undefined);
        }
      }),
    set: (k, v) => {
      try {
        return chrome.storage.local.set({ [k]: v });
      } catch (e) {}
    },
  };
  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      store.set("settings", state.settings);
      if (state.videoId) {
        store.set("video:" + state.videoId, {
          saved: state.saved,
          last: { a: state.a, b: state.b, speed: state.speed },
          loopId: state.loopId || null,
        });
      }
    }, 300);
  }

  // ---------- speed (pitch preserved) ----------
  // YouTube keeps re-applying its own speed to the <video> and only accepts its own preset speeds.
  // So page-bridge.js (running in YouTube's page) locks the main video at the companion's speed,
  // and we also set it directly here and re-check it constantly. Works looping or not.
  let bridgeRate = null;
  function syncBridge(force) {
    const want = dead || state.settings.hidden ? 0 : state.speed;
    if (!force && want === bridgeRate) return;
    bridgeRate = want;
    window.postMessage({ source: "ygc2", type: "force-rate", rate: want }, "*");
  }
  const tellYouTube = () => syncBridge(true);
  let lastPong = 0;
  const lockActive = () => Date.now() - lastPong < 5000;
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.source === "ygc2-page" && e.data.type === "pong") lastPong = Date.now();
  });
  function applySpeed() {
    syncBridge(false);
    const v = getVideo();
    if (dead || !v || isAd() || state.settings.hidden) return;
    if (lockActive()) return; // the page-side lock is holding the speed
    // fallback if the page-side lock isn't running
    if (!v.preservesPitch) v.preservesPitch = true;
    if (Math.abs(v.playbackRate - state.speed) > 0.001) v.playbackRate = state.speed;
  }
  function setSpeed(s, byTrainer) {
    if (!byTrainer && state.settings.trainer) state.settings.trainer.start = round2(clamp(s, SPEED_MIN, SPEED_MAX));
    state.speed = round2(clamp(s, SPEED_MIN, SPEED_MAX));
    tellYouTube();
    applySpeed();
    persist();
    render();
  }
  // ---------- transport ----------
  function isPlaying() {
    const v = getVideo();
    return !!v && (!v.paused || state.waiting);
  }
  function playPause() {
    const v = getVideo();
    if (!v) return;
    if (isPlaying()) {
      cancelWait();
      v.pause();
    } else {
      if (state.looping && loopValid() && (v.currentTime < state.a || v.currentTime >= state.b)) v.currentTime = state.a;
      v.play();
    }
    render();
  }
  // Jump to B. While looping, land 2 s before B so you hear the end of the loop instead of bouncing straight back to A.
  function goToB() {
    const v = getVideo();
    if (!v || state.b == null) return flash("Set B first");
    cancelWait();
    v.currentTime = state.looping && loopValid() ? Math.max(state.a, state.b - 2) : state.b;
    v.play();
  }

  // ---------- looping ----------
  function loopValid() {
    return state.a != null && state.b != null && state.b - state.a > 0.05;
  }
  function cancelWait() {
    state.waiting = false;
    clearTimeout(state.waitTimer);
  }
  function wrap(v) {
    state.loopCount++;
    trainerStep();
    metro.restartPending = metro.on; // the metronome restarts with the loop
    if (state.settings.delay > 0) {
      state.waiting = true;
      v.pause();
      v.currentTime = state.a;
      clearTimeout(state.waitTimer);
      state.waitTimer = setTimeout(() => {
        state.waiting = false;
        if (state.looping) v.play();
        render();
      }, state.settings.delay * 1000);
    } else {
      v.currentTime = state.a;
    }
    render();
  }
  // "Change speed each loop": move the speed by `step` % per loop until `limit` %, then stay there
  function trainerStep() {
    const t = state.settings.trainer;
    if (!t || !t.on || !t.step) return;
    const lim = t.limit / 100;
    const cur = state.speed;
    const next = t.step > 0 ? Math.min(cur + t.step / 100, Math.max(lim, cur)) : Math.max(cur + t.step / 100, Math.min(lim, cur));
    if (Math.abs(next - cur) < 0.001) return;
    setSpeed(next, true);
    const reached = Math.abs(state.speed - lim) < 0.001;
    flash(reached ? `Speed ${fmtSpeed(state.speed)}: limit reached` : `Speed ${fmtSpeed(state.speed)}`);
  }
  function checkLoop() {
    if (dead) return;
    const v = getVideo();
    if (!v || !state.looping || !loopValid() || state.waiting || v.paused || isAd()) return;
    const t = v.currentTime;
    // Only wrap when playback runs past B naturally — if you manually seek far past B, we leave you alone.
    if (t >= state.b && t < state.b + 1.5) wrap(v);
  }
  // live "Now" time readout (updates only when the shown value changes)
  const fmtDur = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  function updateNow() {
    if (state.settings.hidden || !state.videoId) return;
    const v = mainVideo && mainVideo.isConnected ? mainVideo : getVideo();
    if (!v) return;
    const now = fmt(v.currentTime);
    const nowEl = $("nowTime");
    if (nowEl.textContent !== now) nowEl.textContent = now;
    const dur = isFinite(v.duration) && v.duration > 0 ? "/ " + fmtDur(v.duration) : "";
    const durEl = $("durTime");
    if (durEl.textContent !== dur) durEl.textContent = dur;
  }
  function rafLoop() {
    if (dead) return;
    checkLoop();
    updateNow();
    requestAnimationFrame(rafLoop);
  }

  function setA(t) {
    const v = getVideo();
    if (t == null && v) t = v.currentTime;
    if (t == null) return;
    const fromButton = arguments.length === 0;
    state.a = Math.max(0, round2(t));
    if (state.b != null && state.b <= state.a) state.b = null;
    if (!loopValid()) state.looping = false;
    persist();
    render();
    if (fromButton) flash(`A set at ${fmt(state.a)}`);
  }
  // Setting B from the button/shortcut (no explicit time) starts the loop right away if A is set.
  function setB(t) {
    if (state.a == null) return flash("Set A first");
    const v = getVideo();
    const fromButton = t == null;
    if (fromButton && v) t = v.currentTime;
    if (t == null) return;
    const dur = v && isFinite(v.duration) ? v.duration : Infinity;
    state.b = round2(Math.min(t, dur));
    if (state.a != null && state.a >= state.b) state.a = null;
    if (!loopValid()) state.looping = false;
    persist();
    if (fromButton && loopValid() && !state.looping) toggleLoop(true);
    else {
      render();
      if (fromButton) flash(loopValid() ? `B set at ${fmt(state.b)}` : `B set at ${fmt(state.b)}. Now set A before it`);
    }
  }
  function clearLoop() {
    const saved = typeof selectedLoop === "function" ? selectedLoop() : null;
    state.a = state.b = null;
    state.looping = false;
    cancelWait();
    if (saved) return deleteLoop(videoEntry(), saved, `Cleared and removed: ${saved.name}`);
    persist();
    render();
    flash("Loop cleared");
  }

  function toggleLoop(force) {
    const on = force != null ? force : !state.looping;
    if (on && !loopValid()) {
      flash("Set A and B first");
      return;
    }
    state.looping = on;
    state.loopCount = 0;
    cancelWait();
    const v = getVideo();
    if (on && v && (v.currentTime < state.a || v.currentTime >= state.b)) v.currentTime = state.a;
    render();
    flash(on ? `Looping ${fmt(state.a)}–${fmt(state.b)}` : "Loop off");
  }
  function goToA() {
    const v = getVideo();
    if (v && state.a != null) {
      cancelWait();
      v.currentTime = state.a;
      v.play();
    }
  }

  // ---------- UI ----------
  const host = document.createElement("div");
  host.id = "yt-guitar-companion-host";
  host.style.cssText = "position:fixed;z-index:2147483000;right:20px;bottom:20px;";
  const root = host.attachShadow({ mode: "open" });
  // Stop YouTube's keyboard shortcuts from firing while typing in our inputs
  ["keydown", "keyup", "keypress"].forEach((ev) => host.addEventListener(ev, (e) => e.stopPropagation()));

  root.innerHTML = `
  <style>
    :host { all: initial;
      --bg:#181818; --head:#222; --text:#eee; --strong:#fff; --muted:#a8a8a8; --btn:#2c2c2c; --btn-h:#3a3a3a;
      --hbtn:#2f2f2f; --hbtn-b:#4a4a4a; --border:#3a3a3a; --line:#2c2c2c; --input:#0f0f0f; --accent:#3ea6ff; --accent-text:#0f0f0f;
      --item:#222; --item-h:#2c2c2c; --shadow:rgba(0,0,0,.5); --ok:#7bd88f; --bad:#ff6b6b; --dot:#3a3a3a;
      --info-bg:#1d3047; --info-text:#e8f2ff; --info-border:#3a6ea5; --warn-bg:#5c1a1a; --warn-text:#fff; --backdrop:rgba(0,0,0,.55);
      --green:#2ba640; --red:#d93025; }
    :host([data-theme="light"]) {
      --bg:#ffffff; --head:#f1f3f4; --text:#1f1f1f; --strong:#000; --muted:#5f6368; --btn:#f1f3f4; --btn-h:#e2e5e8;
      --hbtn:#ffffff; --hbtn-b:#c6cacf; --border:#c6cacf; --line:#e3e5e8; --input:#ffffff; --accent:#065fd4; --accent-text:#fff;
      --item:#f6f7f8; --item-h:#eceef1; --shadow:rgba(0,0,0,.2); --ok:#137333; --bad:#c5221f; --dot:#d2d5d9;
      --info-bg:#e8f0fe; --info-text:#0b3d91; --info-border:#a8c7fa; --warn-bg:#fce8e6; --warn-text:#5c1a1a; --backdrop:rgba(0,0,0,.35); }
    * { box-sizing: border-box; font-family: Roboto, Arial, sans-serif; }
    .panel { width: 320px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 12px;
      box-shadow: 0 8px 30px var(--shadow); font-size: 13px; overflow: hidden; position: relative; }
    .head { display:flex; align-items:center; gap:6px; padding:8px 10px; background:var(--head); cursor:move; user-select:none; }
    .head .title { flex:1; font-weight:600; font-size:13px; line-height:1.15; color:var(--strong); }
    .head .logo { width:24px; height:24px; display:block; flex:none; }
    .hbtn { position:relative; width:28px; height:24px; padding:0; display:inline-flex; align-items:center; justify-content:center; flex:none;
      font-size:15px; font-weight:700; line-height:1; color:var(--text); background:var(--hbtn); border:1px solid var(--hbtn-b); border-radius:6px; }
    .hbtn:hover { background:var(--btn-h); }
    .hbtn.exit:hover { background:var(--red); border-color:var(--red); color:#fff; }
    .hico { display:block; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
    .badge { position:absolute; top:-6px; right:-6px; min-width:15px; height:15px; padding:0 3px; border-radius:8px; background:var(--accent);
      color:var(--accent-text); font-size:10px; font-weight:700; line-height:15px; text-align:center; }
    .metro-top { display:flex; align-items:center; gap:6px; }
    .bpm { font-size:20px; font-weight:700; min-width:64px; text-align:center; white-space:nowrap; color:var(--strong); }
    .bpm small { font-size:11px; font-weight:400; color:var(--muted); margin-left:2px; }
    .seg { display:flex; gap:3px; }
    .seg button { padding:3px 0; width:24px; }
    .seg button.active, .presets button.active { border-color:var(--accent); color:var(--accent); font-weight:600; }
    .dots { display:flex; gap:6px; align-items:center; }
    .dots span { width:10px; height:10px; border-radius:50%; background:var(--dot); transition:background .05s; }
    .dots span.accent { width:12px; height:12px; }
    .dots span.hit { background:var(--accent); }
    .dots span.accent.hit { background:#ff4e45; }
    .neko-wrap { display:flex; justify-content:center; }
    .neko { display:block; }
    .neko.listening { animation: ygc-tilt 1.1s ease-in-out infinite; transform-origin: 50% 85%; }
    @keyframes ygc-tilt { 0%,100% { transform: rotate(0deg); } 30% { transform: rotate(-7deg); } 70% { transform: rotate(4deg); } }
    .ico-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; }
    .cat-ico { display:block; flex:none; }
    #detect.busy { border-color:var(--accent); color:var(--accent); }
    .name-in { flex:1; min-width:0; width:auto !important; }
    .savebtn { display:inline-flex; align-items:center; justify-content:center; gap:5px; min-width:70px; font-weight:600; }
    .savebtn .hico { stroke-width:1.6; }
    .savebtn.is-saved, .savebtn.is-saved:disabled, .savebtn.is-saved:disabled:hover { background:var(--green); border-color:var(--green); color:#fff; opacity:1; }
    input[type=range].vol { flex:0 0 64px; width:64px; }
    .body { padding:10px; display:flex; flex-direction:column; gap:10px; max-height:calc(100vh - 90px); overflow-y:auto; }
    .collapsed .body { display:none; }
    .row { display:flex; align-items:center; gap:6px; }
    .lbl { width:16px; font-weight:700; color:var(--accent); }
    input[type=text], input[type=number], textarea { background:var(--input); color:var(--text); border:1px solid var(--border); border-radius:6px;
      padding:4px 6px; font-size:13px; width:70px; }
    input[type=number] { width:52px; }
    input:focus, textarea:focus { outline:none; border-color:var(--accent); }
    input:disabled { opacity:.35; }
    button { background:var(--btn); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:4px 8px;
      font-size:12px; cursor:pointer; white-space:nowrap; }
    button:hover { background:var(--btn-h); }
    button:disabled, button:disabled:hover { opacity:.35; cursor:default; background:var(--btn); }
    button.small { padding:4px 6px; min-width:26px; }
    button.primary { background:var(--accent); color:var(--accent-text); border-color:var(--accent); font-weight:600; }
    button.play { font-weight:600; font-size:13px; }
    button.on { background:var(--green); border-color:var(--green); color:#fff; font-weight:600; }
    .now { display:flex; align-items:baseline; gap:8px; }
    #nowTime { font-size:20px; font-weight:700; font-variant-numeric:tabular-nums; color:var(--strong); }
    .now .vidsave { margin-left:auto; align-self:center; display:inline-flex; align-items:center; gap:4px; padding:2px 8px; font-size:11px; font-weight:600; }
    .now .vidsave .hico { stroke-width:1.6; }
    .now .vidsave.is-saved, .now .vidsave.is-saved:disabled, .now .vidsave.is-saved:disabled:hover { background:transparent; border-color:transparent; color:var(--green); opacity:1; cursor:default; }
    #durTime { font-variant-numeric:tabular-nums; }
    .novideo { background:var(--info-bg); color:var(--info-text); border:1px solid var(--info-border); border-radius:8px;
      padding:8px 10px; font-size:12.5px; line-height:1.4; font-weight:500; }
    .actual { font-size:11px; color:var(--ok); }
    .actual.bad { color:var(--bad); font-weight:600; }
    .warn { display:none; background:var(--warn-bg); border:1px solid var(--red); color:var(--warn-text); border-radius:8px; padding:8px; font-size:12px; line-height:1.4; }
    .warn.show { display:flex; flex-direction:column; gap:6px; }
    .warn button { align-self:flex-start; background:var(--red); border-color:var(--red); color:#fff; font-weight:600; }
    .vsec { display:flex; flex-direction:column; gap:10px; }
    .grow { flex:1; }
    .speedval { font-size:20px; font-weight:700; width:56px; text-align:center; color:var(--strong); }
    input[type=text].speedin { width:62px; font-size:16px; font-weight:700; text-align:center; color:var(--strong); padding:3px 4px; }
    input[type=range] { flex:1; min-width:0; width:0; accent-color:var(--accent); }
    .presets { display:flex; gap:4px; flex-wrap:wrap; }
    .presets button { flex:1; padding:3px 0; }
    .section { border-top:1px solid var(--line); padding-top:8px; display:flex; flex-direction:column; gap:6px; }
    .muted { color:var(--muted); font-size:11px; }
    .toast { position:absolute; left:50%; top:44px; transform:translateX(-50%); background:var(--accent); color:var(--accent-text);
      padding:4px 10px; border-radius:6px; font-size:12px; opacity:0; transition:opacity .2s; pointer-events:none; z-index:3; max-width:290px; text-align:center; }
    .toast.show { opacity:1; }
    label.chk { display:flex; align-items:center; gap:6px; cursor:pointer; }
    .chkrow { gap:18px; }

    /* pop-ups (saved videos, help) */
    .modal-back { position:fixed; inset:0; background:var(--backdrop); display:none; align-items:center; justify-content:center; z-index:10; }
    .modal-back.show { display:flex; }
    .modal { width:440px; max-width:calc(100vw - 32px); max-height:80vh; background:var(--bg); color:var(--text); border:1px solid var(--border);
      border-radius:12px; box-shadow:0 12px 40px var(--shadow); display:flex; flex-direction:column; overflow:hidden; font-size:13px; }
    .modal-head { display:flex; align-items:center; gap:8px; padding:10px 12px; background:var(--head); font-weight:600; color:var(--strong); }
    .modal-body { overflow:auto; padding:12px; }

    /* saved videos manager */
    .lib { display:flex; flex-direction:column; gap:6px; }
    .lib .empty { color:var(--muted); font-size:12px; }
    .lib .item { display:flex; gap:8px; align-items:center; padding:6px; border-radius:8px; background:var(--item); border:1px solid transparent; }
    .lib .item.current { border-color:var(--accent); }
    .lib .pick { display:flex; gap:8px; align-items:center; flex:1; min-width:0; cursor:pointer; border-radius:6px; }
    .lib .pick:hover .name { color:var(--accent); text-decoration:underline; }
    .lib img { width:64px; height:36px; object-fit:cover; border-radius:4px; flex:none; background:#000; }
    .lib .meta { flex:1; min-width:0; }
    .lib .name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:13px; font-weight:600; color:var(--strong); }
    .lib .desc { color:var(--text); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:.85; }
    .lib .sub { color:var(--muted); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .lib .order { display:flex; flex-direction:column; gap:2px; flex:none; }
    .lib .order button { padding:0; width:22px; height:16px; display:flex; align-items:center; justify-content:center; }
    .lib .acts { display:flex; gap:4px; flex:none; }
    .lib .acts button { width:30px; height:28px; padding:0; display:inline-flex; align-items:center; justify-content:center; }
    .lib .acts .del:hover, .lib .acts .del.confirm { background:var(--red); border-color:var(--red); color:#fff; }
    .lib .acts .del.confirm { width:auto; padding:0 8px; font-weight:600; }
    .lib .edit { flex:1; display:flex; flex-direction:column; gap:6px; }
    .lib .edit label { font-size:11px; color:var(--muted); }
    .lib .edit input, .lib .edit textarea { width:100%; font-size:13px; }
    .lib .edit textarea { resize:vertical; min-height:54px; line-height:1.35; }
    .lib .edit .btns { display:flex; gap:6px; justify-content:flex-end; }

    /* compact layout */
    .timerow { gap:6px; }
    .timerow #nowTime { font-size:20px; }
    .timerow .play { min-width:78px; }
    .abrow input[type=text] { width:66px; }
    .abrow .lbl { width:auto; }
    .abrow button { padding:4px 8px; }
    .rowlbl { width:38px; flex:none; }
    input[type=number].delayin { width:42px; text-align:center; -moz-appearance:textfield; }
    .delayin::-webkit-inner-spin-button, .delayin::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
    .actual:empty { display:none; }
    .metro { display:flex; flex-direction:row; align-items:center; gap:6px; }
    .mcol { flex:1; display:flex; flex-direction:column; gap:6px; min-width:0; }
    .mcol .play { min-width:104px; }
    .metro .neko-wrap { flex:none; margin:-6px -4px -8px 0; }
    .metro-sec { gap:8px; }
    .divider { border-top:1px solid var(--line); }
    .trrow { padding-left:22px; }
    input[type=text].trin { width:58px; text-align:center; font-weight:600; }
    .metro-sec summary { cursor:pointer; user-select:none; list-style:none; display:flex; align-items:center; gap:6px; font-weight:600; color:var(--strong); }
    .metro-sec summary::-webkit-details-marker { display:none; }
    .metro-sec summary::before { content:"▸"; font-size:11px; color:var(--muted); width:10px; }
    .metro-sec[open] summary::before { content:"▾"; }
    .metro-sec[open] > summary { margin-bottom:6px; }
    .metro-sec > .row { margin-top:6px; }
    button.small.bmk.on { background:var(--btn); border-color:var(--border); color:var(--accent); font-weight:400; }
    button.small.bmk.on:hover { background:var(--btn-h); }
    .bmk.on .bm { fill:currentColor; }
    .loopbar select:disabled { opacity:.5; }
    #loopDel:hover:not(:disabled) { background:var(--red); border-color:var(--red); color:#fff; }
    .body { gap:8px; }

    /* loop bar */
    .loopbar { display:flex; align-items:center; gap:6px; padding:5px; border:1px solid var(--border); border-radius:10px; background:var(--item); }
    .lb-title { font-weight:600; color:var(--strong); }
    select { background:var(--input); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:4px 6px; font-size:12.5px; min-width:0; }
    select:focus { outline:none; border-color:var(--accent); }
    .loopbar select { width:0; }
    #saveNew { font-weight:600; }
    /* manager: videos with loops */
    .vid { border:1px solid transparent; border-radius:8px; background:var(--item); }
    .vid.current { border-color:var(--accent); }
    .vid > .item { background:transparent; border:none; }
    .loops { display:flex; flex-direction:column; gap:4px; padding:0 8px 8px 38px; }
    .lrow { display:flex; align-items:center; gap:8px; padding:4px 6px; border-radius:6px; background:var(--bg); border:1px solid var(--line); }
    .lrow.sel { border-color:var(--accent); }
    .lpick { flex:1; min-width:0; cursor:pointer; }
    .lpick:hover .lname { color:var(--accent); text-decoration:underline; }
    .lname { font-size:12.5px; font-weight:600; color:var(--strong); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .lrow .acts button { width:28px; height:26px; }
    .libbar { display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid var(--line); }
    .libbar input[type=search] { flex:1; min-width:0; width:auto; background:var(--input); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:5px 8px; font-size:13px; }
    .libbar input[type=search]:focus { outline:none; border-color:var(--accent); }
    .sortbtns { display:flex; gap:2px; padding:2px; border:1px solid var(--border); border-radius:8px; background:var(--btn); flex:none; }
    .sortbtn { width:28px; height:24px; padding:0; display:inline-flex; align-items:center; justify-content:center; border:1px solid transparent; background:transparent; color:var(--muted); border-radius:6px; }
    .sortbtn:hover { color:var(--text); background:var(--btn-h); }
    .sortbtn.active { color:var(--accent); background:var(--bg); border-color:var(--accent); }
    .savecard { display:flex; align-items:center; gap:8px; padding:8px; border:1px dashed var(--accent); border-radius:8px; }
    .savecard .meta { flex:1; min-width:0; }
    .modal-foot { display:flex; align-items:center; gap:8px; padding:8px 12px; border-top:1px solid var(--line); background:var(--head); }
    .lib .nomatch { color:var(--muted); font-size:12px; padding:6px 2px; }

    /* loop editor */
    .modal-back.top { z-index:11; }
    .modal.editor { width:420px; }
    .form { display:flex; flex-direction:column; gap:6px; }
    .form > label, .grid > label { font-size:11px; color:var(--muted); }
    .form input[type=text], .form textarea { width:100%; }
    .form textarea { resize:vertical; min-height:54px; line-height:1.35; }
    .grid { display:grid; grid-template-columns: 1fr 1fr; gap:4px 12px; align-items:center; margin-top:4px; }
    .grid > label { grid-column:1; }
    .grid > input, .grid > .unit, .grid > select { grid-column:2; }
    .grid input[type=text] { width:90px; }
    .grid .unit { display:flex; align-items:center; gap:6px; color:var(--muted); font-size:12px; }
    .grid .unit input { width:70px; }
    .grid select { width:70px; }
    .form .btns { display:flex; gap:6px; align-items:center; margin-top:6px; }
    .form .del { display:inline-flex; align-items:center; gap:6px; }
    .form .del:hover, .form .del.confirm { background:var(--red); border-color:var(--red); color:#fff; }
    .err { color:var(--bad); font-size:12px; min-height:0; }
    .err:empty { display:none; }
    .lrow .acts { gap:4px; }

    /* help */
    .help h3 { margin:14px 0 6px; font-size:14px; color:var(--strong); }
    .help h3:first-child { margin-top:0; }
    .help p, .help li { line-height:1.5; margin:4px 0; }
    .help ol, .help ul { margin:4px 0; padding-left:20px; }
    .help figure { margin:8px 0; text-align:center; }
    .help img { width:300px; max-width:100%; height:auto; border-radius:8px; border:1px solid var(--border); }
    .help kbd { font-family:inherit; font-size:11px; padding:1px 5px; border:1px solid var(--border); border-bottom-width:2px; border-radius:4px; background:var(--btn); }
    .help table { border-collapse:collapse; width:100%; font-size:12px; }
    .help td { padding:3px 4px; border-bottom:1px solid var(--line); vertical-align:top; }
    .help .warnbox { background:var(--warn-bg); color:var(--warn-text); border:1px solid var(--red); border-radius:8px; padding:8px 10px; font-size:12px; line-height:1.45; }
  </style>
  <div class="panel">
    <div class="head">
      <img class="logo" alt="" src="data:image/png;base64,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" /><span class="title">Guitar Playa Companion</span>
      <button class="hbtn" id="libBtn" title="Saved videos"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M4.2 3 H10.2 M4.2 6 H10.2 M4.2 9 H10.2"/><circle cx="2" cy="3" r=".6" fill="currentColor" stroke="none"/><circle cx="2" cy="6" r=".6" fill="currentColor" stroke="none"/><circle cx="2" cy="9" r=".6" fill="currentColor" stroke="none"/></svg><span class="badge" id="libCount">0</span></button>
      <button class="hbtn" id="themeBtn" title="Theme"></button>
      <button class="hbtn" id="helpBtn" title="Help"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><circle cx="6" cy="6" r="4.9"/><path d="M4.55 4.75 a1.5 1.5 0 1 1 2.1 1.35 c-.45 .22 -.65 .55 -.65 1.05"/><circle cx="6" cy="8.8" r=".45" fill="currentColor" stroke="none"/></svg></button>
      <button class="hbtn" id="collapse" title="Minimize"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 4.25 L6 7.75 L9.5 4.25"/></svg></button>
      <button class="hbtn exit" id="close" title="Exit: stops the loop and metronome, puts the video back to normal speed. Click the toolbar icon to open again."><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button>
    </div>
    <div class="toast" id="toast"></div>
    <div class="body">
      <div class="warn" id="warn"><div id="warnText"></div><button id="openExt">Open extensions page</button></div>
      <div class="novideo" id="novideo">▶ Open a video to use the loop and speed controls. The metronome works anywhere.</div>
      <div class="vsec" id="vsec">
        <div class="loopbar" id="loopBar">
          <select id="loopSel" class="grow" title="Saved loops for this video"></select>
          <button class="savebtn" id="saveCur"></button>
          <button class="small" id="saveNew" title="Add the current settings as a new loop"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M6 2 V10 M2 6 H10"/></svg></button>
          <button class="small" id="loopEdit" title="Edit this loop: name, description, settings, delete"><svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M8.2 1.8 l2 2 L4.4 9.6 L1.8 10.2 L2.4 7.6 Z M7 3 l2 2"/></svg></button>
        </div>
      <div class="now" title="Where the video is right now">
        <span class="muted">Now</span>
        <span id="nowTime">0:00.0</span>
        <span class="muted" id="durTime"></span>
        <button class="vidsave" id="saveVid"></button>
      </div>
      <div class="row">
        <span class="lbl">A</span>
        <input type="text" id="aIn" placeholder="0:00.0" />
        <button class="small" data-nudge="a" data-d="-0.1" title="−0.1s (Shift: −1s)">−</button>
        <button class="small" data-nudge="a" data-d="0.1" title="+0.1s (Shift: +1s)">+</button>
        <button class="grow" id="setA" title="Set A to current time  [ key">Set A</button>
      </div>
      <div class="row">
        <span class="lbl">B</span>
        <input type="text" id="bIn" placeholder="0:00.0" />
        <button class="small" data-nudge="b" data-d="-0.1" title="−0.1s (Shift: −1s)">−</button>
        <button class="small" data-nudge="b" data-d="0.1" title="+0.1s (Shift: +1s)">+</button>
        <button class="grow" id="setB" title="Set B to current time  ] key">Set B</button>
      </div>
      <div class="row">
        <button id="goA" title="Jump to A and play  ; key">⏮ To A</button>
        <button class="grow play" id="play" title="Play / pause">▶ Play</button>
        <button id="goB" title="Jump to B (while looping: 2 s before B)">To B ⏭</button>
      </div>
      <div class="row">
        <button class="grow" id="loop" title="Toggle loop  \\ key">Loop: OFF</button>
        <button id="clear" title="Clear A and B  Backspace key">Clear</button>
      </div>
        <div class="divider"></div>
        <div class="row">
          <span class="muted rowlbl">Speed</span>
          <button class="small" id="slower" title="−5%  - key">−</button>
          <input type="text" id="speedIn" class="speedin" title="Type a speed from 25 to 500 (percent), then Enter" />
          <button class="small" id="faster" title="+5%  = key">+</button>
          <input type="range" id="speed" min="25" max="500" step="5" value="100" />
        </div>
        <div class="row">
          <span class="grow">Pause between loops</span>
          <button class="small" id="delayDown" title="−0.5 s">−</button>
          <input type="number" id="delay" class="delayin" min="0" max="10" step="0.5" title="Seconds" />
          <button class="small" id="delayUp" title="+0.5 s">+</button>
          <span class="muted">s</span>
        </div>
        <div class="row">
          <label class="chk grow" title="Speed up (or slow down) a little every time the loop repeats"><input type="checkbox" id="trOn" /> Change speed each loop</label>
          <button class="small" id="trReset" title="Back to the starting speed"><svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M2.6 4.4 A4 4 0 1 1 2.2 7.4 M2.6 1.8 V4.4 H5.2"/></svg></button>
        </div>
        <div class="row trrow" id="trRow">
          <span class="muted">by</span>
          <button class="small" id="trDown" title="−1%">−</button>
          <input type="text" id="trStep" class="trin" title="Change per loop, e.g. +5% (faster) or -5% (slower)" />
          <button class="small" id="trUp" title="+1%">+</button>
          <span class="muted">until</span>
          <input type="text" id="trLimit" class="trin" title="Stop changing at this speed (25%–500%); the loop then carries on at this speed" />
        </div>
        <div class="actual" id="actual"></div>
      </div>

      <details class="section metro-sec" id="metroSec">
        <summary><span class="grow">Metronome</span><span class="muted" id="metroSum"></span></summary>
        <div class="metro">
        <div class="mcol">
          <div class="row">
            <button class="play" id="mStart">▶ Metronome</button>
            <div class="dots" id="dots"></div>
          </div>
          <div class="row">
            <button class="small" id="bpmDown" title="−1 BPM (Shift: −5)">−</button>
            <span class="bpm" id="bpmVal">120</span>
            <button class="small" id="bpmUp" title="+1 BPM (Shift: +5)">+</button>
          </div>
          <div class="row">
            <button id="tap" title="Tap along to the song 4–5 times to set the BPM">Tap</button>
            <button class="grow ico-btn" id="detect" title="The cat listens to about 10 seconds of the video, finds the BPM and starts the metronome"><svg class="cat-ico" viewBox="22 8 96 98" width="18" height="18" aria-hidden="true"><g stroke="#1a1a1a" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M34 50 L 38 14 L 62 34 Z" fill="#fffdf7"/><path d="M106 50 L 102 14 L 78 34 Z" fill="#fffdf7"/><path d="M40 41 L 41 24 L 54 34 Z" fill="#d9463b" stroke="none"/><path d="M100 41 L 99 24 L 86 34 Z" fill="#d9463b" stroke="none"/><ellipse cx="70" cy="58" rx="40" ry="32" fill="#fffdf7"/><circle cx="47" cy="68" r="7" fill="#f2a3a0" stroke="none" opacity=".7"/><circle cx="93" cy="68" r="7" fill="#f2a3a0" stroke="none" opacity=".7"/><path d="M49 58 q6 -8 12 0 M79 58 q6 -8 12 0" fill="none" stroke-width="5"/><path d="M65.5 66 h9 l-4.5 4.5 z" fill="#d9463b" stroke-width="2"/><path d="M38 86 Q70 102 102 86" fill="none" stroke="#c8281f" stroke-width="9"/><circle cx="70" cy="97" r="7" fill="#e8b83a" stroke-width="3"/></g></svg><span id="detectLabel">Auto BPM</span></button>
          </div>
        </div>
        <div class="neko-wrap" id="nekoWrap"><svg viewBox="-12 2 170 170" width="104" height="104" class="neko">
 <g stroke="#1a1a1a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
  <g class="arm" style="transform-box:view-box;transform-origin:104px 110px">
   <path d="M94 112 C 98 88, 106 68, 114 52 L 130 56 C 126 74, 120 94, 116 114 Z" fill="#fffdf7"/>
   <ellipse cx="123" cy="45" rx="13" ry="12.5" fill="#fffdf7"/>
   <path d="M117 36 v5 M123 34 v6 M129 36 v5" fill="none" stroke-width="1.7"/>
  </g>
  <path d="M28 146 C 20 114, 34 88, 70 86 C 106 88, 120 114, 112 146 Z" fill="#fffdf7"/>
  <path d="M34 50 L 38 14 L 62 34 Z" fill="#fffdf7"/>
  <path d="M106 50 L 102 14 L 78 34 Z" fill="#fffdf7"/>
  <path d="M40 41 L 41 24 L 54 34 Z" fill="#d9463b" stroke="none"/>
  <path d="M100 41 L 99 24 L 86 34 Z" fill="#d9463b" stroke="none"/>
  <ellipse cx="70" cy="58" rx="40" ry="32" fill="#fffdf7"/>
  <circle cx="47" cy="68" r="6" fill="#f2a3a0" stroke="none" opacity=".55"/>
  <circle cx="93" cy="68" r="6" fill="#f2a3a0" stroke="none" opacity=".55"/>
  <path d="M49 58 q6 -7 12 0 M79 58 q6 -7 12 0" fill="none" stroke-width="3"/>
  <path d="M66.5 66 h7 l-3.5 3.5 z" fill="#d9463b" stroke-width="1.4"/>
  <path d="M70 70 q-4 5 -8 2 M70 70 q4 5 8 2" fill="none" stroke-width="2"/>
  <path d="M38 66 l-14 -3 M38 71 l-14 2 M102 66 l14 -3 M102 71 l14 2" stroke-width="1.5"/>
  <path d="M38 86 Q70 102 102 86" fill="none" stroke="#c8281f" stroke-width="7"/>
  <g class="bell" style="transform-box:view-box;transform-origin:70px 94px">
   <circle cx="70" cy="101" r="7.5" fill="#e8b83a"/><path d="M63 100 h14" stroke-width="1.4"/><circle cx="70" cy="104.5" r="1.3" fill="#1a1a1a" stroke="none"/>
  </g>
  <g transform="rotate(30 80 126)">
   <rect x="6" y="122" width="64" height="8" rx="2" fill="#f3e3c3"/>
   <path d="M16 122 v8 M26 122 v8 M36 122 v8 M46 122 v8 M56 122 v8" stroke="#b49a6a" stroke-width="1.1"/>
   <path d="M-10 118.5 L 8 120.5 L 8 131.5 L -10 133.5 Z" fill="#3a2a22"/>
   <ellipse cx="76" cy="126" rx="15" ry="13" fill="#ef5a4c"/>
   <ellipse cx="98" cy="126" rx="21" ry="18" fill="#ef5a4c"/>
   <ellipse cx="76" cy="126" rx="13.7" ry="11.7" fill="#ef5a4c" stroke="none"/>
   <ellipse cx="98" cy="126" rx="19.7" ry="16.7" fill="#ef5a4c" stroke="none"/>
   <rect x="74" y="117" width="10" height="18" rx="2" fill="#ef5a4c" stroke="none"/>
   <path d="M72 120 C 78 115, 90 116, 96 119 C 104 116, 112 122, 108 130 C 104 137, 92 136, 86 133 C 80 136, 72 134, 70 128 Z" fill="#fbf1de" stroke-width="1.5"/>
   <rect x="79" y="119.5" width="4.5" height="13" rx="1" fill="#2b2b2b" stroke="none"/>
   <rect x="89" y="119.5" width="4.5" height="13" rx="1" fill="#2b2b2b" stroke="none"/>
   <rect x="102" y="121.5" width="4" height="9" rx="1" fill="#555" stroke="none"/>
   <path d="M6 124 H 104 M6 126 H 104 M6 128 H 104" stroke="#d8d8d8" stroke-width=".55"/>
  </g>
  <ellipse cx="38" cy="104" rx="11.5" ry="9" fill="#fffdf7" transform="rotate(30 38 104)"/>
 </g>
</svg></div>
        </div>
        <div class="row"><span class="muted rowlbl">BPM</span><input type="range" id="bpm" min="30" max="240" step="1" /></div>
        <div class="row"><span class="muted rowlbl">Beats</span><div class="seg" id="beats"><button data-b="1">1</button><button data-b="2">2</button><button data-b="3">3</button><button data-b="4">4</button><button data-b="6">6</button></div><span class="grow"></span><span class="muted">Vol</span><input type="range" class="vol" id="mVol" min="0" max="100" step="1" /></div>
        <div class="row chkrow">
            <label class="chk"><input type="checkbox" id="mAccent" /> Accent Beat 1</label>
            <label class="chk"><input type="checkbox" id="mCat" /> <svg class="cat-ico" viewBox="22 8 96 98" width="18" height="18" aria-hidden="true"><g stroke="#1a1a1a" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M34 50 L 38 14 L 62 34 Z" fill="#fffdf7"/><path d="M106 50 L 102 14 L 78 34 Z" fill="#fffdf7"/><path d="M40 41 L 41 24 L 54 34 Z" fill="#d9463b" stroke="none"/><path d="M100 41 L 99 24 L 86 34 Z" fill="#d9463b" stroke="none"/><ellipse cx="70" cy="58" rx="40" ry="32" fill="#fffdf7"/><circle cx="47" cy="68" r="7" fill="#f2a3a0" stroke="none" opacity=".7"/><circle cx="93" cy="68" r="7" fill="#f2a3a0" stroke="none" opacity=".7"/><path d="M49 58 q6 -8 12 0 M79 58 q6 -8 12 0" fill="none" stroke-width="5"/><path d="M65.5 66 h9 l-4.5 4.5 z" fill="#d9463b" stroke-width="2"/><path d="M38 86 Q70 102 102 86" fill="none" stroke="#c8281f" stroke-width="9"/><circle cx="70" cy="97" r="7" fill="#e8b83a" stroke-width="3"/></g></svg>Maneki-neko</label>
          </div>
      </details>
    </div>
  </div>
  <div class="modal-back" id="libModal">
    <div class="modal" role="dialog" aria-label="Saved videos">
      <div class="modal-head"><svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M3 1.6 h6 v8.8 l-3 -2.3 l-3 2.3 z"/></svg><span class="grow">Saved videos</span><button class="hbtn exit" id="libClose" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button></div>
      <div class="libbar">
        <input type="search" id="libSearch" placeholder="Search videos and loops" title="Search by video title, description or loop name" />
        <div class="sortbtns" id="libSort" role="group" aria-label="Sort"><button class="sortbtn" data-sort="custom" title="My order (rearrange with ▲ ▼)"><svg class="hico" viewBox="0 0 12 12" width="15" height="15" aria-hidden="true"><path d="M4.3 2.6 h.01 M7.7 2.6 h.01 M4.3 6 h.01 M7.7 6 h.01 M4.3 9.4 h.01 M7.7 9.4 h.01" stroke-width="2.2"/></svg></button><button class="sortbtn" data-sort="newest" title="Newest first"><svg class="hico" viewBox="0 0 12 12" width="15" height="15" aria-hidden="true"><circle cx="5" cy="6" r="3.6"/><path d="M5 4 V6 L6.3 6.9 M10.2 3 V9.4 M8.8 8 L10.2 9.4 L11.6 8"/></svg></button><button class="sortbtn" data-sort="oldest" title="Oldest first"><svg class="hico" viewBox="0 0 12 12" width="15" height="15" aria-hidden="true"><circle cx="5" cy="6" r="3.6"/><path d="M5 4 V6 L6.3 6.9 M10.2 9.4 V3 M8.8 4.4 L10.2 3 L11.6 4.4"/></svg></button><button class="sortbtn" data-sort="az" title="Name A–Z"><svg class="hico" viewBox="0 0 12 12" width="15" height="15" aria-hidden="true"><path d="M1.2 5.4 L2.8 1.4 L4.4 5.4 M1.8 4 H3.8 M1.4 7.2 H4.2 L1.4 10.6 H4.2 M9 2 V10 M7.4 8.4 L9 10 L10.6 8.4"/></svg></button><button class="sortbtn" data-sort="za" title="Name Z–A"><svg class="hico" viewBox="0 0 12 12" width="15" height="15" aria-hidden="true"><path d="M1.4 1.6 H4.2 L1.4 5 H4.2 M1.2 10.6 L2.8 6.6 L4.4 10.6 M1.8 9.2 H3.8 M9 2 V10 M7.4 8.4 L9 10 L10.6 8.4"/></svg></button></div>
      </div>
      <div class="modal-body"><div class="lib" id="lib"></div></div>
      <div class="modal-foot">
        <span class="muted grow" id="libStats"></span>
        <button class="ico-btn" id="libExport" title="Save all your saved videos and loops to a file"><svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M6 1.5 V7.6 M3.6 5.3 L6 7.7 L8.4 5.3 M1.8 8.4 V10.3 H10.2 V8.4"/></svg><span>Export</span></button>
        <button class="ico-btn" id="libImport" title="Add saved videos from one or more exported files (duplicates are skipped)"><svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M6 7.7 V1.6 M3.6 4 L6 1.6 L8.4 4 M1.8 8.4 V10.3 H10.2 V8.4"/></svg><span>Import</span></button>
        <input type="file" id="libFile" accept=".json,application/json" multiple hidden />
      </div>
    </div>
  </div>
  <div class="modal-back top" id="loopModal">
    <div class="modal editor" role="dialog" aria-label="Edit loop">
      <div class="modal-head"><svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M8.2 1.8 l2 2 L4.4 9.6 L1.8 10.2 L2.4 7.6 Z M7 3 l2 2"/></svg><span class="grow" id="leTitle">Edit loop</span><button class="hbtn exit" id="loopClose" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button></div>
      <div class="modal-body">
        <div class="form">
          <label>Label</label>
          <input type="text" id="leName" maxlength="80" />
          <label>Description</label>
          <textarea id="leDesc" rows="3" maxlength="1000" placeholder="Notes, e.g. fingering, which bars, what to focus on…"></textarea>
          <div class="grid">
            <label>A (start)</label><input type="text" id="leA" placeholder="0:00.0" />
            <label>B (end)</label><input type="text" id="leB" placeholder="0:00.0" />
            <label>Speed</label><span class="unit"><input type="number" id="leSpeed" min="25" max="500" step="5" /> %</span>
            <label>Pause between loops</label><span class="unit"><input type="number" id="leDelay" min="0" max="10" step="0.5" /> sec</span>
            <label>Metronome</label><span class="unit"><input type="number" id="leBpm" min="30" max="240" step="1" /> BPM</span>
            <label>Beats</label><select id="leBeats"><option>1</option><option>2</option><option>3</option><option>4</option><option>6</option></select>
          </div>
          <div class="row chkrow">
            <label class="chk"><input type="checkbox" id="leLoop" /> Loop on</label>
            <label class="chk"><input type="checkbox" id="leAccent" /> Accent Beat 1</label>
          </div>
          <div class="muted" id="leInfo"></div>
          <div class="err" id="leErr"></div>
          <div class="btns">
            <button class="del" id="leDel"></button>
            <span class="grow"></span>
            <button id="leOpen" title="Open this loop in the player">▶ Open loop</button>
            <button id="leCancel">Cancel</button>
            <button class="primary" id="leSave">Save changes</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="modal-back" id="helpModal">
    <div class="modal" role="dialog" aria-label="Help">
      <div class="modal-head"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><circle cx="6" cy="6" r="4.9"/><path d="M4.55 4.75 a1.5 1.5 0 1 1 2.1 1.35 c-.45 .22 -.65 .55 -.65 1.05"/><circle cx="6" cy="8.8" r=".45" fill="currentColor" stroke="none"/></svg><span class="grow">How to use Guitar Playa Companion</span><button class="hbtn exit" id="helpClose" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button></div>
      <div class="modal-body help" id="helpBody"></div>
    </div>
  </div>`;

  const $ = (id) => root.getElementById(id);
  const panel = root.querySelector(".panel");

  let toastTimer;
  function flash(msg, ms = 1600) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    // Also show the message inside the video player (visible in full screen / when the panel is hidden)
    const player = document.querySelector("#movie_player");
    if (player) {
      let pt = player.querySelector(".ygc-toast");
      if (!pt) {
        pt = document.createElement("div");
        pt.className = "ygc-toast";
        player.appendChild(pt);
      }
      pt.textContent = msg;
      pt.classList.add("show");
    }
    toastTimer = setTimeout(() => {
      t.classList.remove("show");
      document.querySelector("#movie_player .ygc-toast")?.classList.remove("show");
    }, ms);
  }

  function setIfIdle(el, val) {
    if (root.activeElement !== el) el.value = val;
  }

  function render() {
    applyTheme();
    host.style.display = !state.settings.hidden ? "" : "none";
    $("vsec").style.display = state.videoId ? "" : "none";
    $("novideo").style.display = state.videoId ? "none" : "";
    panel.classList.toggle("collapsed", !!state.settings.collapsed);
    const colIcon = state.settings.collapsed ? '<svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M4.25 2.5 L7.75 6 L4.25 9.5"/></svg>' : '<svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 4.25 L6 7.75 L9.5 4.25"/></svg>';
    if ($("collapse").dataset.c !== String(!!state.settings.collapsed)) {
      $("collapse").innerHTML = colIcon;
      $("collapse").dataset.c = String(!!state.settings.collapsed);
    }
    $("collapse").title = state.settings.collapsed ? "Restore" : "Minimize";

    setIfIdle($("aIn"), fmt(state.a));
    setIfIdle($("bIn"), fmt(state.b));
    const lb = $("loop");
    const reps = state.looping && state.loopCount > 0 ? ` ×${state.loopCount}` : "";
    lb.textContent = state.looping ? (state.waiting ? `Loop: ON${reps} (pause…)` : `Loop: ON${reps}`) : "Loop: OFF";
    lb.title = state.looping ? `Looping. Repeated ${state.loopCount} time${state.loopCount === 1 ? "" : "s"}. Click to stop  \\ key` : "Start the loop  \\ key";
    lb.classList.toggle("on", state.looping);

    $("play").textContent = isPlaying() ? "⏸ Pause" : "▶ Play";
    $("goA").disabled = state.a == null;
    // B can only be set once A is set
    const noA = state.a == null;
    $("setB").disabled = noA;
    $("bIn").disabled = noA;
    root.querySelectorAll('[data-nudge="b"]').forEach((b) => (b.disabled = noA || state.b == null));
    root.querySelectorAll('[data-nudge="a"]').forEach((b) => (b.disabled = noA));
    $("goB").disabled = state.b == null;
    setIfIdle($("speedIn"), fmtSpeed(state.speed));
    const tr = state.settings.trainer || {};
    $("trOn").checked = !!tr.on;
    $("trRow").style.display = tr.on ? "" : "none";
    $("trReset").style.display = tr.on ? "" : "none";
    setIfIdle($("trStep"), fmtStep(tr.step ?? 5));
    setIfIdle($("trLimit"), `${tr.limit ?? 100}%`);
    setIfIdle($("speed"), Math.round(state.speed * 100));
    root.querySelectorAll("#presets button").forEach((b) => b.classList.toggle("active", +b.dataset.p === pct));

    const s = state.settings;
    setIfIdle($("delay"), s.delay);

    const mo = state.settings.metroOpen !== false;
    if ($("metroSec").open !== mo) $("metroSec").open = mo;
    renderMetro();
    renderLibrary();
    renderSaveRow();

    if (s.pos) {
      host.style.left = s.pos.left + "px";
      host.style.top = s.pos.top + "px";
      host.style.right = "auto";
      host.style.bottom = "auto";
    }
    renderMarks();
  }

  // ---------- health check: is the video really at our speed? is anything else fighting it? ----------
  let conflictAt = 0;
  let mismatchSince = 0;
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.source !== "ygc2-page") return;
    if (e.data.type === "conflict") conflictAt = Date.now();
  });
  function renderStatus() {
    const others = [...document.querySelectorAll("#yt-guitar-companion-host, #yt-practice-looper-host")].filter((h) => h !== host).length;
    const v = state.videoId ? getVideo() : null;
    const act = $("actual");
    let mismatch = false;
    if (v && !isAd() && !state.settings.hidden) {
      const real = Math.round(v.playbackRate * 100);
      mismatch = Math.abs(v.playbackRate - state.speed) > 0.001;
      if (!mismatch) mismatchSince = 0;
      else if (!mismatchSince) mismatchSince = Date.now();
      const stuck = mismatch && Date.now() - mismatchSince > 1200;
      act.textContent = stuck ? `⚠ The video is actually playing at ${fmtSpeed(v.playbackRate)}` : "";
      act.classList.toggle("bad", stuck);
      mismatch = stuck;
    } else {
      act.textContent = "";
    }
    let msg = "";
    if (others > 0)
      msg = `⚠ Another copy of Guitar Playa Companion (probably an older version) is also running in this tab and fights over the speed. In the extensions page, remove every copy except version ${VERSION}, then refresh this tab.`;
    else if (Date.now() - conflictAt < 4000 || mismatch)
      msg = "⚠ Another extension is changing the video speed (for example Enhancer for YouTube, Video Speed Controller, or an older copy of this companion). Turn it off for YouTube in the extensions page, then refresh this tab.";
    $("warnText").textContent = msg;
    $("warn").classList.toggle("show", !!msg && !state.settings.hidden);
  }
  const VERSION = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch (e) {
      return "";
    }
  })();
  $("openExt").onclick = () => {
    try {
      chrome.runtime.sendMessage({ type: "open-extensions" });
    } catch (e) {}
  };

  // ---------- UI events ----------
  // After clicking a panel button, give the keyboard back to the page so shortcuts keep working.
  root.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button");
    if (b) b.blur();
  });
  $("setA").onclick = () => setA();
  $("setB").onclick = () => setB();
  $("loop").onclick = () => toggleLoop();
  $("goA").onclick = goToA;
  $("play").onclick = playPause;
  $("goB").onclick = goToB;
  $("clear").onclick = clearLoop;
  root.querySelectorAll("[data-nudge]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const d = parseFloat(btn.dataset.d) * (e.shiftKey ? 10 : 1);
      if (btn.dataset.nudge === "a" && state.a != null) setA(state.a + d);
      if (btn.dataset.nudge === "b" && state.b != null) setB(state.b + d);
    })
  );
  $("aIn").addEventListener("change", (e) => {
    const t = parseTime(e.target.value);
    t == null ? render() : setA(t);
  });
  $("bIn").addEventListener("change", (e) => {
    const t = parseTime(e.target.value);
    t == null ? render() : setB(t);
  });
  ["aIn", "bIn"].forEach((id) =>
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.target.blur();
    })
  );

  $("slower").onclick = () => setSpeed(state.speed - 0.05);
  $("faster").onclick = () => setSpeed(state.speed + 0.05);
  $("speed").addEventListener("input", (e) => setSpeed(+e.target.value / 100));
  $("speedIn").addEventListener("change", (e) => {
    const r = parseSpeed(e.target.value);
    if (r == null) {
      flash("Type a speed from 25% to 500%");
      e.target.value = fmtSpeed(state.speed);
    } else setSpeed(r);
  });
  $("speedIn").addEventListener("keydown", (e) => e.key === "Enter" && e.target.blur());
  $("speedIn").addEventListener("focus", (e) => e.target.select());
  root.querySelectorAll("#presets button").forEach((b) => (b.onclick = () => setSpeed(+b.dataset.p / 100)));

  const setDelay = (d) => {
    state.settings.delay = Math.round(clamp(d, 0, 10) * 2) / 2;
    persist();
    render();
  };
  const T = () => state.settings.trainer;
  const fmtStep = (n) => `${n > 0 ? "+" : ""}${n}%`;
  $("trOn").addEventListener("change", (e) => {
    T().on = e.target.checked;
    if (T().on) {
      T().start = state.speed; // "reset" goes back here
      state.loopCount = 0;
      flash(`Speed will change ${fmtStep(T().step)} each loop until ${T().limit}%`);
    } else flash("Speed change per loop: off");
    persist();
    render();
  });
  const setStep = (n) => {
    n = Math.round(clamp(n, -50, 50));
    T().step = n || (T().step > 0 ? -1 : 1); // never 0
    persist();
    render();
  };
  $("trDown").onclick = () => setStep(T().step - 1 === 0 ? -1 : T().step - 1);
  $("trUp").onclick = () => setStep(T().step + 1 === 0 ? 1 : T().step + 1);
  $("trStep").addEventListener("change", (e) => {
    const n = parseFloat(String(e.target.value).replace(/[%\s]/g, ""));
    if (!isFinite(n) || n === 0 || Math.abs(n) > 50) {
      flash("Change per loop: −50% to +50% (not 0)");
      return render();
    }
    setStep(n);
  });
  $("trLimit").addEventListener("change", (e) => {
    const n = parseFloat(String(e.target.value).replace(/[%\s]/g, ""));
    if (!isFinite(n) || n < 25 || n > 500) {
      flash("Limit: 25% to 500%");
      return render();
    }
    T().limit = Math.round(n);
    persist();
    render();
  });
  ["trStep", "trLimit"].forEach((id) => $(id).addEventListener("keydown", (e) => e.key === "Enter" && e.target.blur()));
  $("trReset").onclick = () => {
    const start = T().start ?? state.speed;
    setSpeed(start, true);
    state.loopCount = 0;
    persist();
    render();
    flash(`Back to ${fmtSpeed(start)}`);
  };
  $("delayDown").onclick = (e) => setDelay((+state.settings.delay || 0) - (e.shiftKey ? 2 : 0.5));
  $("delayUp").onclick = (e) => setDelay((+state.settings.delay || 0) + (e.shiftKey ? 2 : 0.5));
  $("delay").addEventListener("change", (e) => {
    state.settings.delay = clamp(+e.target.value || 0, 0, 10);
    persist();
    render();
  });
  $("collapse").onclick = () => {
    state.settings.collapsed = !state.settings.collapsed;
    persist();
    render();
  };
  $("close").onclick = () => exitApp();

  // Dragging by the header
  (() => {
    const head = root.querySelector(".head");
    let drag = null;
    head.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      const r = host.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const left = clamp(e.clientX - drag.dx, 0, window.innerWidth - 60);
      const top = clamp(e.clientY - drag.dy, 0, window.innerHeight - 30);
      state.settings.pos = { left, top };
      render();
    });
    window.addEventListener("mouseup", () => {
      if (drag) persist();
      drag = null;
    });
  })();

  // ---------- metronome (Web Audio, scheduled ahead for rock-steady timing) ----------
  const metro = { on: false, ctx: null, gain: null, next: 0, beat: 0, timer: null, taps: [], queued: [], restartPending: false };
  const M = () => state.settings.metronome;
  const effBpm = () => clamp(M().bpm, 10, 400);

  function clickAt(time, accent) {
    const ctx = metro.ctx;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = accent ? 1760 : 1175;
    env.gain.setValueAtTime(0.0001, time);
    env.gain.exponentialRampToValueAtTime(accent ? 1 : 0.65, time + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
    osc.connect(env).connect(metro.gain);
    osc.start(time);
    osc.stop(time + 0.08);
    // remember queued clicks so a restart can cancel the ones that haven't sounded yet
    metro.queued = metro.queued.filter((q) => q.time > ctx.currentTime - 0.1);
    metro.queued.push({ osc, time });
  }
  function scheduler() {
    const ctx = metro.ctx;
    while (metro.next < ctx.currentTime + 0.12) {
      const beatInBar = metro.beat % M().beats;
      const accent = M().accent && M().beats > 1 && beatInBar === 0;
      clickAt(metro.next, accent);
      const interval = 60 / effBpm();
      const delay = Math.max(0, (metro.next - ctx.currentTime) * 1000);
      const tid = setTimeout(() => metro.on && onBeat(beatInBar, accent, interval), delay);
      metro.queued[metro.queued.length - 1].tid = tid;
      metro.next += interval;
      metro.beat++;
    }
  }
  function startMetro() {
    if (!metro.ctx) {
      metro.ctx = new (window.AudioContext || window.webkitAudioContext)();
      metro.gain = metro.ctx.createGain();
      metro.gain.connect(metro.ctx.destination);
    }
    metro.ctx.resume();
    metro.gain.gain.value = Math.pow(M().vol / 100, 1.5);
    metro.on = true;
    metro.beat = 0;
    metro.next = metro.ctx.currentTime + 0.06;
    clearInterval(metro.timer);
    metro.timer = setInterval(scheduler, 25);
    scheduler();
    render();
  }
  // Start counting again from beat 1 right now (used when the loop jumps back to A).
  function restartMetro() {
    if (!metro.on || !metro.ctx) return;
    const now = metro.ctx.currentTime;
    metro.queued.forEach((q) => {
      if (q.time > now) {
        try {
          q.osc.stop();
          q.osc.disconnect();
        } catch (e) {}
        clearTimeout(q.tid);
      }
    });
    metro.queued = [];
    metro.beat = 0;
    metro.next = now + 0.01;
    scheduler();
  }
  function stopMetro() {
    metro.on = false;
    clearInterval(metro.timer);
    root.querySelectorAll("#dots span").forEach((d) => d.classList.remove("hit"));
    const arm = root.querySelector(".neko .arm");
    if (arm) arm.animate([{ transform: getComputedStyle(arm).transform }, { transform: "rotate(0deg)" }], { duration: 250, fill: "forwards", easing: "ease-out" });
    render();
  }
  // Visuals for one beat: light the dot; the cat's paw is DOWN exactly on the click and up halfway between clicks.
  function onBeat(beatInBar, accent, interval) {
    root.querySelectorAll("#dots span").forEach((d, i) => d.classList.toggle("hit", i === beatInBar));
    if (!M().cat) return;
    const ms = interval * 1000;
    const arm = root.querySelector(".neko .arm");
    arm.animate(
      [
        { transform: "rotate(16deg)", easing: "ease-out" },
        { transform: "rotate(0deg)", offset: 0.5, easing: "ease-in" },
        { transform: "rotate(16deg)" },
      ],
      { duration: ms, fill: "forwards" }
    );
    if (accent) {
      root.querySelector(".neko .bell").animate(
        [{ transform: "rotate(0deg)" }, { transform: "rotate(14deg)" }, { transform: "rotate(-10deg)" }, { transform: "rotate(0deg)" }],
        { duration: Math.min(400, ms * 0.9), easing: "ease-out" }
      );
    }
  }
  function setBpm(b) {
    M().bpm = Math.round(clamp(b, 30, 240));
    persist();
    render();
  }
  function tapTempo() {
    const now = performance.now();
    metro.taps = metro.taps.filter((t) => now - t < 2500);
    metro.taps.push(now);
    if (metro.taps.length >= 2) {
      const iv = [];
      for (let i = 1; i < metro.taps.length; i++) iv.push(metro.taps[i] - metro.taps[i - 1]);
      const recent = iv.slice(-4);
      let bpm = 60000 / (recent.reduce((a, b) => a + b, 0) / recent.length);
      setBpm(bpm);
    }
    metro.taps = metro.taps.slice(-5);
  }
  function renderMetro() {
    const m = M();
    $("bpmVal").innerHTML = `${m.bpm}<small>BPM</small>`;
    setIfIdle($("bpm"), m.bpm);
    setIfIdle($("mVol"), m.vol);
    $("mAccent").checked = m.accent;
    $("mCat").checked = m.cat;
    $("nekoWrap").style.display = m.cat ? "" : "none";
    root.querySelectorAll("#beats button").forEach((b) => b.classList.toggle("active", +b.dataset.b === m.beats));
    const dots = $("dots");
    if (dots.childElementCount !== m.beats) {
      dots.innerHTML = "";
      for (let i = 0; i < m.beats; i++) {
        const d = document.createElement("span");
        if (i === 0 && m.accent && m.beats > 1) d.className = "accent";
        dots.appendChild(d);
      }
    }
    if (dots.firstChild) dots.firstChild.classList.toggle("accent", m.accent && m.beats > 1);
    $("mStart").textContent = metro.on ? "⏹ Stop" : "▶ Start";
    $("metroSum").textContent = `${m.bpm} BPM${metro.on ? " · playing" : ""}`;
    if (!detecting) $("detectLabel").textContent = "Auto BPM";
    $("detect").classList.toggle("busy", !!detecting);
    $("mStart").classList.toggle("on", metro.on);
  }

  $("mStart").onclick = () => (metro.on ? stopMetro() : startMetro());
  $("bpmDown").onclick = (e) => setBpm(M().bpm - (e.shiftKey ? 5 : 1));
  $("bpmUp").onclick = (e) => setBpm(M().bpm + (e.shiftKey ? 5 : 1));
  $("bpm").addEventListener("input", (e) => setBpm(+e.target.value));
  $("tap").onclick = tapTempo;
  // ---------- BPM detection: the cat listens to the video and finds the beat ----------
  // Listens to ~10 s of the video's sound (nothing leaves your computer), tracks how the sound
  // "hits" over time, and finds the most regular beat spacing. It measures the tempo you HEAR,
  // so at 70% speed it reports the slowed-down tempo, which is what you play along to.
  const LISTEN_SECONDS = 10;
  let detecting = null;
  function stopDetect(msg) {
    if (!detecting) return;
    const d = detecting;
    detecting = null;
    clearInterval(d.timer);
    try {
      d.proc.onaudioprocess = null;
      d.src.disconnect();
      d.proc.disconnect();
      d.stream.getTracks().forEach((t) => t.stop());
      d.ctx.close();
    } catch (e) {}
    root.querySelector(".neko")?.classList.remove("listening");
    if (msg) flash(msg);
    render();
  }
  // rate = playback speed while listening; the 'likely tempo' preference is applied to the song's real tempo
  function estimateTempo(env, fr, rate = 1) {
    const n = env.length;
    if (n < fr * 4) return null;
    // remove the local average so only the "hits" remain
    const w = Math.max(1, Math.round(fr * 0.3));
    const o = new Float32Array(n);
    let sum = 0;
    for (let i = 0; i < Math.min(n, w); i++) sum += env[i];
    for (let i = 0; i < n; i++) {
      const lo = i - w - 1, hi = i + w;
      if (hi < n) sum += env[hi];
      if (lo >= 0) sum -= env[lo];
      const cnt = Math.min(n - 1, i + w) - Math.max(0, i - w) + 1;
      o[i] = Math.max(0, env[i] - sum / cnt);
    }
    const lagOf = (bpm) => (fr * 60) / bpm;
    const minLag = Math.floor(lagOf(240)), maxLag = Math.ceil(lagOf(30));
    const ac = new Float32Array(maxLag * 3 + 2);
    for (let lag = minLag; lag <= Math.min(maxLag * 3, n - 1); lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += o[i] * o[i + lag];
      ac[lag] = s / (n - lag);
    }
    let best = -1, bestLag = 0, total = 0, count = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const bpm = (fr * 60) / lag;
      // a beat repeats, so also reward energy at 2x and 3x the spacing; prefer tempos near 110
      const comb = ac[lag] + 0.5 * (ac[2 * lag] || 0) + 0.25 * (ac[3 * lag] || 0);
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / rate / 110) / 0.8, 2));
      const score = comb * prior;
      total += ac[lag];
      count++;
      if (score > best) {
        best = score;
        bestLag = lag;
      }
    }
    if (!bestLag || !(best > 0)) return null;
    // sub-frame refinement
    const y0 = ac[bestLag - 1] || 0, y1 = ac[bestLag], y2 = ac[bestLag + 1] || 0;
    const den = y0 - 2 * y1 + y2;
    const shift = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
    const bpm = (fr * 60) / (bestLag + shift);
    const confidence = ac[bestLag] / (total / count || 1);
    return { bpm, confidence };
  }
  async function detectBpm() {
    if (detecting) return stopDetect("Stopped listening");
    const v = state.videoId ? getVideo() : null;
    if (!v) return flash("Open a video first");
    if (isAd()) return flash("Wait for the ad to finish");
    let stream;
    try {
      stream = (v.captureStream || v.mozCaptureStream).call(v);
    } catch (e) {
      return flash("Sorry, I can't listen to this video");
    }
    if (v.paused) v.play();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0;
    const proc = ctx.createScriptProcessor(512, 1, 1);
    src.connect(an);
    src.connect(proc);
    proc.connect(ctx.destination); // outputs silence; needed so it runs
    const bins = new Float32Array(an.frequencyBinCount);
    const prev = new Float32Array(an.frequencyBinCount).fill(-100);
    const env = [];
    let loud = 0;
    proc.onaudioprocess = () => {
      an.getFloatFrequencyData(bins);
      let flux = 0;
      for (let i = 2; i < bins.length; i++) {
        const b = Math.max(-100, bins[i] || -100);
        const d = b - prev[i];
        if (d > 0) flux += d;
        prev[i] = b;
        if (b > -70) loud++;
      }
      env.push(v.paused || isAd() ? 0 : flux);
    };
    const started = Date.now();
    const rateWhileListening = v.playbackRate || 1;
    detecting = { ctx, src, proc, stream, started, timer: null };
    root.querySelector(".neko")?.classList.add("listening");
    detecting.timer = setInterval(() => {
      const left = Math.max(0, LISTEN_SECONDS - Math.floor((Date.now() - started) / 1000));
      $("detectLabel").textContent = `Listening… ${left}s`;
      if (Date.now() - started < LISTEN_SECONDS * 1000) return;
      const fr = ctx.sampleRate / 512;
      const envCopy = env.slice();
      const heardSomething = loud > envCopy.length * 5;
      stopDetect();
      if (!heardSomething) return flash("🐱 I couldn't hear anything. Is the video playing and not muted?");
      const r = estimateTempo(envCopy, fr, rateWhileListening);
      if (!r) return flash("🐱 I couldn't find a steady beat. Try a part with drums or strumming.");
      const bpm = Math.round(r.bpm);
      setBpm(bpm);
      if (!metro.on) startMetro(); // play along right away
      const orig = Math.abs(state.speed - 1) > 0.001 ? ` (about ${Math.round(r.bpm / state.speed)} BPM at 100% speed)` : "";
      const sure = r.confidence > 2.2 ? "" : " Not 100% sure. Try Tap Tempo to double-check.";
      flash(`🐱 About ${bpm} BPM${orig}.${sure}`, 4500);
    }, 250);
    render();
  }
  $("detect").onclick = detectBpm;


  root.querySelectorAll("#beats button").forEach((b) => (b.onclick = () => { M().beats = +b.dataset.b; metro.beat = 0; persist(); render(); }));
  $("mVol").addEventListener("input", (e) => {
    M().vol = +e.target.value;
    if (metro.gain) metro.gain.gain.value = Math.pow(M().vol / 100, 1.5);
    persist();
  });
  [["mAccent", "accent"], ["mCat", "cat"]].forEach(([id, key]) =>
    $(id).addEventListener("change", (e) => { M()[key] = e.target.checked; persist(); render(); })
  );

  // ---------- saved sessions (video + loop + speed + metronome), reopen any time ----------
  // ---------- saved videos, each with one or more saved loops ----------
  // library = [{ id, videoId, title (YouTube's title), name (your title), desc, createdAt, updatedAt,
  //              loops: [{ id, name, a, b, looping, speed, delay, metro, createdAt, updatedAt }] }]
  let library = [];
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const videoTitle = () =>
    (document.title || "").replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube( Music)?\s*$/, "").trim() || "YouTube video";
  // one entry per video; older saves (one set of settings per video) become a video with "Loop 1"
  function normalize(list) {
    const seen = new Set();
    const out = [];
    for (const e of list || []) {
      if (!e || !e.videoId || seen.has(e.videoId)) continue;
      seen.add(e.videoId);
      if (Array.isArray(e.loops)) {
        e.id = e.id || newId();
        e.loops = e.loops.filter((l) => l && typeof l === "object").map((l) => ({ ...l, id: l.id || newId() }));
        out.push(e);
        continue;
      }
      const t = e.savedAt || Date.now();
      out.push({
        id: e.id || newId(),
        videoId: e.videoId,
        title: e.title || e.name || "YouTube video",
        name: e.name || e.title || "YouTube video",
        desc: e.desc || "",
        createdAt: t,
        updatedAt: t,
        loops: [
          { id: newId(), name: "Loop 1", a: e.a ?? null, b: e.b ?? null, looping: !!e.looping, speed: e.speed ?? 1, delay: e.delay ?? 0, metro: e.metro || {}, createdAt: t, updatedAt: t },
        ],
      });
    }
    return out;
  }
  // a video's loops are always in time order: earliest A at the top
  const sortLoops = (v) => v && v.loops.sort((x, y) => (x.a ?? Infinity) - (y.a ?? Infinity) || (x.b ?? Infinity) - (y.b ?? Infinity));
  async function loadLibrary() {
    library = normalize(await store.get("library"));
    library.forEach(sortLoops);
  }
  function saveLibrary() {
    store.set("library", library);
    render();
  }
  const videoEntry = (vid = state.videoId) => (vid ? library.find((x) => x.videoId === vid) : null);
  const curLoops = () => videoEntry()?.loops || [];
  const selectedLoop = () => curLoops().find((l) => l.id === state.loopId) || null;
  let nameEdited = false; // once you type in the loop-name box, we stop overwriting it
  const nextLoopName = () => `Loop ${curLoops().length + 1}`;
  const defaultName = () => selectedLoop()?.name || nextLoopName();
  const fmtRange = (l) => (l.a != null && l.b != null ? `${fmt(l.a)}–${fmt(l.b)}` : l.a != null ? `from ${fmt(l.a)}` : "no A–B");
  const fmtDate = (t) => {
    try {
      return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    } catch (e) {
      return "";
    }
  };
  function currentSettings() {
    const m = M();
    return {
      a: state.a,
      b: state.b,
      looping: !!(state.looping && loopValid()),
      speed: state.speed,
      delay: state.settings.delay,
      metro: { bpm: m.bpm, beats: m.beats, accent: m.accent, vol: m.vol, cat: m.cat },
    };
  }
  const snapOf = (x) =>
    JSON.stringify([x.a ?? null, x.b ?? null, x.speed ?? 1, x.delay ?? 0, x.metro?.bpm, x.metro?.beats, !!x.metro?.accent, x.metro?.vol, !!x.metro?.cat]);
  // true when the selected loop is saved and nothing has changed since (turning the loop on/off doesn't count)
  function upToDate() {
    const l = selectedLoop();
    if (!l) return false;
    return snapOf(l) === snapOf(currentSettings());
  }
  // Save: overwrite the selected loop. New: always add another loop. (A video's first save creates the video too.)
  function saveLoop(asNew) {
    if (!state.videoId) return flash("Open a video first");
    if (!loopValid()) return flash("Set A and B first");
    const now = Date.now();
    let v = videoEntry();
    let createdVideo = false;
    if (!v) {
      v = { id: newId(), videoId: state.videoId, title: videoTitle(), name: videoTitle(), desc: "", createdAt: now, updatedAt: now, loops: [] };
      library = [v, ...library]; // newest video goes to the top of the list
      createdVideo = true;
    }
    const typed = ""; // new loops are named automatically; rename them in the loop editor
    const sel = asNew ? null : selectedLoop();
    let msg;
    if (sel) {
      Object.assign(sel, currentSettings(), { name: typed || sel.name, updatedAt: now });
      msg = `Updated: ${sel.name}`;
    } else {
      let name = typed || nextLoopName();
      if (asNew && selectedLoop() && name === selectedLoop().name) name = nextLoopName();
      const l = { id: newId(), name, ...currentSettings(), createdAt: now, updatedAt: now };
      v.loops.push(l);
      state.loopId = l.id;
      msg = `Saved ${name}. Edit it with the pencil ✎`;
    }
    v.updatedAt = now;
    sortLoops(v);
    nameEdited = false;
    // ＋ (a new loop) stops the current loop playing, so you can move on to the next part
    if (asNew && state.looping) {
      state.looping = false;
      state.loopCount = 0;
      cancelWait();
      msg += " · loop stopped";
    }
    persist();
    saveLibrary();
    flash(msg);
  }
  // load a saved loop's settings into the panel
  function applyLoop(l, quiet) {
    state.loopId = l.id;
    state.a = l.a ?? null;
    state.b = l.b ?? null;
    state.settings.delay = l.delay ?? 0;
    Object.assign(M(), l.metro || {});
    if (metro.gain) metro.gain.gain.value = Math.pow(M().vol / 100, 1.5);
    setSpeed(l.speed ?? 1);
    const v = getVideo();
    if (l.looping && loopValid()) {
      state.looping = false;
      toggleLoop(true);
    } else {
      state.looping = false;
      if (v && state.a != null) v.currentTime = state.a;
    }
    nameEdited = false;
    persist();
    render();
    if (!quiet) {
      const ls = curLoops();
      flash(`${ls.indexOf(l) + 1}/${ls.length}: ${l.name}`);
    }
  }
  function deleteLoop(v, l, msg) {
    v.loops = v.loops.filter((x) => x.id !== l.id);
    if (v.videoId === state.videoId && state.loopId === l.id) state.loopId = null;
    v.updatedAt = Date.now();
    nameEdited = false;
    persist();
    saveLibrary();
    renderLibrary(true);
    flash(msg || `Deleted loop: ${l.name}`);
  }
  // save the video itself (no loop needed)
  function saveVideo() {
    if (!state.videoId) return flash("Open a video first");
    if (videoEntry()) return;
    const now = Date.now();
    library = [{ id: newId(), videoId: state.videoId, title: videoTitle(), name: videoTitle(), desc: "", createdAt: now, updatedAt: now, loops: [] }, ...library];
    expanded.add(library[0].id);
    saveLibrary();
    renderLibrary(true);
    flash("Video Saved");
  }
  function stepLoop(dir) {
    const ls = curLoops();
    if (!ls.length) return;
    const i = ls.findIndex((l) => l.id === state.loopId);
    const j = i < 0 ? (dir > 0 ? 0 : ls.length - 1) : (i + dir + ls.length) % ls.length;
    applyLoop(ls[j]);
  }
  function startNewLoop() {
    state.loopId = null;
    if (state.looping) {
      // stop the current loop so you can go to the next part
      state.looping = false;
      state.loopCount = 0;
      cancelWait();
    }
    nameEdited = false;
    persist();
    render();
    flash("New loop: set A and B, speed and metronome, then press Save Loop");
  }
  async function openSaved(videoId, loopId) {
    closeLib();
    if (videoId === state.videoId) {
      const l = curLoops().find((x) => x.id === loopId) || curLoops()[0];
      if (l) applyLoop(l);
      return;
    }
    // Remember what to load, then open the video; it's applied as soon as the video is ready.
    await store.set("pendingLoad", { videoId, loopId, at: Date.now() });
    location.href = "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId);
  }
  async function applyPendingFor(id) {
    const p = await store.get("pendingLoad");
    if (!p || Date.now() - p.at > 120000 || p.videoId !== id) return;
    store.set("pendingLoad", null);
    if (state.settings.hidden) openApp(); // you opened it from Saved videos: keep the companion running
    for (let i = 0; i < 60; i++) {
      // wait until the video is ready (up to ~15 s)
      const v = getVideo();
      if (state.videoId !== id) return;
      if (v && v.readyState >= 1 && isFinite(v.duration) && !isAd()) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const ls = curLoops();
    const l = ls.find((x) => x.id === p.loopId) || ls[0];
    if (l) applyLoop(l);
  }

  // ----- the loop bar at the top of the panel -----
  $("loopSel").addEventListener("change", (e) => {
    const l = curLoops().find((x) => x.id === e.target.value);
    l ? applyLoop(l) : startNewLoop();
    e.target.blur();
  });
  $("saveCur").onclick = () => loopValid() && saveLoop(false);
  $("saveVid").onclick = saveVideo;
  $("saveNew").onclick = () => saveLoop(true);
  // the metronome section can be folded away; remember the choice (open by default)
  $("metroSec").addEventListener("toggle", () => {
    if (state.settings.metroOpen === $("metroSec").open) return;
    state.settings.metroOpen = $("metroSec").open;
    store.set("settings", state.settings); // save right away
  });
  function renderSaveRow() {
    $("libCount").textContent = library.length;
    $("libCount").style.display = library.length ? "" : "none";
    if (!state.videoId) return;
    const ls = curLoops();
    const i = ls.findIndex((l) => l.id === state.loopId);
    // drop-down: only rebuilt when the list changes
    const sel = $("loopSel");
    const ve = videoEntry();
    const sig = JSON.stringify([ve ? ve.name || ve.title : null, ls.map((l) => [l.id, l.name])]);
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML = "";
      if (ve) {
        // the saved video first; picking it means "no loop selected" (start a new one)
        const o = document.createElement("option");
        o.value = "";
        o.className = "vidopt";
        o.textContent = ve.name || ve.title || "This video";
        sel.appendChild(o);
      }
      ls.forEach((l, k) => {
        const o = document.createElement("option");
        o.value = l.id;
        o.textContent = `\u00a0\u00a0\u00a0${k + 1}. ${l.name}`;
        sel.appendChild(o);
      });
    }
    sel.disabled = !ve; // nothing saved yet: empty list
    if (root.activeElement !== sel && ve) sel.value = i >= 0 ? state.loopId : "";
    $("loopEdit").disabled = i < 0;
    $("loopSel").title = !ve ? "Nothing saved yet" : i >= 0 ? `Loop ${i + 1} of ${ls.length}` : ls.length ? `Saved video with ${ls.length} loop${ls.length === 1 ? "" : "s"}. Pick a loop to load it` : "Saved video, no loops yet";
    // Save: saves the loop (overwrites the selected one, or adds a new one); saving a loop also saves its video
    const btn = $("saveCur");
    const defined = loopValid();
    const green = defined && upToDate();
    const label = green ? "Loop Saved" : "Save Loop";
    const tip = !defined
      ? "Set A and B to save a loop"
      : green
        ? "Saved. Nothing has changed since"
        : i >= 0
          ? `Overwrite “${ls[i].name}” with the current settings`
          : ls.length
            ? "Save the current settings as a new loop"
            : "Save the current settings as this video's first loop (the video is saved with it)";
    const mode = "loop";
    btn.classList.toggle("is-saved", green);
    btn.disabled = !defined; // nothing to save until A and B are set
    // "Save video" next to the time: saves the video on its own; disabled once it's saved
    const vb = $("saveVid");
    const vidSaved = !!videoEntry();
    if (vb.dataset.s !== String(vidSaved)) {
      vb.dataset.s = String(vidSaved);
      vb.innerHTML = vidSaved
        ? '<svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.4 6.3 L5 8.7 L9.6 3.5"/></svg><span>Video Saved</span>'
        : '<svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 1.5 H9 V10.5 L6 8.2 L3 10.5 Z"/></svg><span>Save Video</span>';
    }
    vb.disabled = vidSaved;
    vb.classList.toggle("is-saved", vidSaved);
    vb.title = vidSaved ? "This video is saved (see the list at the top)" : "Save this video now; you can add loops later";
    const key = `${mode}|${label}`;
    if (btn.dataset.s !== key) {
      btn.innerHTML = (green ? '<svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M2.4 6.3 L5 8.7 L9.6 3.5"/></svg>' : '<svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M2 2 h6.6 L10 3.4 V10 H2 Z M4 2 v2.4 h3.6 V2 M3.8 10 V7.2 h4.4 V10"/></svg>') + `<span>${label}</span>`;
      btn.dataset.s = key;
    }
    btn.title = tip;
    $("saveNew").disabled = !defined || i < 0; // with nothing selected, Save already adds a new loop
    $("saveNew").title = defined ? "Add the current settings as a new loop" : "Set A and B to add a loop";
  }

  // ----- "Saved videos" manager -----
  let editing = null; // { kind: "video"|"loop", id }
  let confirmDel = null; // id whose bin was clicked once
  let confirmTimer = null;
  const expanded = new Set();
  const ICON = {
    up: '<svg class="hico" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 7.75 L6 4.25 L9.5 7.75"/></svg>',
    down: '<svg class="hico" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 4.25 L6 7.75 L9.5 4.25"/></svg>',
    right: '<svg class="hico" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M4.25 2.5 L7.75 6 L4.25 9.5"/></svg>',
    play: '<svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3.5 2.2 L9.6 6 L3.5 9.8 Z" fill="currentColor"/></svg>',
    edit: '<svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M8.2 1.8 l2 2 L4.4 9.6 L1.8 10.2 L2.4 7.6 Z M7 3 l2 2"/></svg>',
    del: '<svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M2 3.2 h8 M4.6 3.2 V2 h2.8 v1.2 M3 3.2 l.6 7 h4.8 l.6 -7 M5 5 v3.6 M7 5 v3.6"/></svg>',
  };
  const SORTS = { custom: "My order", newest: "Newest first", oldest: "Oldest first", az: "Name A–Z", za: "Name Z–A" };
  const sortMode = () => (SORTS[state.settings.libSort] ? state.settings.libSort : "custom");
  function viewList() {
    const list = library.slice();
    const nm = (v) => (v.name || v.title || "").toLocaleLowerCase();
    switch (sortMode()) {
      case "newest":
        return list.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
      case "oldest":
        return list.sort((x, y) => (x.updatedAt || 0) - (y.updatedAt || 0));
      case "az":
        return list.sort((x, y) => nm(x).localeCompare(nm(y)));
      case "za":
        return list.sort((x, y) => nm(y).localeCompare(nm(x)));
      default:
        return list;
    }
  }
  const anyModalOpen = () => ["libModal", "helpModal", "loopModal"].some((id) => $(id).classList.contains("show"));
  function openLib() {
    closeHelp();
    editing = null;
    confirmDel = null;
    if (state.videoId) expanded.add(videoEntry()?.id);
    $("libSearch").value = "";
    renderLibrary(true);
    $("libModal").classList.add("show");
  }
  function closeLib() {
    $("libModal").classList.remove("show");
    editing = null;
    confirmDel = null;
  }
  function moveIn(arr, id, dir) {
    const i = arr.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    saveLibrary();
    renderLibrary(true);
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function iconBtn(html, title, onClick, cls) {
    const b = el("button", cls || "");
    b.innerHTML = html;
    b.title = title;
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onClick(b);
    });
    return b;
  }
  function delBtn(id, title, onDelete) {
    const armed = confirmDel === id;
    return iconBtn(
      armed ? "Delete?" : ICON.del,
      armed ? "Click again to delete" : title,
      () => {
        if (confirmDel === id) {
          confirmDel = null;
          onDelete();
        } else {
          confirmDel = id;
          clearTimeout(confirmTimer);
          confirmTimer = setTimeout(() => {
            confirmDel = null;
            renderLibrary(true);
          }, 3000);
          renderLibrary(true);
        }
      },
      "del" + (armed ? " confirm" : "")
    );
  }
  function editForm(fields, onSave) {
    const form = el("div", "edit");
    const inputs = fields.map((f) => {
      form.append(el("label", "", f.label));
      const inp = el(f.multiline ? "textarea" : "input");
      if (!f.multiline) inp.type = "text";
      else inp.rows = 3;
      inp.maxLength = f.max || 120;
      inp.placeholder = f.placeholder || "";
      inp.value = f.value || "";
      form.append(inp);
      return inp;
    });
    const btns = el("div", "btns");
    const cancel = el("button", "", "Cancel");
    const ok = el("button", "primary", "Save changes");
    cancel.onclick = () => {
      editing = null;
      renderLibrary(true);
    };
    ok.onclick = () => {
      onSave(inputs.map((i) => i.value.trim()));
      editing = null;
      saveLibrary();
      renderLibrary(true);
    };
    inputs[0].addEventListener("keydown", (k) => k.key === "Enter" && ok.click());
    btns.append(cancel, ok);
    form.append(btns);
    setTimeout(() => inputs[0].focus(), 0);
    return form;
  }
  function renderLibrary(force) {
    const list = $("lib");
    const q = $("libSearch").value.trim().toLocaleLowerCase();
    const sig = JSON.stringify([library, state.videoId, state.loopId, editing, confirmDel, [...expanded], sortMode(), q]);
    if (!force && list.dataset.sig === sig) return;
    if (!force && editing && $("libModal").classList.contains("show")) return; // don't wipe what you're typing
    list.dataset.sig = sig;
    list.innerHTML = "";
    root.querySelectorAll(".sortbtn").forEach((b) => b.classList.toggle("active", b.dataset.sort === sortMode()));
    const nl = library.reduce((n, v) => n + v.loops.length, 0);
    $("libStats").textContent = library.length ? `${library.length} video${library.length === 1 ? "" : "s"} · ${nl} loop${nl === 1 ? "" : "s"}` : "";
    $("libExport").disabled = !library.length;
    // the video you're watching isn't saved yet: offer to save it
    if (state.videoId && !videoEntry()) {
      const c = el("div", "savecard");
      const meta = el("div", "meta");
      meta.append(el("div", "name", videoTitle()), el("div", "sub", "This video isn't saved yet"));
      const b = el("button", "primary", "＋ Save this video");
      b.id = "libSaveVid";
      b.title = "Save the video that's playing (you can add loops any time)";
      b.onclick = saveVideo;
      c.append(meta, b);
      list.appendChild(c);
    }
    if (!library.length) {
      list.appendChild(el("div", "empty", "No saved videos yet."));
      return;
    }
    const custom = sortMode() === "custom";
    // search: video title, description, loop names and notes
    const has = (t) => !!t && t.toLocaleLowerCase().includes(q);
    const loopHit = (v) => v.loops.some((l) => has(l.name) || has(l.desc));
    const view = viewList().filter((v) => !q || has(v.name) || has(v.title) || has(v.desc) || loopHit(v));
    if (q && !view.length) list.appendChild(el("div", "nomatch", `No saved videos match “${$("libSearch").value.trim()}”.`));
    view.forEach((v, idx) => {
      if (q && loopHit(v)) expanded.add(v.id); // show the loops that matched
      const here = v.videoId === state.videoId;
      const card = el("div", "vid" + (here ? " current" : ""));
      const head = el("div", "item");
      const img = el("img");
      img.src = `https://i.ytimg.com/vi/${encodeURIComponent(v.videoId)}/default.jpg`;
      img.alt = "";

      if (editing && editing.kind === "video" && editing.id === v.id) {
        head.append(
          img,
          editForm(
            [
              { label: "Title", value: v.name || v.title, max: 120 },
              { label: "Description", value: v.desc, multiline: true, max: 1000, placeholder: "Notes, e.g. tuning, capo, what to work on…" },
            ],
            ([name, desc]) => {
              v.name = name || v.title;
              v.desc = desc;
              v.updatedAt = Date.now();
              flash(`Updated: ${v.name}`);
            }
          )
        );
        card.append(head);
        list.appendChild(card);
        return;
      }

      const order = el("div", "order");
      const up = iconBtn(ICON.up, custom ? "Move up" : "Switch to “My order” to rearrange", () => moveIn(library, v.id, -1));
      const down = iconBtn(ICON.down, custom ? "Move down" : "Switch to “My order” to rearrange", () => moveIn(library, v.id, +1));
      up.disabled = !custom || !!q || idx === 0;
      down.disabled = !custom || !!q || idx === view.length - 1;
      order.append(up, down);

      const pick = el("div", "pick");
      pick.title = here ? "Load the first loop" : "Open this video";
      const meta = el("div", "meta");
      meta.append(el("div", "name", v.name || v.title));
      if (v.desc) meta.append(el("div", "desc", v.desc));
      const n = v.loops.length;
      meta.append(el("div", "sub", `${here ? "This video · " : ""}${n ? `${n} loop${n === 1 ? "" : "s"}` : "no loops"} · saved ${fmtDate(v.updatedAt)}`));
      pick.append(img, meta);
      pick.addEventListener("click", () => openSaved(v.videoId, here ? state.loopId : v.loops[0]?.id));

      const acts = el("div", "acts");
      const open = expanded.has(v.id);
      const tog = iconBtn(open ? ICON.down : ICON.right, open ? "Hide loops" : "Show loops", () => {
        open ? expanded.delete(v.id) : expanded.add(v.id);
        renderLibrary(true);
      });
      acts.append(
        tog,
        iconBtn(ICON.edit, "Edit title and description", () => {
          editing = { kind: "video", id: v.id };
          confirmDel = null;
          renderLibrary(true);
        }),
        iconBtn(ICON.del, "Delete this video and all its loops", () => {
          library = library.filter((x) => x.id !== v.id);
          if (here) state.loopId = null;
          saveLibrary();
          renderLibrary(true);
          flash(`Deleted: ${v.name || v.title}`);
          if (!library.length) closeLib();
        }, "del")
      );
      head.append(order, pick, acts);
      card.append(head);

      if (open) {
        const loops = el("div", "loops");
        v.loops.forEach((l, k) => {
          const row = el("div", "lrow" + (here && l.id === state.loopId ? " sel" : ""));
          if (editing && editing.kind === "loop" && editing.id === l.id) {
            row.append(
              editForm([{ label: "Loop name", value: l.name, max: 80 }], ([name]) => {
                l.name = name || l.name;
                l.updatedAt = Date.now();
                if (here && l.id === state.loopId) nameEdited = false;
                flash(`Renamed: ${l.name}`);
              })
            );
            loops.append(row);
            return;
          }
          const lp = el("div", "lpick");
          lp.title = "Edit this loop";
          lp.append(el("div", "lname", `${k + 1}. ${l.name}`));
          lp.append(
            el("div", "sub", `${fmtRange(l)} · ${fmtSpeed(l.speed ?? 1)} · ${l.metro?.bpm ?? "–"} BPM${l.delay ? ` · pause ${l.delay}s` : ""}`)
          );
          if (l.desc) lp.append(el("div", "desc", l.desc));
          lp.addEventListener("click", () => openLoopEditor(v.videoId, l.id));
          const la = el("div", "acts");
          la.append(
            iconBtn(ICON.play, "Open this loop", () => openSaved(v.videoId, l.id)),
            iconBtn(ICON.edit, "Edit this loop", () => openLoopEditor(v.videoId, l.id)),
            iconBtn(ICON.del, "Delete this loop", () => deleteLoop(v, l), "del")
          );
          row.append(lp, la);
          loops.append(row);
        });
        if (!v.loops.length) loops.append(el("div", "muted", "No loops yet. Open the video, set A and B, and press Save Loop."));
        card.append(loops);
      }
      list.appendChild(card);
    });
  }
  $("libBtn").onclick = () => ($("libModal").classList.contains("show") ? closeLib() : openLib());
  $("libClose").onclick = closeLib;
  root.querySelectorAll(".sortbtn").forEach((b) =>
    b.addEventListener("click", () => {
      state.settings.libSort = b.dataset.sort;
      persist();
      renderLibrary(true);
    })
  );
  $("libSearch").addEventListener("input", () => renderLibrary(true));

  // ----- export / import (every saved video and loop has a unique id, so duplicates are skipped) -----
  const FILE_APP = "YouTube Guitar Playa Companion";
  function exportLibrary() {
    if (!library.length) return flash("Nothing saved to export yet");
    const nLoops = library.reduce((n, v) => n + v.loops.length, 0);
    const data = { app: FILE_APP, format: 1, exportedAt: new Date().toISOString(), videos: library };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `guitar-playa-companion-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    flash(`Exported ${library.length} video${library.length === 1 ? "" : "s"} and ${nLoops} loop${nLoops === 1 ? "" : "s"}`);
  }
  const sameLoop = (x, y) =>
    x.id === y.id || (x.name === y.name && (x.a ?? null) === (y.a ?? null) && (x.b ?? null) === (y.b ?? null) && (x.speed ?? 1) === (y.speed ?? 1));
  async function importFiles(files) {
    let newVideos = 0, newLoops = 0, dups = 0, badFiles = 0;
    for (const f of files) {
      let vids = null;
      try {
        const data = JSON.parse(await f.text());
        vids = Array.isArray(data) ? data : Array.isArray(data && data.videos) ? data.videos : null;
      } catch (e) {}
      if (!vids) {
        badFiles++;
        continue;
      }
      vids = vids.filter((v) => v && typeof v.videoId === "string" && /^[\w-]{1,64}$/.test(v.videoId));
      for (const v of normalize(vids)) {
        const have = library.find((x) => x.id === v.id) || library.find((x) => x.videoId === v.videoId);
        if (!have) {
          library.push({ ...v, loops: v.loops.map((l) => ({ ...l })) });
          newVideos++;
          newLoops += v.loops.length;
          continue;
        }
        let added = 0;
        for (const l of v.loops) {
          if (have.loops.some((x) => sameLoop(x, l))) dups++;
          else {
            have.loops.push({ ...l });
            added++;
          }
        }
        if (!v.loops.length) dups++; // the same video, nothing new in it
        if (!have.desc && v.desc) have.desc = v.desc;
        newLoops += added;
        sortLoops(have);
      }
    }
    library.forEach(sortLoops);
    saveLibrary();
    renderLibrary(true);
    const parts = [];
    if (newVideos || newLoops) parts.push(`Imported ${newVideos} video${newVideos === 1 ? "" : "s"} and ${newLoops} loop${newLoops === 1 ? "" : "s"}`);
    else parts.push("Nothing new to import");
    if (dups) parts.push(`skipped ${dups} duplicate${dups === 1 ? "" : "s"}`);
    if (badFiles) parts.push(`${badFiles} file${badFiles === 1 ? " wasn't" : "s weren't"} a saved-videos file`);
    flash(parts.join(", "), 4500);
  }
  $("libExport").onclick = exportLibrary;
  $("libImport").onclick = () => $("libFile").click();
  $("libFile").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) await importFiles(files);
  });
  $("libModal").addEventListener("click", (e) => {
    if (e.target === $("libModal")) closeLib(); // click outside the box closes it
  });
  function closeModals() {
    if ($("loopModal").classList.contains("show")) return closeLoopEditor(); // the editor sits on top; close it first
    closeLib();
    closeHelp();
  }
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && !dead && anyModalOpen()) {
        closeModals();
        e.stopPropagation();
      }
    },
    true
  );
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModals();
  });

  // ----- Loop editor window: label, description and all of a loop's settings -----
  let edLoop = null; // { v, l } being edited
  function openLoopEditor(videoId, loopId) {
    const v = library.find((x) => x.videoId === videoId);
    const l = v && v.loops.find((x) => x.id === loopId);
    if (!l) return;
    edLoop = { v, l };
    const m = l.metro || {};
    const k = v.loops.indexOf(l) + 1;
    $("leTitle").textContent = `Loop ${k} of ${v.loops.length} · ${v.name || v.title}`;
    $("leName").value = l.name || "";
    $("leDesc").value = l.desc || "";
    $("leA").value = l.a != null ? fmt(l.a) : "";
    $("leB").value = l.b != null ? fmt(l.b) : "";
    $("leLoop").checked = !!l.looping;
    $("leSpeed").value = Math.round((l.speed ?? 1) * 100);
    $("leDelay").value = l.delay ?? 0;
    $("leBpm").value = m.bpm ?? 120;
    $("leBeats").value = String(m.beats ?? 4);
    $("leAccent").checked = m.accent !== false;
    $("leInfo").textContent = `Saved ${fmtDate(l.updatedAt || l.createdAt)}`;
    $("leErr").textContent = "";
    $("leDel").innerHTML = ICON.del + "<span>Delete loop</span>";
    $("loopModal").classList.add("show");
    setTimeout(() => $("leName").focus(), 0);
  }
  function closeLoopEditor() {
    $("loopModal").classList.remove("show");
    edLoop = null;
  }
  function saveLoopEditor() {
    if (!edLoop) return;
    const { v, l } = edLoop;
    const err = (t) => ($("leErr").textContent = t);
    const a = $("leA").value.trim() ? parseTime($("leA").value) : null;
    const b = $("leB").value.trim() ? parseTime($("leB").value) : null;
    if ($("leA").value.trim() && a == null) return err("A: use a time like 1:23.4");
    if ($("leB").value.trim() && b == null) return err("B: use a time like 1:31.0");
    if (b != null && a == null) return err("Set A before B");
    if (a != null && b != null && b <= a) return err("B must be after A");
    const speed = Number($("leSpeed").value);
    if (!(speed >= 25 && speed <= 500)) return err("Speed: 25% to 500%");
    const delay = Number($("leDelay").value);
    if (!(delay >= 0 && delay <= 10)) return err("Pause: 0 to 10 seconds");
    const bpm = Math.round(Number($("leBpm").value));
    if (!(bpm >= 30 && bpm <= 240)) return err("BPM: 30 to 240");
    l.name = $("leName").value.trim() || l.name;
    l.desc = $("leDesc").value.trim();
    l.a = a != null ? round2(a) : null;
    l.b = b != null ? round2(b) : null;
    l.looping = $("leLoop").checked && l.a != null && l.b != null;
    l.speed = round2(speed / 100);
    l.delay = Math.round(delay * 2) / 2;
    l.metro = { ...(l.metro || {}), bpm, beats: Number($("leBeats").value), accent: $("leAccent").checked };
    l.updatedAt = v.updatedAt = Date.now();
    sortLoops(v);
    const loaded = v.videoId === state.videoId && state.loopId === l.id;
    closeLoopEditor();
    saveLibrary();
    renderLibrary(true);
    if (loaded) applyLoop(l, true); // the loop you're playing picks up the changes right away
    flash(`Saved: ${l.name}`);
  }
  $("leSave").onclick = saveLoopEditor;
  $("leCancel").onclick = closeLoopEditor;
  $("loopClose").onclick = closeLoopEditor;
  $("leOpen").onclick = () => {
    if (!edLoop) return;
    const { v, l } = edLoop;
    closeLoopEditor();
    openSaved(v.videoId, l.id);
  };
  $("leDel").onclick = () => {
    if (!edLoop) return;
    const { v, l } = edLoop;
    closeLoopEditor();
    deleteLoop(v, l);
  };
  $("loopModal").addEventListener("click", (e) => {
    if (e.target === $("loopModal")) closeLoopEditor();
  });
  ["leName", "leA", "leB", "leSpeed", "leDelay", "leBpm"].forEach((id) =>
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveLoopEditor();
    })
  );
  $("loopEdit").onclick = () => state.loopId && openLoopEditor(state.videoId, state.loopId);

  // ----- theme: System (follows your computer) / Day / Night -----
  const THEMES = ["system", "light", "dark"];
  const THEME_ICON = {
    system:
      '<svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><circle cx="6" cy="6" r="4.6"/><path d="M6 1.4 a4.6 4.6 0 0 1 0 9.2 z" fill="currentColor"/></svg>',
    light:
      '<svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><circle cx="6" cy="6" r="2.1"/><path d="M6 .8 v1.3 M6 9.9 v1.3 M.8 6 h1.3 M9.9 6 h1.3 M2.3 2.3 l.9 .9 M8.8 8.8 l.9 .9 M2.3 9.7 l.9 -.9 M8.8 3.2 l.9 -.9"/></svg>',
    dark: '<svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M9.7 7.7 A4.3 4.3 0 1 1 4.3 2.3 A3.4 3.4 0 0 0 9.7 7.7 z"/></svg>',
  };
  const THEME_NAME = { system: "System", light: "Day", dark: "Night" };
  const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function applyTheme() {
    const t = THEMES.includes(state.settings.theme) ? state.settings.theme : "dark";
    const resolved = t === "system" ? (darkQuery && !darkQuery.matches ? "light" : "dark") : t;
    host.setAttribute("data-theme", resolved);
    const b = $("themeBtn");
    if (b.dataset.t !== t) {
      b.innerHTML = THEME_ICON[t];
      b.dataset.t = t;
    }
    const next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    b.title = `Theme: ${THEME_NAME[t]}${t === "system" ? " (follows your computer)" : ""}. Click for ${THEME_NAME[next]}`;
  }
  $("themeBtn").onclick = () => {
    const t = THEMES.includes(state.settings.theme) ? state.settings.theme : "dark";
    state.settings.theme = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    state.settings.themeChosen = true;
    persist();
    applyTheme();
    flash(`Theme: ${THEME_NAME[state.settings.theme]}`);
  };
  try {
    darkQuery && darkQuery.addEventListener("change", () => !dead && applyTheme());
  } catch (e) {}

  // ----- help -----
  const HELP_DIMS = { "help-loop.png": [300, 172], "help-loopbar.png": [300, 56], "help-editor.png": [300, 332], "help-metronome.png": [300, 204], "help-saved.png": [300, 320] };
  const helpImg = (file, alt) => {
    let src = "";
    try {
      src = chrome.runtime.getURL("help/" + file);
    } catch (e) {}
    const [w, h] = HELP_DIMS[file] || [300, 200];
    return src ? `<figure><img src="${src}" alt="${alt}" width="${w}" height="${h}" /></figure>` : "";
  };
  function buildHelp() {
    const k = (x) => `<kbd>${x}</kbd>`;
    $("helpBody").innerHTML = `
      <h3>Quick start</h3>
      <ol>
        <li>Open a YouTube video and click the maneki-neko icon in the toolbar. The companion only starts when you click it.</li>
        <li>Press <b>Set A</b> where the part starts and <b>Set B</b> where it ends. The loop starts right away.</li>
        <li>Slow it down with <b>Speed</b> (for example 75%). The pitch stays the same.</li>
        <li>In the <b>Metronome</b> section, press <b>▶ Start</b>, or <b>Auto BPM</b> to let the cat find the tempo.</li>
        <li>Press <b>Save Loop</b> at the top to keep the loop for next time. The pencil lets you name it.</li>
      </ol>

      <h3>Looping a part</h3>
      ${helpImg("help-loop.png", "Now time, A and B, To A / Play / To B, and the loop button")}
      <ul>
        <li><b>Now</b> shows where the video is, to a tenth of a second.</li>
        <li><b>Set A</b> / <b>Set B</b> use the current time. B is available once A is set. Fine-tune with <b>−</b> / <b>+</b> (0.1 s, Shift-click: 1 s), or type a time such as <code>1:23.4</code>.</li>
        <li><b>To A</b> / <b>To B</b> jump to the loop points (while looping, To B lands 2 seconds before B). <b>▶ Play / ⏸ Pause</b> in between.</li>
        <li><b>Loop</b> turns the loop on or off and counts the repeats (×3). <b>Clear</b> removes A and B.</li>
        <li><b>Change speed each loop</b>: tick it, then choose how much each repeat changes the speed (for example <b>+5%</b> to speed up, <b>-5%</b> to slow down) and the speed to stop at. When it gets there, the loop carries on at that speed. <b>↺</b> goes back to the starting speed; untick to turn it off.</li>
        <li><b>Speed</b>: 25% to 500% in 5% steps with − / + or the slider, or type a speed such as <code>80</code> and press Enter. The pitch stays the same. <b>Pause between loops</b> (seconds of silence before each repeat) is right below.</li>
      </ul>

      <h3>Saving videos and loops</h3>
      ${helpImg("help-loopbar.png", "The loop bar: loop list, Save, new loop and edit")}
      <ul>
        <li>A video can have any number of loops, each with its own A/B, speed, pause and metronome settings. Once the video is saved, the list shows the <b>video</b> at the top with its loops under it, in time order (earliest first). Pick a loop to load it; pick the video to start a new loop. The list stays empty until the video is saved.</li>
        <li><b>Save Loop</b> (available once A and B are set) stores the current settings in the selected loop, or as a new loop if none is selected. Saving a loop saves its video too. It turns green, <b>✓ Loop Saved</b>, while nothing has changed.</li>
        <li>To save a video without a loop, use <b>Save Video</b> next to the time. Once the video is saved it shows <b>✓ Video Saved</b> and can't be clicked.</li>
        <li><b>＋</b> adds the current settings as a new loop. New loops are named "Loop 1", "Loop 2"… Edit them with the <b>pencil</b>. Adding a new loop (or picking the video in the list) stops the current loop, so you can move on to the next part.</li>
        <li><b>Clear</b> removes A and B; if a saved loop is selected, it's removed from the list too.</li>
      </ul>
      ${helpImg("help-editor.png", "The loop editor")}
      <p>The <b>loop editor</b> (pencil) changes a loop's name and description, and its A/B, loop on/off, speed, pause, BPM, beats and accent. <b>Delete loop</b> removes it with one click.</p>
      ${helpImg("help-saved.png", "Saved videos, with one video's loops shown")}
      <p>The <b>list</b> button at the top opens <b>Saved videos</b>. Type in the <b>search</b> box to find a video by title, description or loop name. The <b>sort icons</b> show your own order, newest or oldest first, or A–Z / Z–A. Click a video to open it. The arrow shows its loops: click a loop to edit it, or ▶ to play it. ▲ ▼ rearrange videos (in your own order), the pencil edits a video's title and description, and the bin deletes straight away.</p>
      <p><b>Export</b> (at the bottom of the list) saves all your saved videos and loops to a file, for a backup or another computer. <b>Import</b> adds videos from one or more such files. Each saved video and loop has its own ID, so <b>duplicates are skipped</b>: a video you already have only gets the loops it's missing.</p>

      <h3>Metronome and the cat</h3>
      ${helpImg("help-metronome.png", "The metronome section with the maneki-neko")}
      <ul>
        <li>The <b>Metronome</b> section is at the bottom. Click its title to fold it away or open it again. Folded, it still shows the BPM and whether it's playing.</li>
        <li>While looping, the metronome restarts on beat 1 each time the video jumps back to A, so the click always lines up with the loop.</li>
        <li><b>▶ Start</b> / <b>⏹ Stop</b> the click. − / + or the BPM slider set the tempo, and <b>Tap</b> sets it by tapping along 4–5 times.</li>
        <li><b>Auto BPM</b>: the cat listens for about 10 seconds, sets the BPM and starts the metronome. The cat's paw comes down on every beat.</li>
        <li><b>Beats</b> per bar, <b>Vol</b>, <b>Accent Beat 1</b> and <b>Maneki-neko</b> (show the cat) are at the end of the section.</li>
      </ul>

      <h3>Buttons at the top</h3>
      <p>List: saved videos · moon: theme (Night, System, Day) · <b>?</b>: this help · chevron: minimize · ✕: exit (stops everything and puts the video back to normal speed). Drag the title bar to move the panel. Click the toolbar icon to start it again.</p>

      <h3>Keyboard shortcuts</h3>
      <table>
        <tr><td>${k("[")} / ${k("]")}</td><td>Set A / set B</td></tr>
        <tr><td>${k("\\")}</td><td>Loop on/off</td></tr>
        <tr><td>${k(";")}</td><td>Jump to A</td></tr>
        <tr><td>${k("Backspace")}</td><td>Clear the loop</td></tr>
        <tr><td>${k("-")} / ${k("=")}</td><td>Speed down / up 5%</td></tr>
        <tr><td>${k("Esc")}</td><td>Close a pop-up</td></tr>
      </table>

      <h3>About</h3>
      <p>YouTube Guitar Playa Companion ${VERSION ? "v" + VERSION : ""}. No private data is saved; your settings stay in this browser.</p>
      <div class="warnbox"><b>Warning</b><br />For private, personal use. Experimental and not supported. Use at your own risk. It is provided as is, with no warranty, and it may stop working when YouTube changes its website. It is not published in the Chrome Web Store or on Firefox Add-ons.</div>
    `;
  }
  function openHelp() {
    closeLib();
    if (!$("helpBody").childElementCount) buildHelp();
    $("helpModal").classList.add("show");
    $("helpBody").scrollTop = 0;
  }
  function closeHelp() {
    $("helpModal").classList.remove("show");
  }
  $("helpBtn").onclick = () => ($("helpModal").classList.contains("show") ? closeHelp() : openHelp());
  $("helpClose").onclick = closeHelp;
  $("helpModal").addEventListener("click", (e) => {
    if (e.target === $("helpModal")) closeHelp();
  });
  // keep the list in sync when you save from another YouTube tab
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && ch.library && !dead) {
        library = normalize(ch.library.newValue);
        library.forEach(sortLoops);
        render();
      }
    });
  } catch (e) {}

  // ---------- keyboard shortcuts (physical keys, so they work on any layout) ----------
  window.addEventListener(
    "keydown",
    (e) => {
      if (dead || state.settings.hidden || !state.videoId || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t === host)) return;
      const actions = {
        BracketLeft: () => setA(),
        BracketRight: () => setB(),
        Backslash: () => toggleLoop(),
        Semicolon: goToA,
        Backspace: clearLoop,
        Minus: () => setSpeed(state.speed - 0.05),
        Equal: () => setSpeed(state.speed + 0.05),
      };
      const fn = actions[e.code];
      if (fn) {
        fn();
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  // ---------- exit / open ----------
  // Exit turns everything off: loop, metronome, and speed goes back to 100%. The toolbar icon opens it again.
  function exitApp() {
    state.looping = false;
    cancelWait();
    if (metro.on) stopMetro();
    stopDetect();
    state.speed = 1;
    const v = getVideo();
    if (v && !isAd()) v.playbackRate = 1;
    state.settings.hidden = true;
    syncBridge(true); // releases the speed lock
    persist();
    render();
  }
  let openRequested = false;
  function openApp() {
    openRequested = true;
    state.settings.hidden = false;
    state.settings.collapsed = false;
    persist();
    applySpeed();
    render();
  }
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "open-panel") openApp();
  });

  // ---------- loop markers on the progress bar + messages inside the player ----------
  const pageStyle = document.createElement("style");
  pageStyle.textContent = `
    .ygc-range { position:absolute; top:0; height:100%; background:rgba(62,166,255,.45); pointer-events:none; z-index:33; }
    .ygc-mark { position:absolute; top:-4px; height:calc(100% + 8px); width:3px; margin-left:-1px; background:#3ea6ff;
      border-radius:2px; pointer-events:none; z-index:34; }
    .ygc-toast { position:absolute; top:12%; left:50%; transform:translateX(-50%); background:rgba(0,0,0,.75); color:#fff;
      font:500 15px Roboto, Arial, sans-serif; padding:8px 14px; border-radius:8px; z-index:70; pointer-events:none;
      opacity:0; transition:opacity .2s; }
    .ygc-toast.show { opacity:1; }
  `;
  document.documentElement.appendChild(pageStyle);

  function renderMarks() {
    // Markers on the progress bar
    const prog = document.querySelector("#movie_player .ytp-progress-bar");
    const v = getVideo();
    let marks = prog && prog.querySelector(".ygc-marks");
    if (!prog || !v || !isFinite(v.duration) || v.duration <= 0 || isAd() || state.settings.hidden) {
      if (marks) marks.style.display = "none";
      return;
    }
    if (!marks) {
      marks = document.createElement("div");
      marks.className = "ygc-marks";
      marks.style.cssText = "position:absolute;inset:0;pointer-events:none;";
      marks.innerHTML = '<div class="ygc-range"></div><div class="ygc-mark ygc-ma"></div><div class="ygc-mark ygc-mb"></div>';
      prog.appendChild(marks);
    }
    marks.style.display = "";
    const pct = (t) => (t / v.duration) * 100 + "%";
    const ma = marks.querySelector(".ygc-ma"), mb = marks.querySelector(".ygc-mb"), rg = marks.querySelector(".ygc-range");
    ma.style.display = state.a != null ? "" : "none";
    mb.style.display = state.b != null ? "" : "none";
    if (state.a != null) ma.style.left = pct(state.a);
    if (state.b != null) mb.style.left = pct(state.b);
    rg.style.display = loopValid() ? "" : "none";
    if (loopValid()) {
      rg.style.left = pct(state.a);
      rg.style.width = pct(state.b - state.a);
    }
  }

  // ---------- video wiring ----------
  const wired = new WeakSet();
  function wireVideo(v) {
    if (!v || wired.has(v)) return;
    wired.add(v);
    v.addEventListener("timeupdate", checkLoop); // backup for when the tab isn't visible
    v.addEventListener("ended", () => {
      if (state.looping && loopValid() && state.b >= v.duration - 0.5) {
        wrap(v);
        if (!state.waiting) v.play();
      }
    });
    v.addEventListener("loadedmetadata", () => {
      enforceSpeedUntil = Date.now() + 2500;
      tellYouTube();
      applySpeed();
    });
    v.addEventListener("play", () => {
      applySpeed();
      render();
    });
    v.addEventListener("pause", render);
    // when the loop has jumped back to A and the video plays again, restart the metronome on beat 1
    const metroRestart = () => {
      if (metro.restartPending && !state.waiting && !v.paused) {
        metro.restartPending = false;
        restartMetro();
      }
    };
    v.addEventListener("seeked", metroRestart);
    v.addEventListener("playing", metroRestart);
  }

  async function onVideoChange(id) {
    nameEdited = false;
    stopDetect();
    state.videoId = id;
    state.looping = false;
    state.loopCount = 0;
    cancelWait();
    state.a = state.b = null;
    state.loopId = null;
    state.saved = [];
    if (id) {
      const data = (await store.get("video:" + id)) || {};
      if (state.videoId !== id) return; // navigated again meanwhile
      state.saved = data.saved || [];
      state.a = data.last?.a ?? null;
      state.b = data.last?.b ?? null;
      state.speed = data.last?.speed ?? 1;
      state.loopId = data.loopId && curLoops().some((l) => l.id === data.loopId) ? data.loopId : null;
      enforceSpeedUntil = Date.now() + 2500;
      tellYouTube();
      applySpeed();
    }
    render();
    if (id) applyPendingFor(id);
  }

  // ---------- clean up when the extension is removed / disabled / reloaded ----------
  let mainTimer = null;
  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }
  function teardown() {
    if (dead) return;
    dead = true;
    clearInterval(mainTimer);
    cancelWait();
    try {
      metro.on = false;
      clearInterval(metro.timer);
      if (metro.ctx) metro.ctx.close();
    } catch (e) {}
    const v = getVideo();
    if (v && !state.settings.hidden && Math.abs(v.playbackRate - 1) > 0.001) v.playbackRate = 1;
    window.postMessage({ source: "ygc2", type: "force-rate", rate: 0 }, "*");
    window.postMessage({ source: "ygc2", type: "teardown" }, "*");
    if (mainVideo) mainVideo.removeAttribute("data-ygc-main");
    host.remove();
    pageStyle.remove();
    document.querySelectorAll(".ygc-marks, .ygc-toast").forEach((el) => el.remove());
    if (window.__ygcInstance === me) window.__ygcInstance = null;
  }

  async function init() {
    const s = await store.get("settings");
    if (s) state.settings = { ...state.settings, ...s, metronome: { ...state.settings.metronome, ...(s.metronome || {}) }, trainer: { ...state.settings.trainer, ...(s.trainer || {}) } };
    if (!state.settings.themeChosen) state.settings.theme = "dark"; // Night by default until you pick a theme
    state.settings.hidden = true; // stays idle on every page until you click the toolbar icon
    if (openRequested) {
      state.settings.hidden = false;
      state.settings.collapsed = false;
    }
    delete state.settings.metro;
    await loadLibrary();
    document.documentElement.appendChild(host);
    render();
    mainTimer = setInterval(() => {
      if (!extensionAlive()) return teardown();
      wireVideo(getVideo());
      renderMarks();
      if (!isAd()) applySpeed(); // catch-all: keep our speed (also restores it after ads)
      renderStatus();
      updateNow();
      renderSaveRow(); // YouTube updates the page title a moment after switching videos
      window.postMessage({ source: "ygc2", type: "ping" }, "*");
      const id = getVideoId();
      if (id !== state.videoId) onVideoChange(id);
    }, 500);
    requestAnimationFrame(rafLoop);
  }

  init();
})();
