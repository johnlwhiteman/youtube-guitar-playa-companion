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
      metroHidden: true, // the metronome is hidden until you show it (button at the top)
      trainer: { on: false, step: 5, limit: 100, start: null }, // change speed each loop
      theme: "system", // system | light | dark  (follows your computer by default)
      metronome: { bpm: 120, beats: 4, accent: true, vol: 70, cat: true },
      hidden: false,
      pos: null, // {left, top}
    },
  };
  const DEFAULT_SETTINGS = JSON.parse(JSON.stringify(state.settings)); // for Reset to Default
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
    remove: (k) => {
      try {
        return chrome.storage.local.remove(k);
      } catch (e) {}
    },
  };
  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      store.set("settings", state.settings);
      // where you were in a video (A, B, speed) is only kept once the video is saved
      if (state.videoId && typeof videoEntry === "function" && videoEntry()) {
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
    if (state.a == null && $("aIn").placeholder !== now) $("aIn").placeholder = now;
    if (state.b == null && $("bIn").placeholder !== now) $("bIn").placeholder = now;
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
  // Notes toolbar icons: one family of thin line icons on a 24×24 grid (same style as Lutefisk Book Editor).
  const NOTE_ICONS = {
    spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z",
    mic: "M9.5 2.5h5v11a2.5 2.5 0 0 1-5 0zM5.2 11.2a6.8 6.8 0 0 0 13.6 0M12 18v4M8.6 22h6.8",
    key: "M2.6 12a4.6 4.6 0 1 0 9.2 0a4.6 4.6 0 1 0-9.2 0M11.8 12H22M18.6 12v4M21.8 12v3.2",
    undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
    caseUp: "M2 18L6.5 6 11 18M3.7 14h5.6M13 18l4.5-12L22 18M14.7 14h5.6",
    caseLow: "M7.5 11.2a3.4 3.4 0 1 0 0 6.8a3.4 3.4 0 0 0 0-6.8M10.9 10.5V18M17.5 11.2a3.4 3.4 0 1 0 0 6.8a3.4 3.4 0 0 0 0-6.8M20.9 10.5V18",
    redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
    heading: "M6 4v16M18 4v16M6 12h12",
    paragraph: "M4 6h16M4 10h16M4 14h16M4 18h10",
    h1: "M4 6v12M12 6v12M4 12h8M16 9l3-2v11",
    h2: "M4 6v12M12 6v12M4 12h8M15.5 9.5a2.4 2.4 0 0 1 4.6.8c0 2.2-4.6 4.2-4.6 7.7h4.8",
    h3: "M4 6v12M12 6v12M4 12h8M15.5 8h4.5l-2.6 3.6a2.9 2.9 0 1 1-2.4 4.8",
    quote: "M7 7h4v4H8c0 2 1 3 3 3v2c-3 0-5-2-5-5V7zM14 7h4v4h-3c0 2 1 3 3 3v2c-3 0-5-2-5-5V7z",
    bold: "M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z",
    italic: "M10 5h8M6 19h8M14 5l-4 14",
    textStyle: "M5 7V5h14v2M12 5v14M9 19h6",
    strike: "M5 12h14M16 7.5C15.4 6 13.9 5 12 5c-2.5 0-4 1.3-4 3 0 3.5 8 2.5 8 7 0 1.9-1.8 4-4.5 4-2 0-3.6-1-4.3-2.5",
    highlighter: "M14.5 4.5l5 5-8 8H8.5v-3zM8.5 14.5l-3 3v1.5h4l2-2M13 6l5 5",
    code: "M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16",
    ul: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
    ol: "M10 6h10M10 12h10M10 18h10M4 4.5l1.5-.5v4M3.5 8.5h3M3.7 11.5a1.4 1.4 0 0 1 2.6.7c0 1.3-2.8 2.3-2.8 3.3h3",
    task: "M3.5 4.5h5v5h-5zM3.5 14.5h5v5h-5zM5 7l1 1 2-2.5M12 7h8M12 17h8",
    plus: "M12 5v14M5 12h14",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    table: "M3 5h18v14H3zM3 10h18M3 15h18M9 5v14M15 5v14",
    codeBlock: "M4 4h16v16H4zM9.5 9.5L7 12l2.5 2.5M14.5 9.5L17 12l-2.5 2.5",
    hline: "M3 12h18M3 9.5v5M21 9.5v5",
    pencil: "M4 20l1.2-4.2L16 5l3 3L8.2 18.8zM14 7l3 3M4 20l4-1",
    quill: "M20.5 3.5c-7 .5-12.5 5-14 12l-1 3 3-1c7-1.5 11.5-7 12-14zM6.5 17.5l7-7M3 21l2.5-2.5",
    pen: "M14.5 3.5l6 6-8.5 8.5-5 1 1-5zM12.5 5.5l6 6M3 21l4-4",
    marker: "M8 15l-4 4.5h6l1.5-1.5M7 14.5l7.5-10 5 4-7.5 10zM7 14.5l5 3.5",
    smear: "M5 19c2-5 4-7 7-8s5-3 6-6M8 20c1-3 3-5 6-6M4 15c1-2 2-3 4-4",
    chalk: "M4 17.5l11-11 2.5 2.5-11 11H4zM15 6.5l2-2 2.5 2.5-2 2M7 20h13",
    eraser: "M15.5 4l5 5-9.5 9.5H6.5l-3-3zM8.5 10.5l5 5M11 18.5h9",
    fontColor: "M6 16L12 3l6 13M8.3 11h7.4M4 20.5h16",
    image: "M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01",
    sup: "M4 7l8 10M12 7L4 17M16 4.5a1.8 1.8 0 1 1 3.4 .8L16 9h4",
    sub: "M4 7l8 10M12 7L4 17M16 14.5a1.8 1.8 0 1 1 3.4 .8L16 19h4",
    chords: "M6 3h12M6 3v18M10 3v18M14 3v18M18 3v18M6 8h12M6 13h12M6 18h12M10 10.5h.01M14 15.5h.01M18 10.5h.01",
    draw: "M3 17c3-6 6 2 9-3s4-7 6-5-2 7 2 7 2-2 3-3M14.5 3.5l3 3",
    loop: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
    upload: "M12 21V9M7 14l5-5 5 5M5 9V3h14v6",
    clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2",
    wrap: "M4 6h16M4 12h13a3 3 0 0 1 0 6h-4M15 16l-2 2 2 2M4 18h5",
    pen: "M4 20l4-1 11-11a2.1 2.1 0 0 0-3-3L5 16l-1 4zM14 7l3 3",
    split: "M4 5h16v14H4zM12 5v14",
    eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    download: "M12 3v12M7 10l5 5 5-5M5 15v6h14v-6",
    chevron: "M6 9l6 6 6-6",
    scales: "M3 6h18M3 10h18M3 14h18M3 18h18M7 4v16M12 4v16M17 4v16M9.5 8h.01M14.5 12h.01M9.5 16h.01",
    song: "M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
    chord: "M5 4h14M5 4v16M9.7 4v16M14.3 4v16M19 4v16M5 9h14M5 14h14M5 19h14M9.7 11.5h.01M14.3 16.5h.01M19 11.5h.01",
  };
  const ic = (name, size = 16) =>
    `<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${NOTE_ICONS[name] || ""}"/></svg>`;

  // fonts for the editor page; the fixed-width ones keep chords lined up over the words
  const EDITOR_FONTS = [
    ["robotomono", "Roboto Mono", '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'],
    ["mono", "System Mono", 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'],
    ["courier", "Courier", '"Courier New", Courier, "Liberation Mono", monospace'],
    ["consolas", "Consolas", 'Consolas, "Lucida Console", Monaco, "DejaVu Sans Mono", monospace'],
    ["sans", "Sans", "Roboto, Arial, Helvetica, sans-serif"],
    ["serif", "Serif", 'Georgia, "Times New Roman", Times, serif'],
    ["hand", "Handwriting", '"Comic Sans MS", "Comic Neue", "Segoe Print", "Bradley Hand", cursive'],
  ];
  const fontStack = (k) => (EDITOR_FONTS.find((f) => f[0] === k) || EDITOR_FONTS[0])[2];
  // the page's own font and size (words); chord lines are one px bigger
  const pageFontKey = () => (EDITOR_FONTS.some((f) => f[0] === state.settings.pageFont) ? state.settings.pageFont : "robotomono");
  const pageSize = () => clamp(+state.settings.pageSize || 12, 9, 40);
  const isFixedFont = (k) => EDITOR_FONTS.findIndex((f) => f[0] === k) < 4;
  const host = document.createElement("div");
  host.id = "yt-guitar-companion-host";
  // upper right, beside the video (placed exactly by placePanel; no transform: it would move the pop-ups inside the panel)
  host.style.cssText = "position:fixed;z-index:2147483000;top:72px;right:16px;";
  const root = host.attachShadow({ mode: "open" });
  // Stop YouTube's keyboard shortcuts from firing while typing in our inputs
  ["keydown", "keyup", "keypress"].forEach((ev) => host.addEventListener(ev, (e) => e.stopPropagation()));

  root.innerHTML = `
  <style>
    :host { all: initial;
      --bg:#181818; --head:#222; --text:#eee; --strong:#fff; --muted:#a8a8a8; --btn:#2c2c2c; --btn-h:#3a3a3a;
      --hbtn:#2f2f2f; --hbtn-b:#4a4a4a; --border:#3a3a3a; --line:#2c2c2c; --input:#0f0f0f; --accent:#3ea6ff; --accent-text:#0f0f0f; --note:#3ea6ff; --note-text:#0f0f0f; --on:#2ba640; --on-text:#fff;
      --item:#222; --item-h:#2c2c2c; --shadow:rgba(0,0,0,.5); --ok:#7bd88f; --bad:#ff6b6b; --dot:#3a3a3a;
      --info-bg:#1d3047; --info-text:#e8f2ff; --info-border:#3a6ea5; --warn-bg:#5c1a1a; --warn-text:#fff; --backdrop:rgba(0,0,0,.55);
      --green:#2ba640; --red:#d93025; }
    :host([data-theme="light"]) {
      --bg:#ffffff; --head:#f1f3f4; --text:#1f1f1f; --strong:#000; --muted:#5f6368; --btn:#f1f3f4; --btn-h:#e2e5e8;
      --hbtn:#ffffff; --hbtn-b:#c6cacf; --border:#c6cacf; --line:#e3e5e8; --input:#ffffff; --accent:#065fd4; --accent-text:#fff; --note:#065fd4; --note-text:#fff; --on:#2ba640; --on-text:#fff;
      --item:#f6f7f8; --item-h:#eceef1; --shadow:rgba(0,0,0,.2); --ok:#137333; --bad:#c5221f; --dot:#d2d5d9;
      --info-bg:#e8f0fe; --info-text:#0b3d91; --info-border:#a8c7fa; --warn-bg:#fce8e6; --warn-text:#5c1a1a; --backdrop:rgba(0,0,0,.35); }
    * { box-sizing: border-box; font-family: Roboto, Arial, sans-serif; }
    .panel { width: 348px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 12px;
      box-shadow: 0 8px 30px var(--shadow); font-size: 13px; overflow: hidden; position: relative; }
    .head { display:flex; align-items:center; gap:3px; padding:8px 8px 8px 10px; background:var(--head); cursor:move; user-select:none; }
    .head .title { flex:1; font-weight:600; font-size:12px; line-height:1.15; min-width:0; color:var(--strong); }
    .head .logo { width:36px; height:36px; display:block; flex:none; margin:-4px -2px -4px -4px; }
    .metro-sec[hidden] { display:none !important; }
    .hbtn { position:relative; width:23px; height:24px; padding:0; display:inline-flex; align-items:center; justify-content:center; flex:none;
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
    .savebtn.is-saved, .savebtn.is-saved:disabled, .savebtn.is-saved:disabled:hover { background:var(--on); border-color:var(--on); color:var(--on-text); opacity:1; }
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
    button.on { background:var(--on); border-color:var(--on); color:var(--on-text); font-weight:600; }
    .now { display:flex; align-items:baseline; gap:4px; min-width:0; }
    .now #nowTime, .now .nowbtns { flex:none; }
    .now #durTime { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; flex:0 1 auto; }
    #nowTime { font-size:15px; font-weight:700; font-variant-numeric:tabular-nums; color:var(--strong); }
    .now .vidsave { margin-left:auto; align-self:center; display:inline-flex; align-items:center; gap:4px; padding:2px 8px; font-size:11px; font-weight:600; }
    .now .vidsave .hico { stroke-width:1.6; }
    .now .vidsave.is-saved, .now .vidsave.is-saved:disabled, .now .vidsave.is-saved:disabled:hover { background:transparent; border-color:transparent; color:var(--green); opacity:1; cursor:default; }
    #durTime { font-variant-numeric:tabular-nums; white-space:nowrap; }
    .now .vidsave { padding:2px 6px !important; }
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
    input[type=text].speedin { width:62px; font-size:14.5px; font-weight:700; text-align:center; color:var(--strong); padding:3px 4px; }
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
    #libModal .hico, #libModal .ico { stroke-width:1.25; }
    #libModal .acts .hico { width:14px; height:14px; }
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
    .timerow #nowTime { font-size:15px; }
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
    .metro-sec summary { cursor:pointer; user-select:none; list-style:none; display:flex; align-items:center; gap:8px; font-weight:600; color:var(--strong);
      margin:-4px -6px; padding:4px 6px; border-radius:8px; transition:background .15s; }
    .metro-sec summary:hover { background:var(--btn-h); }
    .metro-sec summary::-webkit-details-marker { display:none; }
    /* the show/hide arrow: a clear button-like chevron that turns when the metronome opens */
    .metro-sec summary .mchev { flex:none; display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%;
      background:var(--accent); color:var(--accent-text); transition:transform .18s ease, filter .15s; }
    .metro-sec summary:hover .mchev { filter:brightness(1.12); }
    .metro-sec summary .mchev .hico { stroke-width:2.2; }
    .metro-sec[open] summary .mchev { transform:rotate(90deg); }
    .metro-sec summary .mhint { font-size:11px; font-weight:500; color:var(--muted); }
    .metro-sec summary:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
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
    /* the video's own save button: a disk until it's saved, then a bin to delete it */
    .vidsave { display:inline-flex; align-items:center; justify-content:center; gap:4px; height:28px; min-width:30px; padding:0 6px; flex:none; }
    .vidsave .hico { stroke-width:1.5; }
    .vidsave.unsaved { color:var(--accent); border-color:var(--accent); }
    .vidsave.unsaved:hover { background:var(--accent); color:var(--accent-text); }
    .vidsave.saved:hover { color:var(--red); border-color:var(--red); }
    .vidsave.confirm, .vidsave.confirm:hover { background:var(--red); border-color:var(--red); color:#fff; }
    .vidsave.confirm { font-weight:600; font-size:12px; }
    #aIn::placeholder, #bIn::placeholder { color:var(--muted); }
    .loopbar .lselbtn { width:0; min-width:0; display:flex; align-items:center; gap:4px; height:28px; padding:0 6px 0 8px; background:var(--input);
      border:1px solid var(--border); border-radius:6px; text-align:left; font-size:12.5px; color:var(--text); }
    .loopbar .lselbtn:disabled { opacity:.5; }
    .lselbtn.open { border-color:var(--accent); }
    .lselbtn .lsellab { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .lpop { position:fixed; z-index:20; min-width:250px; max-width:330px; max-height:60vh; overflow:auto; padding:5px; border-radius:10px; background:var(--bg);
      border:1px solid var(--border); box-shadow:0 10px 30px var(--shadow); color:var(--text); font-size:12.5px; }
    .lp-row { display:flex; align-items:center; gap:6px; padding:3px 4px 3px 6px; border-radius:6px; cursor:pointer; }
    .lp-row:hover { background:var(--btn-h); }
    .lp-row .lp-del.lp-ok { color:var(--accent); border-color:var(--accent); }
    .lp-row .lp-del.lp-ok:hover { background:var(--accent); border-color:var(--accent); color:var(--accent-text); }
    .lp-row.sel { background:var(--info-bg); color:var(--info-text); }
    .lp-vid { font-weight:600; color:var(--strong); padding:6px; }
    .lp-name { flex:1; min-width:0; }
    .lp-name b { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
    .lp-name small { color:var(--muted); font-size:11px; }
    .lp-grip { cursor:grab; color:var(--muted); display:flex; padding:2px 0; }
    .lp-row.dragging { opacity:.35; }
    .lp-del { width:26px; height:24px; padding:0; display:inline-flex; align-items:center; justify-content:center; flex:none; }
    .lp-del:hover, .lp-del.confirm { background:var(--red); border-color:var(--red); color:#fff; }
    .lp-del.lp-edit:hover { background:var(--btn-h); border-color:var(--border); color:var(--text); }
    .lp-del.confirm { width:auto; padding:0 8px; font-weight:600; }
    .lp-sep { border-top:1px solid var(--line); margin:4px 2px; }
    .lp-ren { flex:1; min-width:0; background:var(--input); color:var(--text); border:1px solid var(--accent); border-radius:5px; padding:3px 6px; font:inherit; }
    .lp-save { display:flex; align-items:center; justify-content:center; gap:5px; width:100%; margin-top:4px; height:28px; }
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
    .libsort { flex:none; height:28px; }
    .insgrp { position:relative; display:inline-flex; }
    .mmenu { display:flex; flex-direction:column; gap:2px; padding:4px; min-width:130px; }
    .mmenu button { text-align:left; border:none; background:transparent; padding:5px 10px; white-space:nowrap; }
    .mmenu button:hover, .mmenu button:focus-visible { background:var(--btn-h); }
    .chtext { margin:0; padding:6px 8px 4px; font:12.5px/1.25 var(--mono); color:var(--text); white-space:pre; }
    .sctab { overflow-x:auto; }
    .nk-name.tune { cursor:pointer; }
    .nk-name.tune:hover { fill:var(--accent); }
    .tunepop { display:grid; grid-template-columns:repeat(4, auto); gap:2px; padding:5px; }
    .tunepop button { min-width:44px; height:24px; padding:0 6px; font:600 12px var(--mono); border-radius:5px; }
    .tunepop button.on { border-color:var(--accent); color:var(--accent); }
    #scInsert .caret { font-size:10px; margin-left:2px; opacity:.85; }
    .insmenu { position:absolute; right:0; bottom:calc(100% + 6px); display:flex; flex-direction:column; min-width:100%; padding:4px; gap:2px; background:var(--bg); border:1px solid var(--border); border-radius:8px; box-shadow:0 6px 20px rgba(0,0,0,.35); z-index:5; }
    .insmenu[hidden] { display:none; }
    .insmenu button { text-align:left; border:none; background:transparent; padding:5px 10px; white-space:nowrap; }
    .insmenu button:hover, .insmenu button:focus-visible { background:var(--btn-h); }
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

    /* notes button (next to the time) */
    .now .nowbtns { margin-left:auto; align-self:center; display:inline-flex; gap:1px; }
    .now .nowbtns .vidsave { margin-left:0; }
    .novideo .novbtn { margin-top:8px; }
    .novideo .notesbtn { display:inline-flex; align-items:center; gap:4px; padding:3px 9px; font-size:11.5px; font-weight:600; }
    .now .notesbtn .ico { stroke-width:2; }
    .hbtn.vidsave.is-saved, .hbtn.vidsave.is-saved:disabled { color:var(--green); opacity:1; cursor:default; }
    .now .notesbtn.icononly { padding:2px 5px; }
    .now .notesbtn { position:relative; display:inline-flex; align-items:center; gap:2px; padding:2px 4px; font-size:10.5px; font-weight:600; }
    .now .notesbtn .hico { stroke-width:1.5; }
    .lib .acts .notesbtn { position:relative; }
    .now .notesbtn.open { border-color:var(--accent); color:var(--accent); }

    /* notes window: floats over the page so the video stays usable */
    :host { --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    .nwin { position:fixed; z-index:6; display:none; flex-direction:column; width:900px; height:540px; min-width:420px; min-height:280px;
      max-width:calc(100vw - 8px); max-height:calc(100vh - 8px); background:var(--bg); color:var(--text); border:1px solid var(--border);
      border-radius:12px; box-shadow:0 12px 40px var(--shadow); overflow:hidden; resize:both; font-size:13px; }
    .nwin.show { display:flex; }
    .nhead { display:flex; align-items:center; gap:8px; padding:8px 10px; background:var(--head); cursor:move; user-select:none; font-weight:600; color:var(--strong); }
    .ntitle { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .nstatus { font-weight:400; white-space:nowrap; }
    .ico { display:block; flex:none; fill:none; stroke:currentColor; stroke-width:1.65; stroke-linecap:round; stroke-linejoin:round; }
    .ntools { display:flex; flex-wrap:wrap; align-items:center; gap:2px; padding:5px 8px; border-bottom:1px solid var(--line); }
    .ntools .nb { width:30px; height:28px; padding:0; display:inline-flex; align-items:center; justify-content:center; gap:1px;
      border:0; border-radius:6px; background:none; color:var(--muted); }
    .ntools .nb:hover, .ntools .nb.open { background:var(--btn-h); color:var(--text); }
    .ntools .nb:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
    .ntools .nb.menu { width:auto; padding:0 4px 0 6px; }
    .ntools .nb.lbl { width:auto; padding:0 7px; font-size:12px; font-weight:600; }
    .ntools .nb.active { color:var(--accent); }
    .ntools .caret { display:inline-flex; opacity:.6; }
    .ntools .tsep { width:1px; height:18px; background:var(--line); margin:0 4px; }
    .ntools.mdtools { padding:3px 8px; }
    .ntools.mdtools .sctog { margin-right:6px; }
    .ntools .mdexp { height:26px; padding:0 8px; display:inline-flex; align-items:center; gap:4px; font-size:12px; font-weight:600; }
    .modal-foot .mdexp { display:inline-flex; align-items:center; gap:4px; }
    .ntools > button.tabtool { height:26px; min-width:28px; margin-left:4px; padding:0 6px; display:inline-flex; align-items:center; justify-content:center; gap:4px; font-size:12px; font-weight:600; }
    .nseg { display:inline-flex; gap:2px; padding:2px; margin:0 2px; border-radius:8px; background:var(--btn); }
    .ntools .nseg .nb { width:28px; height:24px; }
    .ntools .nseg .nb.active { background:var(--bg); color:var(--accent); box-shadow:0 1px 2px rgba(0,0,0,.25); }
    /* toolbar menus */
    .npop { position:fixed; z-index:20; min-width:210px; padding:5px; border-radius:10px; background:var(--bg); border:1px solid var(--border);
      box-shadow:0 10px 30px var(--shadow); }
    .npop button { display:flex; align-items:center; gap:8px; width:100%; height:28px; padding:0 9px; border:0; border-radius:5px;
      background:transparent; color:var(--text); font-size:13px; text-align:left; }
    .npop button .ico { color:var(--muted); }
    .npop button:hover, .npop button:focus-visible { background:var(--accent); color:var(--accent-text); outline:none; }
    .npop button:hover .ico, .npop button:focus-visible .ico, .npop button:hover .hint, .npop button:focus-visible .hint { color:inherit; }
    .npop .lab { flex:1; }
    .npop .hint { font-size:11.5px; color:var(--muted); font-family:var(--mono); }
    .npop .sep { border-top:1px solid var(--line); margin:5px 6px; }
    .expop { display:flex; flex-direction:column; gap:8px; padding:10px; min-width:220px; color:var(--text); }
    .expop .chk { display:flex; align-items:center; gap:6px; font-size:12.5px; color:var(--text); cursor:pointer; }
    .expop .exbtns { display:flex; gap:6px; }
    .lnpop { width:260px; }
    .lnpop .lbl { display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--muted); }
    .lnpop input { width:100%; }
    .expop .exbtns button { flex:1; height:28px; justify-content:center; border:1px solid var(--border); background:var(--btn); color:var(--text); }
    .npop .head { padding:4px 9px 3px; font-size:11px; font-weight:600; color:var(--muted); }
    .nbody { flex:1; min-height:0; display:flex; }
    .nbody .live { flex:1; width:auto; min-width:0; border:none; border-radius:0; padding:10px 12px; margin:0; outline:none; background:var(--input, transparent); color:var(--text);
      font:var(--edfs, 13px)/1.5 var(--edff, var(--mono)); tab-size:4; white-space:pre; overflow:auto; caret-color:var(--text); cursor:text; }
    .live * { font-family:inherit; }
    .live .mk { display:none; }
    .live .ln.chl { font-weight:700; font-size:var(--chfs, 14px); letter-spacing:var(--chls, 0px); }
    .live .chd { border-radius:3px; transition:background .15s; }
    .live .chd.hov { background:rgba(62,166,255,.22); }
    .live img.keysig { display:inline-block; height:calc(var(--edfs, 13px) * 3.4); width:auto; vertical-align:middle; margin-left:1.2em; pointer-events:auto; user-select:none; }
    :host([data-theme="dark"]) .live img.keysig { filter:invert(.9); }
    .chpop { position:fixed; z-index:2147483647; padding:8px 10px 6px; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:10px;
      box-shadow:0 6px 22px rgba(0,0,0,.35); pointer-events:none; opacity:0; transform:translateY(4px); transition:opacity .12s, transform .12s; text-align:center; }
    .chpop.show { opacity:1; transform:none; }
    .chpop svg { display:block; margin:0 auto; }
    .chpop .cp-fr { font:600 11px var(--mono); color:var(--muted); margin-top:2px; letter-spacing:.06em; }
    .live .ln.sec { color:var(--accent); font-weight:600; }
    .live .ln.h1, .live .ln.h2, .live .ln.h3 { font-family:Roboto, Arial, sans-serif; font-weight:700; color:var(--strong); }
    .live .ln.h1 { font-size:calc(var(--edfs, 13px) * 1.55); } .live .ln.h2 { font-size:calc(var(--edfs, 13px) * 1.3); } .live .ln.h3 { font-size:calc(var(--edfs, 13px) * 1.12); }
    .live .ln.q { color:var(--muted); border-left:3px solid var(--line); padding-left:8px; }
    .live .ln.hr { display:inline-block; width:100%; height:0; border-top:1px solid var(--line); vertical-align:middle; }
    .live .ln.fence, .live .ln.cb { color:var(--muted); }
    .live .bul { font-size:0; }
    .live .bul::after { font-size:var(--edfs, 13px); }
    .live .bul.dot::after { content:"• "; }
    .live .bul.box::after { content:"☐ "; }
    .live .bul.tick::after { content:"☑ "; }
    .live .ln.done { color:var(--muted); text-decoration:line-through; }
    .live strong { font-weight:700; } .live em { font-style:italic; }
    .live sup, .live sub { font-size:.72em; line-height:0; }
    .live mark, .swatch { color:#111; border-radius:2px; }
    .hl-yellow { background:#ffe36e; } .hl-green { background:#a8eea0; } .hl-blue { background:#a6d8ff; }
    .hl-pink { background:#ffb8dc; } .hl-orange { background:#ffc98a; } .hl-purple { background:#d6c2ff; }
    :host, :root { ${EDITOR_FONTS.map(([k, , f]) => `--ff-${k}: ${f};`).join(" ")} }
    .fc-red { color:#e53935; } .fc-blue { color:#1e88e5; } .fc-green { color:#2e9d44; } .fc-orange { color:#ef7d00; } .fc-purple { color:#9c3bc0; } .fc-gray { color:#8a8a8a; }
    .live.pc-red, .live.pc-red .ln { color:#e53935; } .live.pc-blue, .live.pc-blue .ln { color:#1e88e5; } .live.pc-green, .live.pc-green .ln { color:#2e9d44; }
    .live.pc-orange, .live.pc-orange .ln { color:#ef7d00; } .live.pc-purple, .live.pc-purple .ln { color:#9c3bc0; } .live.pc-gray, .live.pc-gray .ln { color:#8a8a8a; }
    .sw-fc-red { background:#e53935; } .sw-fc-blue { background:#1e88e5; } .sw-fc-green { background:#2e9d44; } .sw-fc-orange { background:#ef7d00; } .sw-fc-purple { background:#9c3bc0; } .sw-fc-gray { background:#8a8a8a; }
    .ntools .capsel { height:26px; font-size:12px; padding:0 4px; width:86px; }
    .ntools .secsel { height:26px; font-size:12px; padding:0 4px; width:92px; }
    .ntools .ffam, .ntools .fsize { height:26px; margin:0 2px; font-size:12px; padding:0 4px; }
    .ntools .ffam { width:122px; } .ntools .fsize { width:62px; }
    .npop .swatch { width:15px; height:15px; border-radius:4px; flex:none; box-shadow:inset 0 0 0 1px rgba(0,0,0,.15); }
    .edscroll { flex:1; min-width:0; position:relative; overflow:auto; background:var(--input, transparent); }
    .edscroll .live { min-height:100%; min-width:100%; width:max-content; overflow:visible !important; }
    .live .imgln { display:inline-block; }
    .live img.pimg { display:block; max-width:560px; height:auto; margin:4px 0; border-radius:6px; box-shadow:0 1px 3px rgba(0,0,0,.3); background:var(--btn); min-width:40px; min-height:30px; }
    .live img.pimg.sel { outline:2px solid var(--accent); outline-offset:2px; }
    .edink { position:absolute; left:0; top:0; pointer-events:none; overflow:visible; }
    .edscroll.drawing .edink { pointer-events:auto; cursor:crosshair; touch-action:none; }
    .edscroll.drawing.erasing .edink { cursor:cell; }
    .edink path:not(.nib) { fill:none; stroke-linecap:round; stroke-linejoin:round; }
    .drawbar { display:none; align-items:center; gap:4px; padding:4px 8px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
    .nwin.drawing .drawbar { display:flex; }
    .drawbar .dtool { width:30px; height:28px; padding:0; display:inline-flex; align-items:center; justify-content:center; background:transparent; border:1px solid transparent; color:var(--muted); }
    .drawbar .dtool:hover { background:var(--btn-h); color:var(--text); }
    .drawbar .dtool.on { background:var(--btn); border-color:var(--accent); color:var(--accent); box-shadow:inset 0 -3px 0 var(--dcol, transparent); }
    .drawbar .dcol { width:20px; height:20px; padding:0; border-radius:50%; border:2px solid transparent; min-width:0; }
    .drawbar .dcol { margin:0 1px; transition:transform .1s; }
    .drawbar .dcol.on { border-color:transparent; box-shadow:0 0 0 2px var(--bg), 0 0 0 4px var(--accent); transform:scale(1.18); }
    .drawbar .dwidth { height:26px; font-size:12px; padding:0 4px; }
    .drawbar .dsize { height:24px; min-width:26px; padding:0 6px; font-size:11px; font-weight:600; }
    .drawbar .dsize.on { border-color:var(--accent); color:var(--accent); background:var(--btn); }
    .live code { background:var(--btn); border-radius:3px; padding:0 2px; }
    .live a.lk, .live .url { color:var(--accent); text-decoration:underline; }
    .live .tm { color:var(--accent); }
    .edtools { row-gap:6px; }
    .edtools .sgrp button { height:24px; padding:0 8px; }
    .edtools .tabtool { margin-left:0; }
    .hico.mic { stroke-width:1.1; }
    .tabtool.busy { opacity:.55; cursor:progress; }
    .nbody .npreview { flex:1; min-width:0; overflow:auto; padding:10px 14px; border-left:1px solid var(--line); }
    .nbody[data-mode="write"] .npreview { display:none; }
    .nbody[data-mode="preview"] textarea { display:none; }
    .nbody[data-mode="preview"] .npreview { border-left:none; }

    /* rendered Markdown */
    .md { line-height:1.5; font-size:13.5px; overflow-wrap:anywhere; }
    .md > :first-child { margin-top:0; }
    .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { color:var(--strong); margin:14px 0 6px; line-height:1.25; }
    .md h1 { font-size:20px; border-bottom:1px solid var(--line); padding-bottom:4px; }
    .md h2 { font-size:17px; }
    .md h3 { font-size:15px; }
    .md h4, .md h5, .md h6 { font-size:13.5px; }
    .md p { margin:6px 0; }
    .md ul, .md ol { margin:6px 0; padding-left:22px; }
    .md ul { list-style:disc; }
    .md ol { list-style:decimal; }
    .md li { margin:2px 0; }
    .md ul.tasks { list-style:none; padding-left:4px; }
    .md li.task > input { margin:0 6px 0 0; vertical-align:-2px; accent-color:var(--accent); cursor:pointer; }
    .md li.task.done > span { color:var(--muted); text-decoration:line-through; }
    .md code, .md pre, .md pre code, .md kbd { font-family:var(--mono); }
    .md code { font-size:12px; background:var(--btn); border:1px solid var(--line); border-radius:4px; padding:0 4px; }
    .md pre { background:var(--input); border:1px solid var(--line); border-radius:8px; padding:8px 10px; overflow:auto; margin:8px 0; }
    .md pre code { background:none; border:none; padding:0; font-size:12.5px; }
    .md pre.tab { font-size:12.5px; line-height:1.35; color:var(--strong); white-space:pre; overflow-wrap:normal; }
    .md .tabblk { position:relative; margin:8px 0; }
    .npreview .tabblk:not(.noedit) { cursor:pointer; }
    .npreview .tabblk:not(.noedit):hover .staff { border-color:var(--accent); }
    .md .staff { overflow-x:auto; padding:6px 10px 8px; background:var(--input); border:1px solid var(--line); border-radius:8px; }
    .md .st-txt { font-size:12.5px; white-space:pre-wrap; margin:2px 0 6px; }
    .md .st-sys { display:flex; align-items:flex-start; }
    .md .st-sys + .st-sys { margin-top:8px; }
    .md .st-names { display:flex; flex-direction:column; padding-top:14px; margin-right:5px; }
    .md .st-names span { height:20px; line-height:20px; font:600 11px var(--mono); color:var(--muted); text-align:right; }
    .md .st-bars { display:flex; width:max-content; }
    .md .st-m { display:flex; flex-direction:column; }
    .md .st-num { height:14px; font-size:9.5px; line-height:14px; color:var(--muted); padding-left:4px; }
    .md .st-bar { display:grid; grid-auto-rows:20px; border-left:2px solid var(--muted); }
    .md .st-m:last-child .st-bar { border-right:2px solid var(--muted); }
    .md .st-bar span { min-width:28px; padding:0 3px; height:20px; line-height:20px; text-align:center; font:600 12px var(--mono); color:var(--strong); white-space:nowrap;
      background-image:linear-gradient(to bottom, transparent 9px, var(--muted) 9px, var(--muted) 10.5px, transparent 10.5px); }
    .md .st-bar span.f { background-image:linear-gradient(to right, transparent 5px, var(--input) 5px, var(--input) calc(100% - 5px), transparent calc(100% - 5px)),
      linear-gradient(to bottom, transparent 9px, var(--muted) 9px, var(--muted) 10.5px, transparent 10.5px); }
    .md blockquote { margin:8px 0; padding:2px 10px; border-left:3px solid var(--accent); color:var(--muted); }
    .md hr { border:none; border-top:1px solid var(--line); margin:12px 0; }
    .md a { color:var(--accent); }
    .md a.ts { display:inline-block; padding:0 7px; border-radius:10px; background:var(--info-bg); color:var(--info-text); border:1px solid var(--info-border);
      text-decoration:none; font-size:12px; line-height:18px; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .md a.ts:hover { border-color:var(--accent); }
    .md a.ts.loop { border-color:var(--green); }
    .md .tblwrap { overflow-x:auto; }
    .md table { border-collapse:collapse; margin:8px 0; font-size:12.5px; }
    .md th, .md td { border:1px solid var(--line); padding:4px 8px; vertical-align:top; }
    .md th { background:var(--head); color:var(--strong); }
    .md mark { background:#ffe066; color:#000; border-radius:2px; padding:0 2px; }

    /* scale library */
    .modal.scalemod { width:1000px; max-width:calc(100vw - 24px); max-height:92vh; }
    /* the list on the left can be hidden, which makes the window narrower */
    .modal.scalemod.noside { width:800px; }
    /* CAGED and the circle of fifths have no list and need less room */
    .modal.scalemod.narrow, .modal.scalemod.narrow.noside { width:760px; }
    .scalemod.noside .scside { display:none; }
    #scSideBtn.sbon { color:var(--accent); border-color:var(--accent); }
    #scSideBtn.nolist { visibility:hidden; }
    #scSideBtn { margin-left:6px; }
    .scalemod.noside #scSideBtn .scside-ar { transform:translateX(1.2px) scaleX(-1); transform-origin:3px 6px; }
    /* the fretboard fills the width, so its right edge lines up with the buttons above it and with Close below */
    .scneck > svg { width:100%; height:auto; min-width:560px; }
    /* the key signature beside the pattern rows */
    .scrows { display:flex; align-items:center; gap:12px; }
    .scrowsl { flex:none; min-width:0; display:flex; flex-direction:column; gap:6px; }
    .sckey { flex:none; display:flex; align-items:center; gap:8px; padding:2px 10px 2px 6px; border:none; border-radius:6px; background:#fff; color:#222; }
    .sckey:empty { display:none; }
    .sckey img { height:52px; width:auto; display:block; }

    .sckey .sk-t { display:flex; flex-direction:column; font-size:11.5px; line-height:1.35; white-space:nowrap; }
    .sckey .sk-t b { color:#111; font-size:12px; }
    .sckey .sk-t span { color:#666; }
    .staff .st-lab { font:600 11px Roboto, Arial, sans-serif; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; margin:6px 0 1px 2px; }
    .staff .st-lab:first-child { margin-top:0; }
    .scwrap { display:flex; min-height:0; flex:1; overflow:hidden; }
    .scside { width:200px; flex:none; display:flex; flex-direction:column; gap:6px; padding:10px; border-right:1px solid var(--line); min-height:0; }
    .scside input[type=search] { width:100%; background:var(--input); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:5px 8px; font-size:13px; }
    .scside input[type=search]:focus { outline:none; border-color:var(--accent); }
    .sclist { overflow:auto; min-height:0; flex:1; display:flex; flex-direction:column; gap:1px; }
    .sclist .head { padding:8px 6px 3px; font-size:11px; font-weight:600; color:var(--muted); }
    .sclist button { display:flex; flex-direction:column; align-items:flex-start; gap:1px; width:100%; padding:4px 8px; border:0; border-radius:6px; background:none; text-align:left; white-space:normal; }
    .sclist button:hover { background:var(--btn-h); }
    .sclist button.active { background:var(--accent); color:var(--accent-text); }
    .sclist button .f { font-size:10.5px; opacity:.7; font-family:var(--mono); }
    .sclist .none { color:var(--muted); font-size:12px; padding:6px; }
    .scmain { flex:1; min-width:0; overflow:auto; padding:8px 12px; display:flex; flex-direction:column; gap:6px; }
    .scmain > * { flex-shrink:0; } /* never squash the fretboard; scroll instead */
    .scbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
    .scbar label { display:inline-flex; align-items:center; gap:6px; }
    .sgrp { display:inline-flex; gap:2px; padding:2px; border-radius:8px; background:var(--btn); border:1px solid var(--border); }
    .sgrp:empty { display:none; }
    .trgrp { align-items:center; gap:1px; padding:1px; }
    .trgrp button.arr, .edtools .trgrp button.arr, .sctight .trgrp button.arr { display:inline-flex; align-items:center; justify-content:center; width:22px; min-width:22px; height:22px; padding:0; border:none; border-radius:4px; background:transparent; color:var(--muted); }
    .trgrp button.arr:hover { color:var(--strong); background:rgba(62,166,255,.14); }
    .trgrp button.arr:active { background:rgba(62,166,255,.26); }
    .trgrp button.arr .hico { stroke-width:1.6; }
    .edtools .trgrp button.arr { width:18px; min-width:18px; }
    .tebar .trgrp button { font-family:inherit; }
    .sclbl { font-size:10.5px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; margin-left:2px; }
    .sctight { gap:5px 6px; }
    .sctight .sgrp button { height:22px; min-width:24px; padding:0 7px; }
    .sctight select { height:24px; padding:0 4px; font-size:12px; }
    .sctog { font-size:12px; color:var(--muted); margin-right:6px; gap:4px; }
    .sctog input { margin:0; }
    .screset { height:24px; padding:0 9px; font-size:12px; }
    .scstr button { font-family:var(--mono); font-weight:600; min-width:28px; }
    .scstr button:not(.active) { text-decoration:line-through; opacity:.6; }
    .nk-str.off { opacity:.25; }
    .nk-name.off { opacity:.35; }
    .sgrp select.sgsel { height:24px; border:0; border-radius:6px; background:none; color:var(--muted); font-size:12px; padding:0 4px; cursor:pointer; }
    .sgrp select.sgsel:hover { color:var(--text); background:var(--btn-h); }
    .sgrp select.sgsel.active { background:var(--bg); color:var(--accent); box-shadow:0 1px 2px rgba(0,0,0,.25); font-weight:600; }
    .sgrp button { border:0; background:none; height:24px; min-width:26px; padding:0 9px; border-radius:6px; color:var(--muted); font-size:12px; }
    .sgrp button:hover { color:var(--text); background:var(--btn-h); }
    .sgrp button.active { background:var(--bg); color:var(--accent); box-shadow:0 1px 2px rgba(0,0,0,.25); font-weight:600; }
    .sctitle { display:flex; align-items:center; flex-wrap:wrap; gap:4px 10px; font-size:16px; font-weight:700; color:var(--strong); }
    .scnotes { display:inline-flex; gap:4px; flex-wrap:wrap; }
    .scnotes span { font-size:12.5px; font-weight:600; padding:1px 7px; border-radius:10px; background:var(--btn); color:var(--text); border:1px solid var(--border); }
    .scnotes span.r { background:#ef5a4c; border-color:#ef5a4c; color:#fff; }
    .scformula { font:400 11.5px var(--mono); color:var(--muted); white-space:pre; }
    .scneck { overflow-x:auto; padding:4px 0 2px; }
    .neck { display:block; }
    .nk-board { fill:var(--item); }
    .nk-fret { stroke:var(--muted); stroke-width:1.2; opacity:.55; }
    .nk-nut { fill:var(--text); opacity:.85; }
    .nk-shade { fill:var(--bg); opacity:.55; }
    .nk-capo { fill:#8a6a4a; stroke:#5a4330; stroke-width:1; opacity:.9; }
    .nk-capon { fill:#c79a6a; }
    .nk-str { stroke:var(--muted); }
    .nk-inlay { fill:var(--border); }
    .nk-name, .nk-num { fill:var(--muted); font:600 11px var(--mono); text-anchor:middle; }
    .nk-note circle { fill:var(--note); stroke:var(--bg); stroke-width:1.5; }
    .nk-note text { fill:var(--note-text); font:700 9.5px Roboto, Arial, sans-serif; text-anchor:middle; }
    .nk-note.root circle { fill:#ef5a4c; }
    .nk-note.root text { fill:#fff; }
    .nk-note.ghost circle { fill:var(--bg); stroke:var(--muted); stroke-width:1; }
    .nk-note.ghost text { fill:var(--muted); font-weight:600; }
    .nk-note.ghost.root circle { stroke:#ef5a4c; }
    .nk-note.ghost.root text { fill:#ef5a4c; }
    .sctab { min-height:40px; }
    .scpane:not(.show) { display:none !important; }
    .modal-head .sctabs { margin-left:10px; font-weight:400; }
    .cfpane { display:flex; gap:18px; padding:12px 16px; overflow:auto; flex:1; min-height:0; }
    .cfleft { width:380px; flex:none; }
    .cfhint { margin-top:6px; line-height:1.45; }
    .cf-seg { fill:var(--item); stroke:var(--bg); stroke-width:2; cursor:pointer; }
    .cf-seg:hover { fill:var(--btn-h); }
    .cf-seg.near { fill:var(--info-bg); }
    .cf-seg.sel { fill:var(--accent); }
    .cf-maj { fill:var(--strong); font:700 15px Roboto, Arial, sans-serif; text-anchor:middle; pointer-events:none; }
    .cf-min { fill:var(--text); font:600 12px Roboto, Arial, sans-serif; text-anchor:middle; pointer-events:none; }
    .cf-sig { fill:var(--muted); font:600 9.5px Roboto, Arial, sans-serif; text-anchor:middle; pointer-events:none; }
    .cf-on { fill:var(--accent-text); }
    .cf-mid { fill:var(--bg); stroke:var(--border); }
    .cf-t1 { fill:var(--strong); font:700 16px Roboto, Arial, sans-serif; text-anchor:middle; }
    .cf-t2 { fill:var(--muted); font:600 12px Roboto, Arial, sans-serif; text-anchor:middle; }
    .cfinfo { flex:1; min-width:0; display:flex; flex-direction:column; gap:10px; }
    .cfinfo h3 { margin:0; font-size:19px; color:var(--strong); }
    .cfinfo .row2 { line-height:1.55; }
    .cfinfo .lbl2 { color:var(--muted); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; margin-bottom:3px; }
    .cfinfo a.k { color:var(--accent); cursor:pointer; text-decoration:none; font-weight:600; }
    .cfinfo a.k:hover { text-decoration:underline; }
    .cftable { border-collapse:collapse; font-size:13px; }
    .cftable td { border:1px solid var(--line); padding:4px 10px; text-align:center; }
    .cftable tr:first-child td { color:var(--muted); font:600 12px var(--mono); background:var(--head); }
    .cftable tr:last-child td { font-weight:700; color:var(--strong); }
    .cfprog { margin:0; padding-left:18px; line-height:1.7; }
    .cfprog .r { font:12px var(--mono); color:var(--muted); }
    .cfbtns { display:flex; gap:6px; flex-wrap:wrap; }
    .scfilter { display:flex; } .scfilter button { flex:1; height:24px; font-size:11.5px; padding:0 4px; }
    .newbtn { width:100%; height:28px; font-size:12px; font-weight:600; }
    .sclist button .sced { position:absolute; right:6px; top:50%; transform:translateY(-50%); opacity:.6; font-size:12px; padding:0 4px; }
    .sclist button { position:relative; }
    .chmain { display:flex; flex-direction:column; gap:10px; padding:10px 14px; overflow:auto; }
    .chhead { display:flex; flex-direction:column; gap:3px; } .chhead b { font-size:16px; color:var(--strong); } .chhead span { font-size:12px; }
    .chgrid { display:flex; flex-wrap:wrap; gap:8px; align-content:flex-start; }
    .chcard { display:flex; flex-direction:column; align-items:center; padding:6px 4px 4px; border-radius:8px; border:2px solid transparent; background:var(--item, var(--btn)); height:auto; }
    .chcard:hover { border-color:var(--border); }
    .chcard.on { border-color:var(--accent); background:var(--item, var(--btn)); color:inherit; }
    .chcard { position:relative; cursor:pointer; }
    .chcard .chlab { font-size:10.5px; color:var(--muted); min-height:13px; }
    .chcard .chpen { position:absolute; bottom:3px; right:3px; width:22px; height:22px; padding:0; display:inline-flex; align-items:center; justify-content:center; border-radius:6px; background:var(--btn); border:1px solid var(--border); color:var(--muted); }
    .chcard .chpen:hover { color:var(--text); background:var(--btn-h); }
    .chacts { display:flex; gap:6px; flex-wrap:wrap; }
    .modal.semod { width:min(1000px, calc(100vw - 40px)); }
    .serow { display:flex; align-items:flex-end; gap:10px; }
    .serow label { flex:0 1 320px; }
    .sefret .sn circle { fill:transparent; stroke:var(--muted); stroke-width:1.2; cursor:pointer; }
    .sefret .sn text { fill:var(--muted); font-weight:500; }
    .sefret .sn.on circle { fill:var(--note, var(--accent)); stroke:none; }
    .sefret .sn.on text { fill:var(--note-text, #fff); font-weight:700; }
    .sefret .sn.on.root circle { fill:#ef5a4c; }
    .sefret .sn:hover circle { stroke:var(--text); stroke-width:1.6; }
    .sefret .sname { cursor:pointer; }
    .sefret .sname rect { fill:var(--btn); stroke:var(--border); }
    .sefret .sname:hover rect { fill:var(--btn-h); }
    .sefret .sname text { fill:var(--text); font-size:11px; }
    .sefret { overflow-x:auto; }
    .sefret svg { display:block; }
    .sefret .hit { fill:transparent; cursor:pointer; }
    .sefret .hit:hover { fill:var(--btn-h); }
    .sefret .str { stroke:var(--muted); stroke-width:1; }
    .sefret .fr { stroke:var(--line); stroke-width:1.5; }
    .sefret .nut { fill:var(--text); }
    .sefret .dot { fill:var(--note, var(--accent)); }
    .sefret .dot.root { fill:#ef5a4c; }
    .sefret text { font:600 9px Roboto, Arial, sans-serif; text-anchor:middle; pointer-events:none; }
    .sefret .dt { fill:var(--note-text, #fff); }
    .sefret .fn { fill:var(--muted); font-weight:400; }
    .sebody { display:flex; flex-direction:column; gap:10px; }
    .sebody label { display:flex; flex-direction:column; gap:4px; font-size:11px; } .sebody input { width:100%; }
    .selbl { font-size:11px; }
    .sesteps { display:grid; grid-template-columns:repeat(6, 1fr); gap:6px; }
    .sestep { height:34px; font-size:14px; font-weight:600; }
    .sestep.on { background:var(--accent); color:var(--accent-text); border-color:var(--accent); }
    .sepreview { font-size:13px; font-family:var(--mono); color:var(--strong); }
    button.danger { color:var(--red); }
    .cgpane { flex-direction:column; gap:8px; padding:10px 14px; overflow:auto; flex:1; min-height:0; }
    .cgpane.show { display:flex; }
    .cgboxes { display:flex; gap:8px; flex-wrap:wrap; }
    .cgbox { display:flex; flex-direction:column; align-items:center; gap:2px; padding:6px 8px 4px; border:1px solid var(--border); border-radius:10px; background:var(--item); color:var(--text); }
    .cgbox:hover { background:var(--btn-h); }
    .cgbox.active { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) inset; }
    .cgbox b { font-size:13px; color:var(--strong); }
    .cgbox small { font-size:11px; color:var(--muted); }
    .cb-line { stroke:var(--muted); stroke-width:1; }
    .cb-nut { fill:var(--text); }
    .cb-dot { fill:var(--note); }
    .cb-dot.root { fill:#ef5a4c; }
    .cb-mark, .cb-fr { fill:var(--muted); font:600 10px Roboto, Arial, sans-serif; text-anchor:middle; }
    .cginfo { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .cgabout { line-height:1.45; }

    /* chord sheets */
    .modal-back.top3 { z-index:13; }
    .modal.lymod { width:380px; }
    .modal.tunermod { width:500px; }
    #tuTuning { max-width:165px; } #tuCount, #tuA4 { max-width:96px; }
    .tubar { display:flex; align-items:center; gap:6px; padding:8px 12px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
    .tumode { margin:10px auto 0; }
    .tumode button { display:inline-flex; align-items:center; gap:5px; padding:0 12px; }
    .tudisp { display:flex; flex-direction:column; align-items:center; padding:6px 12px 0; }
    .tumeter { display:block; }
    .tumeter .tk { stroke:var(--muted); stroke-width:1; }
    .tumeter .tk.big { stroke-width:1.6; }
    .tumeter .arc { fill:none; stroke:var(--line); stroke-width:6; stroke-linecap:round; }
    .tumeter .ok { fill:none; stroke:#3fb950; stroke-width:6; stroke-linecap:round; opacity:.55; }
    .tumeter .lbl { fill:var(--muted); font:600 10px Roboto, Arial, sans-serif; text-anchor:middle; }
    .tumeter .needle { stroke:var(--strong); stroke-width:2.4; stroke-linecap:round; transition:transform .12s ease-out; transform-origin:150px 140px; }
    .tumeter.in .needle { stroke:#3fb950; }
    .tumeter.idle .needle { opacity:.25; }
    .tumeter .hub { fill:var(--strong); }
    .tunote { display:flex; align-items:baseline; gap:8px; margin-top:-8px; }
    .tunote b { font:700 34px Roboto, Arial, sans-serif; color:var(--strong); min-width:60px; text-align:center; }
    .tunote span { font:600 13px var(--mono); color:var(--muted); min-width:60px; }
    .tumsg { min-height:20px; font-size:13px; font-weight:600; color:var(--muted); }
    .tumsg.in { color:#3fb950; } .tumsg.up, .tumsg.down { color:#e3a33b; }
    .tustrings { display:flex; justify-content:center; gap:6px; padding:12px; flex-wrap:wrap; }
    .tustrings button { display:flex; align-items:center; justify-content:center; width:46px; height:46px; padding:0; border-radius:50%; font:700 16px Roboto, Arial, sans-serif; }
    .tuvol input { width:160px; vertical-align:middle; }
    .tustrings button.target { border-color:var(--accent); color:var(--accent); }
    .tustrings button.in { border-color:#3fb950; color:#3fb950; }
    .tustrings button.ringing { background:rgba(62,166,255,.18); border-color:var(--accent); }
    .tuopts { display:flex; justify-content:center; align-items:center; gap:14px; padding:0 12px 10px; }
    .tuopts[hidden] { display:none; }
    .lybody { padding:14px 16px; line-height:1.5; }
    .gkbody p { margin:4px 0; }
    .resetbtn { display:inline-flex; align-items:center; gap:5px; }
    .rsbody { display:flex; flex-direction:column; gap:10px; padding:12px; }
    .rsopt { display:flex; align-items:flex-start; gap:12px; padding:10px 12px; border:1px solid var(--border); border-radius:10px; background:var(--item); }
    .rsopt p { margin:4px 0 0; font-size:12px; line-height:1.45; color:var(--muted); }
    .rsopt > button, .rsbtns button { flex:none; white-space:nowrap; }
    .rsall { border-color:color-mix(in srgb, var(--red) 55%, var(--border)); }
    .rsbtns { display:flex; flex-direction:column; gap:6px; }
    .rsbtns button { display:inline-flex; align-items:center; justify-content:center; gap:5px; }
    button.rsdanger { background:var(--red); border-color:var(--red); color:#fff; font-weight:600; }
    button.rsdanger:hover { filter:brightness(1.1); background:var(--red); }
    .lyopt { display:flex; margin-top:10px; }
    .lyopt[hidden] { display:none; }
    .gkkey { font:700 26px Roboto, Arial, sans-serif; color:var(--strong); margin-bottom:2px; }
    .modal.chordmod { width:1000px; max-width:calc(100vw - 24px); height:86vh; max-height:none; }
    .chbody { flex:1; min-height:0; display:flex; border-top:1px solid var(--line); }
    .chbody textarea { flex:1; min-width:0; resize:none; border:0; border-radius:0; margin:0; padding:10px 12px; font:13px/1.5 var(--mono); }
    .chbody textarea { white-space:pre; overflow:auto; }
    .edside { width:250px; flex:none; overflow:auto; border-left:1px solid var(--line); display:flex; flex-direction:column; }
    .edside:not(:has(.edrefs:not(:empty))):not(:has(.chlib:not(.off))) { display:none; }
    #notesWin.noside .edside { display:none; }
    /* a narrow editor (to see more of the video): the tool buttons show just their icons, so they stay on one row */
    #notesWin { container:edwin / inline-size; }
    @container edwin (max-width: 760px) {
      .edtools .tabtool > span:not(.caret) { display:none; }
      .edtools .tabtool { padding-left:7px; padding-right:7px; }
    }
    .edsidebtn { display:inline-flex; align-items:center; justify-content:center; margin-left:4px; color:var(--accent); }
    .edsidebtn.off { color:var(--muted); }
    #edShapesOn { color:var(--accent); } #edShapesOn.off { color:var(--muted); }
    .edsidebtn .ar { transition:transform .15s; transform-origin:9.1px 6px; }
    .edsidebtn.off .ar { transform:scaleX(-1); }
    .chlib.off { display:none; }
    .cl-head { padding:10px 10px 4px; font-size:11px; font-weight:600; color:var(--muted); }
    .cl-add { position:relative; padding:0 10px; }
    .cl-add input { width:100%; background:var(--input); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:4px 8px; font-size:12.5px; }
    .cl-add input:focus { outline:none; border-color:var(--accent); }
    .clfilter { margin-top:4px; }
    .clfilter button { height:22px; font-size:11px; }
    .cl-sug { display:flex; flex-wrap:wrap; gap:3px; padding-top:4px; }
    .cl-sug:empty { display:none; }
    .cl-sug button { height:22px; padding:0 7px; font-size:12px; border-radius:5px; }
    .cl-sug button.on { border-color:var(--accent); color:var(--strong); }
    .cl-sug .none { font-size:11.5px; color:var(--muted); }
    .cs-dg.extra { position:relative; border-style:dashed; }
    .cs-dg .cs-rm { position:absolute; top:1px; right:1px; width:16px; height:16px; min-width:0; padding:0; border:none; border-radius:50%; background:transparent; color:var(--muted); font-size:12px; line-height:16px; opacity:0; }
    .cs-dg:hover .cs-rm, .cs-dg .cs-rm:focus { opacity:1; }
    .cs-dg .cs-rm:hover { color:var(--strong); background:var(--btn-h); }
    .edrefs { display:flex; flex-direction:column; gap:3px; padding:10px 10px 4px; }
    .edrefs:empty { display:none; }
    .edrefs .rf { display:flex; align-items:center; gap:6px; width:100%; min-height:26px; padding:2px 8px; text-align:left; font-size:12px; border-radius:6px; text-decoration:none; color:var(--text); background:var(--btn); border:1px solid var(--border); cursor:pointer; }
    .edrefs .rf:hover { background:var(--btn-h); }
    .edrefs .rf span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .edrefs .rf small { color:var(--muted); font-size:11px; flex:none; }
    .edrefs .rf .ico { flex:none; color:var(--accent); }
    .chshapes { overflow:visible; padding:10px; display:flex; flex-wrap:wrap; align-content:flex-start; gap:6px; }
    .chshapes:empty { display:none; }
    .chshapes.off { display:none; }
    .chshapes .cs-dg { flex:none; }
    .chshapes .cs-none { font-size:12px; color:var(--muted); padding:2px; }
    .chshapes .linkish { background:none; border:none; padding:0; color:var(--accent); font:inherit; cursor:pointer; text-decoration:underline; }
    .md pre.song { background:none; border:0; padding:0; margin:4px 0; font:13px/1.45 var(--mono); color:var(--text); white-space:pre; overflow-x:auto; }
    .song .sg-ch, .song .sg-ch b { color:var(--accent); font-weight:700; font-family:var(--mono); }
    .song .sg-ch b { cursor:pointer; }
    .song .sg-sec { color:var(--strong); font-weight:700; font-family:var(--mono); }
    .song .sg-title { color:var(--strong); font-weight:700; font-size:15px; font-family:var(--mono); }
    .csheet { font-size:14px; line-height:1.3; }
    .cs-diags { display:flex; flex-wrap:wrap; gap:6px; margin:2px 0 12px; }
    .cs-dg { display:inline-block; border:1px solid var(--line); border-radius:8px; padding:2px 2px 0; background:var(--input); cursor:pointer; line-height:0; }
    .cs-dg:hover { border-color:var(--accent); }
    .cs-sec { font-weight:700; color:var(--strong); margin:12px 0 4px; }
    .cs-sec::before { content:"["; color:var(--muted); font-weight:400; }
    .cs-sec::after { content:"]"; color:var(--muted); font-weight:400; }
    .cs-gap { height:.7em; }
    .cs-line { margin:1px 0 5px; }
    .cs-lyr { white-space:pre-wrap; }
    .cs-seg { display:inline-flex; flex-direction:column; vertical-align:bottom; }
    .cs-ch { color:var(--accent); font-weight:700; font-size:13px; min-height:1.25em; padding-right:.45em; white-space:nowrap; }
    .cs-ch b[data-chord] { cursor:pointer; }
    .cs-ly { white-space:pre; }
    .chordblk { cursor:pointer; border:1px solid transparent; border-radius:8px; padding:4px 6px; margin:6px -6px; }
    .chordblk:not(.noedit):hover { border-color:var(--accent); }
    .chordblk.noedit { cursor:default; }
    .cd { display:block; }
    .cd-name { fill:var(--strong); font:700 12px Roboto, Arial, sans-serif; text-anchor:middle; }
    .cd-line { stroke:var(--muted); stroke-width:1; }
    .cd-nut { fill:var(--text); }
    .cd-fr, .cd-mark { fill:var(--muted); font:600 10px Roboto, Arial, sans-serif; text-anchor:middle; }
    .cd-open { fill:none; stroke:var(--muted); stroke-width:1.3; }
    .cd-dot, .cd-barre { fill:var(--note); }
    .cd-dot.root { fill:#ef5a4c; }
    .cd-fi { fill:var(--note-text); font:700 9px Roboto, Arial, sans-serif; text-anchor:middle; pointer-events:none; }
    .cd-fi.root { fill:#fff; }
    .modal.shapemod { width:520px; }
    .modal.linksmod { width:480px; }
    .tename { flex:1; min-width:120px; max-width:260px; height:28px; font-weight:600; }
    .telist { height:28px; max-width:180px; font-size:12px; }
    .lkbody { display:flex; flex-direction:column; gap:12px; }
    .lklist { display:flex; flex-direction:column; gap:4px; }
    .lklist .empty { color:var(--muted); font-size:12px; }
    .lkrow { display:flex; align-items:flex-start; gap:6px; padding:6px 6px 6px 8px; border-radius:8px; background:var(--item); border:1px solid transparent; }
    .lkrow.editing { border-color:var(--accent); }
    .lkrow[draggable="true"] { cursor:grab; }
    .lkrow .lp-grip { align-self:center; }
    .lkrow.dragging { opacity:.45; }
    .lkrow.drop-before { box-shadow:0 -2px 0 var(--accent); }
    .lkrow.drop-after { box-shadow:0 2px 0 var(--accent); }
    .lkrow .lkt { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
    .lkrow a { font-weight:600; color:var(--accent); text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .lkrow a:hover { text-decoration:underline; }
    .lkrow small, .lkrow a.lkurl { color:var(--muted); font-size:11px; font-weight:400; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .lkrow a.lkurl:hover { color:var(--accent); }
    .lkrow .lkc { font-size:12px; color:var(--text); white-space:normal; }
    .lkform { display:flex; flex-direction:column; gap:8px; padding-top:10px; border-top:1px solid var(--line); }
    .lkform label { display:flex; flex-direction:column; gap:4px; font-size:11px; }
    .lkform input { width:100%; }
    .shbody { display:flex; gap:16px; align-items:flex-start; }
    .shedit svg { display:block; }
    .shedit .hit { fill:transparent; cursor:pointer; }
    .shedit .hit:hover { fill:var(--btn-h); opacity:.6; }
    .shside { flex:1; display:flex; flex-direction:column; gap:8px; }
    .shedit { outline:none; }
    .shedit .cd-sel { fill:none; stroke:var(--accent); stroke-width:2.5; }
    .cd-capo { fill:#8a6a4a; stroke:#5a4330; stroke-width:1; }
    .cd-capol, .cd-sounds { fill:#c79a6a; font:600 11px Roboto, Arial, sans-serif; }
    .cd-capofr { fill:#c79a6a; font:700 8.5px Roboto, Arial, sans-serif; text-anchor:end; }
    .cd-capofr.big { font-size:11px; }
    .cd-capob { font-size:9px; text-anchor:middle; }
    .cd-sounds { text-anchor:middle; }
    .shside label { display:flex; flex-direction:column; gap:4px; font-size:11px; }
    .shside input[type=text] { width:100%; font:13px var(--mono); }
    .shside .row b { min-width:22px; text-align:center; }
    .shhint { line-height:1.45; }

    /* tab editor */
    .modal-back.top2 { z-index:12; }
    .modal.tabed { width:min(960px, 96vw); max-height:88vh; }
    .tebar { display:flex; flex-wrap:wrap; align-items:center; gap:4px; padding:6px 12px; border-bottom:1px solid var(--line); }
    .tebar select { max-width:230px; }
    .tebar label { display:inline-flex; align-items:center; gap:6px; }
    .tebar .tq { min-width:26px; padding:3px 6px; font-family:var(--mono); font-weight:600; }
    .tebar .tsep { width:1px; height:18px; background:var(--line); margin:0 4px; }
    .tg { display:flex; align-items:flex-start; }
    .tg-names { display:flex; flex-direction:column; padding-top:16px; margin-right:4px; font:600 12px var(--mono); color:var(--muted); text-align:right; }
    .tg-names span { height:22px; line-height:22px; font-family:var(--mono); }
    .tg-scroll { overflow-x:auto; flex:1; padding-bottom:6px; }
    .tg-strip { display:flex; width:max-content; }
    .tg-m { display:flex; flex-direction:column; }
    .tg-m .tg-bar { border-left:2px solid var(--muted); }
    .tg-m:last-child .tg-bar { border-right:2px solid var(--muted); }
    .tg-num { height:16px; font-size:10px; color:var(--muted); padding-left:4px; }
    .tg-bar { display:grid; grid-auto-rows:22px; }
    .tg input[type=text] { width:28px; height:22px; padding:0; margin:0; border:none; border-radius:3px; text-align:center; font:600 12px var(--mono); color:var(--strong);
      background-color:transparent; background-image:linear-gradient(to bottom, transparent 10px, var(--muted) 10px, var(--muted) 11px, transparent 11px); }
    .tg input[type=text].filled { background-image:linear-gradient(to right, transparent 3px, var(--bg) 3px, var(--bg) 25px, transparent 25px),
      linear-gradient(to bottom, transparent 10px, var(--muted) 10px, var(--muted) 11px, transparent 11px); }
    .tg input[type=text].colcur { background-color:rgba(62,166,255,.16); }
    .tg input[type=text]:focus { outline:2px solid var(--accent); outline-offset:-2px; }
    .tehelp { margin:8px 0 4px; line-height:1.45; }
    .tg + .tg { margin-top:10px; }
    #teGrid { --tgrow:22px; }
    #teGrid[data-show=both] { --tgrow:32px; }
    .tg-names span { height:var(--tgrow); }
    .tg-bar { grid-auto-rows:var(--tgrow); }
    .tc { position:relative; display:block; height:var(--tgrow); }
    .tn { display:none; position:absolute; left:-4px; right:-4px; text-align:center; pointer-events:none; white-space:nowrap; font:600 11px var(--mono); color:var(--accent); }
    #teGrid[data-show=note] .tn { display:block; top:0; line-height:22px; }
    #teGrid[data-show=note] .tc input:not(:focus) { color:transparent; }
    #teGrid[data-show=note] .tc input:focus + .tn { display:none; }
    #teGrid[data-show=both] .tn { display:block; top:21px; line-height:10px; font-size:9px; color:var(--muted); }
    .tg-capo { display:flex; flex-direction:column; align-items:center; width:14px; margin-right:3px; }
    .tg-capo-n { height:16px; line-height:16px; font:700 9px var(--mono); color:var(--accent); }
    .tg-capo span { width:5px; height:var(--tgrow); }
    .tg-capo span.on { background:var(--accent); opacity:.8; }
    .tg-capo span.on:first-of-type { border-radius:3px 3px 0 0; }
    .tg-capo span.on:last-of-type { border-radius:0 0 3px 3px; }
    .capostr { gap:1px; padding:1px; }
    .capostr[hidden] { display:none; }
    .capostr button { min-width:20px; height:22px; padding:0 3px; font:600 11px var(--mono); color:var(--muted); background:transparent; border:none; border-radius:4px; }
    .capostr button.on { color:var(--strong); background:rgba(62,166,255,.18); }
  </style>
  <div class="panel">
    <div class="head">
      <img class="logo" alt="" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAASRUlEQVR42q1YZ3hU1dZ+9z5nZjLJTHpCGoQUSoAQTABROoQABhWBoKjYKApSroqCer3c6y1+Nq7YaerFRg1KkSICQUS6CJgQQkgnvTA1c8pe349MikjQ7/nufp79POfMrJn9nnXWete7FtD5kjhngCTdvXTpEnp+6RIdwKfLly+XGWMAIHntGADuve+4ufc7eK+5JEkAsDBz4nj3urUfktVqfdf7vYz/wpI55wAw74P33yEi8vz1L38mHx+ffQDCW20YY2CMgXP+m93xwbzXr02ZfBfZXA4t/+J58vf33wYAWVlZ0n8FsPeQf23dsoGoskwlIu2LDZ9TVGTk5cjIyNQOgLoCGAhgLIBxAIYAiAfgAwBz584NsFgs2597bgkRkU7VFVpR7s8Un5hwHACIiF13Nuvwdn4NqjO0I0eORE5ODvzM5pjouDg0vvsm7CazNOOlf2kR4WEJkzLvPmA0GnfHxsbe0rVrTLeIiAhzUFAgDLIMl9uN6uoataysvLKoqOin1atXJ/ztry/1+8vylzXnN9ly5UdrRPiKtxEYFBwOFBo452praBGR4JxTKw4ikgDovwt41KhRIicnB/4BAdGB/lb4ELHyLZvw4tET8s9mq5g967GAzDsz7xuQkozw8HCAGQkAtXuIDE57U7e8i5e67dm9ByfOntVn3Zkpz6wqRp/ICOZjMCAwKDAEQBCAGm+c6963Fuq9r+kI9qbL+0PWo2fPC8Jjo333T9HTIsJpwdNPU0F+HhGRICKVSNdJdwtddZKmONo2aU5BpOhEpBGR3thQQytWvkVpyf3o7z27C3LW030zHxQA+hARY4zBaDROS0xM/H7woEH1AwcObEpO7nfWbDYvbsXSWZh48TIAsE6YML76i/UfU9rAVHHgyGFqWYI0xU6a4iChuYh09w230Fykq05SPXYi8hARUXllBWVkTqS//fkFfdmy5wjAOMYYgoODl/fp04d27simk8d/oA1ffkr5eedo8OBBFBERsaGNaToBzAFQUlJSZFlZ+bPFpaXS5o0b0b9ff6YpDjAIcC51ZIJO31Irg5AQ0DUPAgMCMfP+B7Bp6xZ9y5ZtPCIiIru+vp7fM/nuzUueWawTiAIDA1lDQyPCwkIpKipS7d27V8qBg4euMsZOdcrBRGBWq3lIr969qLKiRCeiFk914s0/unXVSbrmJiJSp2dNI1mWnzSb/f55OGe/qKutVn7+6SS5nTZqaqylstLLlPvLOa2utkKPior68WYhzBljMJnNG3ft2EZEpKnNtv832HbQDiLSRHVlKSUkJOSGhob+mJ93roXySCWiZiJSvJt0t7ORBg0aeAWAiXcCVhBRv7GjR2bdMelO0jWXJBsMbQZCCOi6Dl3XIYTo9KmJqM1O19uTnXMJmuJm4RFdMXfOY0l1dfVDGhubIITgqscNCALpGnRVga6rcLpcor6+wQZA7QwwAJZ17/QsBkg6dQAlhACXfSEZ/CAZ/MBl3xuCJhJgkrHNTjL4gUh0AM1BJDB1ymSyWC36h6vWCs45DCZzmyM455Akg1i//nNeXFy8jTH224OWL1/OASA0NHRP7oWfiIg0XXV6s95JRETnz52hRx6eSTNmTKcfjuS08Ibm7MAOLXZXK0po4YL5NHXKZPoqe7PXrgOrULPQVBeNGjWynjFevmjhfKqvrxVeKiJFcetrVn9AISEhp0NCQqwAeGeFQwoODo4ICQkBIBhjDLqug0s+yDn0HR544CHMmTMbfhYLsqbPwMq33sS0adOha+4WZpCMKLycj4l33Ilx6WMxNj0DzyxZiryLF7Fs2YvQNRckSYLQdMZlM4wGQ/CIEcMoKDgEkyffw7p37w6DwSDKy8rYseMnygCMs9lsdi973Xj16NHjRH1tBRGRrqtO0tUWrx07foQO5exvdQKdPvkjfbtvFwmhktJsI7XZRkJXqCD/Am3L3tRmV1paSFuzNxGRINGBo4mIJozPoL17dhIRUWVFCe3f9w0dOHBA3fDlpxQcHPy5lzrlG3EvIiMj746JiZkVHh5+9uiRQ6IlcxUi3U1aZQlRRTGR6iRNdZLqsVH7UjpcC2+Bo5bKpzqINBdRfRWpJQUkPHavvUa11eU0etRIWrPqfVq//j/eUCEiIvWD998hAPO94ki+HjUBgMfjOWW1Wnt6PEruex+sSvnh6HExfOQwDOqRCKWwCOAcVFYOc7++YL6+0BUHBJNRXlGK7P98BlnX0H/0aAwfNgJCd8JoNAJE8OTmQbfZwcDAdIEqowmbN29FcdEVqKqK2LgEJMR1hRAEodnBZV/pUM5hAvCjJEkEQOC6mCAAaGhoqCgpKTl47VrTU83NzZ558x5HfHwciYZGMFkG9/GBRAThcgGMQZI4DAYfxHXvicaqShzYvgOpg4dANphgNJkAxkCqCjR7IJnN4CYjhN0Oq9mEhx9+FP7+/njkkZkYNy4D8YlJ4ByQjb7C5WhkeXkXywHkEVEbvtbugFqFRVRU1C1Wq3V8QEBASkFBYVJR0ZXQfv36U3h0BNNr6wBVA/czQ46OBpM4NE1g7dq1yMvLQ3FdPdy+FohmD74/fBBdY2Jg9Q8EJAZq9oBsNgghIEVGoIkY3nv3HXz+xUYk9+uLy5cL0dRYh+joaEiSj/7TmdP87Xfe/1ZRlC+zsrKk3Nxc0RoSegclRIwxoxDiqiRJZQ6H/dCx4yeOhIUGB0nWEF3u1UPiigoeGABmMIKEDlk2Ijm5L77//gjmzX4UUVFRWPvRx+jWtRtCQsNApIEBMMTFQgQFQoDAA4MpUjLh9JkzbPlLz2NM+gSUFBdA8SgQ3gJz7PgJ2O32Q5xzbN68uV2whEdGzu1IZzeQmJkjhw2lmsrylhKtu0jo1ym0X62OydfcgZvdpGkub0YKmjvrUUodkNIhSamdz4nEvdOnCQAp3jatPXR7xnWjLpFRmyMjI0O9Hxk6NJCtSTm6d+otlT+0yUutTfd2lJC66iShuUj1tEtPTXWSprTLy8ryUpo64143gIL31q0mIhJKs41a9TSRpjc1VFPfvn2KABg7aOEWKgvzlbUIi3EaAx3v2TN+KGNMTUuDlNUCWsvp0fXh2tSe900pK3z7zrvvObpw2VLlcklJW7llkglc4pA4B4hAQkBiDBLnYJIMSfaFZLCgyeakt1Z/KG5Lzyi49tVXb3zSPaJuZEkhQWkmWTbA60kAkjh/4QKKioqPAlC8LVJby8SGJMWRkTO1WfIxnC8sveJ2OsYAKOGMYTiR/EqvbmXdTcaIOk3X3EL8sqaqzpIXEh7TN2O8cfTECSz1lhTEREbAV/L5FakLCFQ11uP8hVwc3P8dndi1S/e/fKnmsWD/qh4W3wRqbg5oampC6o/H4ZOQBGhuaEJANlq0N17/H/nZ556fyzlfI4SQAWhtgG/v3V21BAaz2L79qUdCtLxxy87G8uKi16sbbCsZY66aQUlj6lyeVxShDzYzBsEYGjQhfrbZeYFOuBYUAikyCv7R0QgL9gfjHE6HG3XVNWguL4OhugrxuoIUfwt1NRlhYoy5NQ2NBhPFzV/AombNAfOmvCABLvnS1Kn3UHb2V/05578IIXgrBwMA658YS7KPBQ89ch8WPzNPLTx70pD99W58uvVg3vnz518GcBqAZ33vuLvcuvZ6H0kySnYbN0scRqMJCgN0TUOZW8XOJgUOQRhlNSDNYgCTZfhyDl3T4PR4wPwDcElR9Z0NNnrl0EE5PmUghObyKjcCk4yiqaGW3z5sTGFeXl4SY0z1VjlqZwWTRWqwXdN++SVfXKutCUtLjkfG+Axt7/7DXfysAdMy0tMXdonoMvuNU2cHxDzwUOgT6z5mxp6JEAEBcAoBUhRUEcdKsxG9pkUgYWQItlyT4O8xINFihjusC0ypAxE24wHEL3sRtnET+boTp7jRbMawocMgdBWcsxY5KZn0UydP8Hff+2C3pqlbpk2DlJsLcYPeCwDgb/Uz/S1rcobtrswMWrRogaYozToREekKHfpuP40ZNYL27N9D3taANI+DtMoKeuCuKfTkg7FU9NXtVLDlNvrPP/pRWv9+1Jh7lnS3/TqNQeS41kiTMifS0pbBCmlKa6NK6ptvvEoAHvcm4Q3VpNQi2gHGOAD0CAsPL2+ouyqISHjpShCRyMs9R4MGplFddUULaNVBgogmZmbQm4sTac1LA+i955Pp05dTaMSt8XSxsLDFzmMnodhbRJPSKnx0yrxjAq1487UW9m62tfDvvVk35t8OCk0HIIjAUlNvMXDGCsw+xqJr12wMEMLb9TKl2cZ6JyUjPX0sRqdnYO/uneCyHxiAAP9wRASpyLjVivgoE0amMCi6GSEWPwjdAyZJYJIMcA5JkiE0BUQ6Nmz4El9u2ITjx47AYLIKW1Mtu3jxUjmA/I764abzNKLlHMATzy552jsEUUhTHNTsaiIiohUr3qT7p6TT/FnTaOIdmXTixAmqqKigoUNS6YmpsfTSnL404tYE2rnzG28YeFoKwnWNaIunifbu3kHp6WOJiLRTJ49SQEDA1/+XASEDgAEDBoRZLBb7008totraqra6WVx8hQak9KPDu9YS6eX04cq/U/ro2+gfL79I58+do+mPzCGYA6n/LYNo3uKF9M+Vb1F5VXmbLhaqk0SHCZHqcRAR0Z2TMun0yaPq7m+2awBeuFn8shtMLDUieuSFF5Z+7O8fqO/auUtK7JEIIQhlZWXoFhUCxePEg/dNxcR7JqLq0gWs+WQbNu49hjQfjjv8TIj3NcFps+N4gw37JTMeXLoUD98747en625oZMSe3dvx2usrRHBQED94KCfDbrd/e/0QsDPAEmNMt1gsXx34bu/dAwfdptVWl8vnz1+AqqoYNGgggkMjsTV7K1a+9TaSEkLx/J9mobhewddvf4S/RPojSHGj9pod++zNsBgNcNTUYlVJJeImZkJtdkMIgZCoaAy+bQim3jEBFksguZyNLDVtiDM//9LCSZPSNu7cedrdUaN3BpgxxoiITCkp/S8dOfxdN1+LVXAu8fa3o0FoCrjsC0Vx4+N1a7A1OxscMv49eABirL6oq6zEpzUNuG3BbPhb/FB3pRjHvtmP0r37sKhnd+gGAwqa7Pi+0Ya8gFDMXLgAsx98iGbNehQfffRJH875RSGE1NnUUr5OTRIRomNioqMs/kGArjDSBYgUEFHbZF1XnTDKEh6ftwi3Dh+BxVOmoUtsMNxaOHabrMh6eT6SEmJhr67CY//4N56YOxP61Mn47r0PMNdXxuBuUbhf1ZBX34inn1uCopISPblvksw5H6rrej67ycCO/9rbDAC6REdFyYBEumhp8VsGGlLb4E+SJO9Ux43ePRNhCQ8HbDaUnjkDn/iuSIqNhsfuxBfb9uFSQQnMEkfGhPHoOW8OlttVlF6tBgGICwrANxlD0bjhM6z+YhOiwsMjGWM3pbIb9fkWq9X6uxzIGAOEgI/RgpDeSfi2qg69ggNQcOo0YDTjUv4lbP16L+bPfQi3jxmLowf248VnliNx0gSsswRjQ34RXE43XIKwMjUJMbZG1GrCl/0OjfEbMgfDHx56E+n406In8WpJNRRJwu0lRfjsyw3Ysmc/FLcDWfdMhOKwI3vXISSn9MfDUybhqQ9XwPzCc1inAk6XGwbO2LO9YiFz9Ogs2W4G2OVyuv4QYM45SPcgtX8q/vTqq5hw5Cz8SEfgJ+uhXL6CMeOGw+Tvhy2btuHQ98cwf/aDMFus8CNg2IBksPR07G5yQBfEU6y+6GvxHUWAP2vvM2+adK1P1VBbV0ftQ8HfB62rTjx03/2I694dr/7zFfDL+ch0upBQUYrXikvhCAvHwOREDB6UDJfTBdlgxGtvrIUlLBCOmBg4HI3M6uuLaB9TCIyWGCiO3Nam+GYeJm/9rqyurmnSVRfAGAkhcPPdwh6a4sDwIbdj544dmLtqFdbX2pAeG4m7rpZCrryKBcsWwycgAAFdgnEo5yhUVcHwkYOB6hr4mExERNCJCFBU9gdjmIQQDEBjWVnZlfr6OnDJLLjsAy773mSbwSQzZKPFS50aJo0YjVunTsUrP11EWmwUHquvwo4Fz+D9t97Hz3mXwC0+iEyIwZFVH2OCDHBZphpFxSWHuwSKUqp34t3f1GvGmARAczpdZ55c8FRacEgoCV1tE8x/ZJEggHE0XWvCxqpGDK2owdCwYDzl8eD49u3I2b4LnoBAhDrtGOtjQFiQPySQ2FJZz/Mdrs8Z4GEtuLQb/f//AjdEmeskJEu3AAAAAElFTkSuQmCC" /><span class="title">Guitar Playa Companion</span>
      <button class="hbtn" id="libBtn" title="Saved Videos"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M4.2 3 H10.2 M4.2 6 H10.2 M4.2 9 H10.2"/><circle cx="2" cy="3" r=".6" fill="currentColor" stroke="none"/><circle cx="2" cy="6" r=".6" fill="currentColor" stroke="none"/><circle cx="2" cy="9" r=".6" fill="currentColor" stroke="none"/></svg></button>
      <button class="hbtn" id="impBtn" title="Import"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M6 7.7 V1.6 M3.6 4 L6 1.6 L8.4 4 M1.8 8.4 V10.3 H10.2 V8.4"/></svg></button>
      <button class="hbtn" id="dlAll" title="Export"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M6 1.5 V7.6 M3.6 5.3 L6 7.7 L8.4 5.3 M1.8 8.4 V10.3 H10.2 V8.4"/></svg></button>
      <button class="hbtn" id="tunerBtn" title="Tuner"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M4.3 1.2 V5.3 a1.7 1.7 0 0 0 3.4 0 V1.2 M6 7 V10.8 M4.8 10.8 H7.2"/></svg></button>
      <button class="hbtn" id="metroShow" title="Metronome"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M4.4 1.6 H7.6 L10 10.6 H2 Z M6 8.2 L8.9 3.1"/></svg></button>
      <button class="hbtn" id="themeBtn" title="Theme"></button>
      <button class="hbtn" id="helpBtn" title="Help"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><circle cx="6" cy="6" r="4.9"/><path d="M4.55 4.75 a1.5 1.5 0 1 1 2.1 1.35 c-.45 .22 -.65 .55 -.65 1.05"/><circle cx="6" cy="8.8" r=".45" fill="currentColor" stroke="none"/></svg></button>
      <button class="hbtn exit" id="close" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button>
    </div>
    <div class="toast" id="toast"></div>
    <div class="body">
      <div class="warn" id="warn"><div id="warnText"></div><button id="openExt">Open Extensions Page</button></div>
      <div class="novideo" id="novideo">▶ Open a video to use the loop and speed controls. The metronome and the scale library work anywhere.<div class="novbtn"><button class="notesbtn" id="chordsBtn2" title="Chords">${ic("chords", 12)}<span>Chords</span></button><button class="notesbtn" id="scalesBtn2" title="Scales">${ic("scales", 12)}<span>Scales</span></button></div></div>
      <div class="vsec" id="vsec">
        <div class="now" title="Time">
        <span id="nowTime">0:00.0</span>
        <span class="muted" id="durTime"></span>
        <span class="nowbtns">
          <button class="notesbtn" id="notesBtn" title="Editor"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 1.5 H7.5 L9.5 3.5 V10.5 H3 Z M7.5 1.5 V3.5 H9.5 M4.6 5.6 H7.9 M4.6 7.3 H7.9 M4.6 9 H6.6"/></svg><span>Editor</span></button>
          <button class="notesbtn" id="chordsBtn" title="Chords">${ic("chords", 12)}<span>Chords</span></button>
          <button class="notesbtn" id="scalesBtn" title="Scales">${ic("scales", 12)}<span>Scales</span></button>
          <button class="notesbtn" id="tabsBtn" title="Tabs"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M1 2.5 H11 M1 4.8 H11 M1 7.1 H11 M1 9.4 H11" stroke-width="1.1"/><circle cx="4" cy="4.8" r="1.3" fill="currentColor" stroke="none"/><circle cx="8" cy="7.1" r="1.3" fill="currentColor" stroke="none"/></svg><span>Tabs</span></button>
          <button class="notesbtn icononly" id="linksBtn" title="Links"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M5 7 L7 5 M4.6 5.4 L3.3 6.7 a1.8 1.8 0 0 0 2.5 2.5 L7.1 7.9 M7.4 6.6 L8.7 5.3 a1.8 1.8 0 0 0 -2.5 -2.5 L4.9 4.1"/></svg></button>
        </span>
      </div>
        <div class="loopbar" id="loopBar">
          <button class="small vidsave" id="vidSave" title="Save Video"></button>
          <button class="lselbtn grow" id="loopSel" aria-haspopup="listbox" title="Loops"><span class="lsellab" id="loopSelLab"></span><svg class="hico" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.5 4.25 L6 7.75 L9.5 4.25"/></svg></button>
          <button class="savebtn" id="saveCur"></button>
          <button class="small" id="saveNew" title="New Loop"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M6 2 V10 M2 6 H10"/></svg></button>
          <button class="small" id="loopEdit" title="Edit Loop"><svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M8.2 1.8 l2 2 L4.4 9.6 L1.8 10.2 L2.4 7.6 Z M7 3 l2 2"/></svg></button>
        </div>
      <div class="row">
        <span class="lbl">A</span>
        <input type="text" id="aIn" placeholder="0:00.0" />
        <button class="small" data-nudge="a" data-d="-0.1" title="Earlier">−</button>
        <button class="small" data-nudge="a" data-d="0.1" title="Later">+</button>
        <button class="grow" id="setA" title="Set A">Set A</button>
      </div>
      <div class="row">
        <span class="lbl">B</span>
        <input type="text" id="bIn" placeholder="0:00.0" />
        <button class="small" data-nudge="b" data-d="-0.1" title="Earlier">−</button>
        <button class="small" data-nudge="b" data-d="0.1" title="Later">+</button>
        <button class="grow" id="setB" title="Set B">Set B</button>
      </div>
      <div class="row">
        <button id="goA" title="To A">⏮ To A</button>
        <button class="grow play" id="play" title="Play">▶ Play</button>
        <button id="goB" title="To B">To B ⏭</button>
      </div>
      <div class="row">
        <button class="grow" id="loop" title="Loop">Loop: OFF</button>
        <button id="clear" title="Clear">Clear</button>
      </div>
        <div class="divider"></div>
        <div class="row">
          <span class="muted rowlbl">Speed</span>
          <button class="small" id="slower" title="Slower">−</button>
          <input type="text" id="speedIn" class="speedin" title="Speed" />
          <button class="small" id="faster" title="Faster">+</button>
          <input type="range" id="speed" min="25" max="500" step="5" value="100" />
        </div>
        <div class="row">
          <span class="grow">Pause Between Loops</span>
          <button class="small" id="delayDown" title="Less">−</button>
          <input type="number" id="delay" class="delayin" min="0" max="10" step="0.5" title="Seconds" />
          <button class="small" id="delayUp" title="More">+</button>
          <span class="muted">s</span>
        </div>
        <div class="row">
          <label class="chk grow" title="Speed Trainer"><input type="checkbox" id="trOn" /> Change Speed Each Loop</label>
          <button class="small" id="trReset" title="Reset Speed"><svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M2.6 4.4 A4 4 0 1 1 2.2 7.4 M2.6 1.8 V4.4 H5.2"/></svg></button>
        </div>
        <div class="row trrow" id="trRow">
          <span class="muted">by</span>
          <button class="small" id="trDown" title="Slower">−</button>
          <input type="text" id="trStep" class="trin" title="Step" />
          <button class="small" id="trUp" title="Faster">+</button>
          <span class="muted">until</span>
          <input type="text" id="trLimit" class="trin" title="Target" />
        </div>
        <div class="actual" id="actual"></div>
      </div>

      <details class="section metro-sec" id="metroSec">
        <summary id="metroSumRow" title="Show Metronome"><span class="mchev" aria-hidden="true"><svg class="hico" viewBox="0 0 12 12" width="12" height="12"><path d="M4.4 2.4 L8 6 L4.4 9.6"/></svg></span><span>Metronome</span><span class="mhint" id="metroHint">Show</span><span class="grow"></span><span class="muted" id="metroSum"></span></summary>
        <div class="metro">
        <div class="mcol">
          <div class="row">
            <button class="play" id="mStart">▶ Metronome</button>
            <div class="dots" id="dots"></div>
          </div>
          <div class="row">
            <button class="small" id="bpmDown" title="Slower">−</button>
            <span class="bpm" id="bpmVal">120</span>
            <button class="small" id="bpmUp" title="Faster">+</button>
          </div>
          <div class="row">
            <button id="tap" title="Tap Tempo">Tap</button>
            <button class="grow ico-btn" id="detect" title="Auto BPM"><svg class="cat-ico" viewBox="22 8 96 98" width="18" height="18" aria-hidden="true"><g stroke="#1a1a1a" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M34 50 L 38 14 L 62 34 Z" fill="#fffdf7"/><path d="M106 50 L 102 14 L 78 34 Z" fill="#fffdf7"/><path d="M40 41 L 41 24 L 54 34 Z" fill="#d9463b" stroke="none"/><path d="M100 41 L 99 24 L 86 34 Z" fill="#d9463b" stroke="none"/><ellipse cx="70" cy="58" rx="40" ry="32" fill="#fffdf7"/><circle cx="47" cy="68" r="7" fill="#f2a3a0" stroke="none" opacity=".7"/><circle cx="93" cy="68" r="7" fill="#f2a3a0" stroke="none" opacity=".7"/><path d="M49 58 q6 -8 12 0 M79 58 q6 -8 12 0" fill="none" stroke-width="5"/><path d="M65.5 66 h9 l-4.5 4.5 z" fill="#d9463b" stroke-width="2"/><path d="M38 86 Q70 102 102 86" fill="none" stroke="#c8281f" stroke-width="9"/><circle cx="70" cy="97" r="7" fill="#e8b83a" stroke-width="3"/></g></svg><span id="detectLabel">Auto BPM</span></button>
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
      <div class="modal-head"><svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M3 1.6 h6 v8.8 l-3 -2.3 l-3 2.3 z"/></svg><span class="grow">Saved Videos</span><button class="hbtn exit" id="libClose" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button></div>
      <div class="libbar">
        <input type="search" id="libSearch" placeholder="Search Videos and Loops" title="Search" />
        <select id="libSort" class="libsort" title="Sort" aria-label="Sort"><option value="custom">My Order</option><option value="newest">Newest First</option><option value="oldest">Oldest First</option><option value="az">Name A–Z</option><option value="za">Name Z–A</option></select>
      </div>
      <div class="modal-body"><div class="lib" id="lib"></div></div>
      <div class="modal-foot">
        <span class="muted grow" id="libStats"></span>
        <button class="ico-btn" id="libExport" title="Export"><svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M6 1.5 V7.6 M3.6 5.3 L6 7.7 L8.4 5.3 M1.8 8.4 V10.3 H10.2 V8.4"/></svg><span>Export</span></button>
        <button class="ico-btn" id="libImport" title="Import"><svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M6 7.7 V1.6 M3.6 4 L6 1.6 L8.4 4 M1.8 8.4 V10.3 H10.2 V8.4"/></svg><span>Import</span></button>
        <input type="file" id="libFile" accept=".gpyc,.json,application/json" multiple hidden />
      </div>
    </div>
  </div>
  <div class="modal-back top" id="loopModal">
    <div class="modal editor" role="dialog" aria-label="Edit loop">
      <div class="modal-head"><svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M8.2 1.8 l2 2 L4.4 9.6 L1.8 10.2 L2.4 7.6 Z M7 3 l2 2"/></svg><span class="grow" id="leTitle">Edit Loop</span><button class="hbtn exit" id="loopClose" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button></div>
      <div class="modal-body">
        <div class="form">
          <label>Label</label>
          <input type="text" id="leName" maxlength="80" />
          <label>Description</label>
          <textarea id="leDesc" rows="3" maxlength="1000" placeholder="Notes"></textarea>
          <div class="grid">
            <label>A (start)</label><input type="text" id="leA" placeholder="0:00.0" />
            <label>B (end)</label><input type="text" id="leB" placeholder="0:00.0" />
            <label>Speed</label><span class="unit"><input type="number" id="leSpeed" min="25" max="500" step="5" /> %</span>
            <label>Pause Between Loops</label><span class="unit"><input type="number" id="leDelay" min="0" max="10" step="0.5" /> sec</span>
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
            <button id="leOpen" title="Open">▶ Open loop</button>
            <button id="leCancel">Cancel</button>
            <button class="primary" id="leSave">Save Changes</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="nwin" id="notesWin" role="dialog" aria-label="Editor">
    <div class="nhead" id="notesHead"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M3 1.5 H7.5 L9.5 3.5 V10.5 H3 Z M7.5 1.5 V3.5 H9.5 M4.6 5.6 H7.9 M4.6 7.3 H7.9 M4.6 9 H6.6"/></svg><span class="ntitle" id="notesTitle"></span><button class="hbtn exit" id="notesClose" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button></div>
    <div class="ntools mdtools" id="mdTools" role="toolbar" aria-label="Text">
      <button class="nb" data-md="undo" title="Undo">${ic("undo")}</button>
      <button class="nb" data-md="redo" title="Redo">${ic("redo")}</button>
      <span class="tsep"></span>
      <select id="edFont" class="ffam" title="Font"><option value="">Font</option><optgroup label="Fixed width (chords line up)">${EDITOR_FONTS.slice(0, 4).map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}</optgroup><optgroup label="Other">${EDITOR_FONTS.slice(4).map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}</optgroup></select>
      <select id="edSize" class="fsize" title="Size"><option value="">Size</option>${[10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40].map((n) => `<option value="${n}">${n}</option>`).join("")}</select>
      <span class="tsep"></span>
      <button class="nb menu" data-menu="style" title="Headings">${ic("heading")}<span class="caret">${ic("chevron", 10)}</span></button>
      <button class="nb" data-md="bold" title="Bold">${ic("bold")}</button>
      <button class="nb" data-md="italic" title="Italic">${ic("italic")}</button>
      <button class="nb menu" data-menu="fcolor" title="Text Colour">${ic("fontColor")}<span class="caret">${ic("chevron", 10)}</span></button>
      <button class="nb menu" data-menu="text" title="More Styles">${ic("textStyle")}<span class="caret">${ic("chevron", 10)}</span></button>
      <button class="nb menu" data-menu="highlight" title="Highlight">${ic("highlighter")}<span class="caret">${ic("chevron", 10)}</span></button>
      <button class="nb" id="edDraw" title="Draw">${ic("draw")}</button>
      <span class="tsep"></span>
      <button class="nb menu" data-menu="insert" title="Insert">${ic("plus")}<span class="caret">${ic("chevron", 10)}</span></button>
      <button class="nb edsidebtn" id="edShapesOn" title="Hide Chord Shapes" aria-pressed="true"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><rect x="1.3" y="2" width="9.4" height="8" rx="1.2"/><path d="M7.6 2 V10"/><path class="ar" d="M8.6 4.8 L9.6 6 L8.6 7.2"/></svg></button>
    </div>
    <div class="drawbar" id="drawBar" role="toolbar" aria-label="Draw">
      ${[["pencil", "Pencil"], ["pen", "Pen"], ["quill", "Old ink pen"], ["marker", "Marker"], ["chalk", "Chalk"], ["smear", "Smear"], ["eraser", "Eraser"]].map(([t, n]) => `<button class="dtool" data-tool="${t}" title="${n}">${ic(t, 17)}</button>`).join("")}
      <span class="tsep"></span>
      <span id="drawCols"></span>
      <span class="tsep"></span>
      <select id="drawWidth" class="dwidth" title="Width">${[["0.4", "Hairline"], ["0.6", "Thin"], ["1", "Medium"], ["1.5", "Thick"], ["2.2", "Heavy"], ["3.2", "Wide"]].map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}</select>
      <span class="tsep"></span>
      <button class="dtool" id="drawUndo" title="Undo">${ic("undo", 16)}</button>
      <button class="dsize" id="drawClear" title="Clear">Clear</button>
      <button class="dsize" id="drawDone" title="Done">Done</button>
    </div>
    <div class="ntools edtools" id="notesTools" role="toolbar" aria-label="Song">
      <select id="edSections" class="secsel" title="Section"><option value="">Section</option>${["Intro", "Verse", "Pre-chorus", "Chorus", "Bridge", "Solo", "Interlude", "Outro"].map((x) => `<option value="${x}">${x}</option>`).join("")}</select>
      <div class="sgrp trgrp" role="group" aria-label="Transpose"><button id="edDown" class="arr" title="Transpose Down" aria-label="Transpose down a half step"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 4.6 L6 7.6 L9 4.6"/></svg></button><button id="edUp" class="arr" title="Transpose Up" aria-label="Transpose up a half step"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 7.4 L6 4.4 L9 7.4"/></svg></button></div>
      <select id="edCapo" class="capsel" title="Capo"><option value="0">No Capo</option>${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">Capo ${i + 1}</option>`).join("")}</select>
      <button data-md="chords" class="tabtool" title="Chords">${ic("chords", 14)}<span>Chords</span></button>
      <button data-md="scales" class="tabtool" title="Scales">${ic("scales", 14)}<span>Scales</span></button>
      <button data-md="tab" class="tabtool" title="Tabs"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M1 2.5 H11 M1 4.8 H11 M1 7.1 H11 M1 9.4 H11" stroke-width="1.1"/><circle cx="4" cy="4.8" r="1.3" fill="currentColor" stroke="none"/><circle cx="8" cy="7.1" r="1.3" fill="currentColor" stroke="none"/></svg><span>Tabs</span></button>
      <button data-menu="loops" class="tabtool" title="Loops">${ic("loop", 14)}<span>Loops</span></button>
      <button data-md="links" class="tabtool" title="Links">${ic("link", 14)}<span>Links</span></button>
      <button data-menu="guess" class="tabtool" id="edLyrics" title="Guess" aria-haspopup="menu">${ic("spark", 14)}<span>Guess</span><span class="caret">${ic("chevron", 10)}</span></button>
    </div>
    <div class="nbody" id="notesBody">
      <div class="edscroll" id="edScroll"><div id="notesText" class="live" contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true" aria-label="Page"></div><svg class="edink" id="edInk" xmlns="http://www.w3.org/2000/svg"><defs><filter id="ygcChalk" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="3" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="2.2" result="d"/><feComponentTransfer in="n" result="g"><feFuncA type="discrete" tableValues="0 1 1 1 1 0.6 1 1 1 1"/></feComponentTransfer><feComposite in="d" in2="g" operator="in"/></filter><filter id="ygcSmear" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3.2"/></filter></defs><g id="edInkG"></g></svg></div>
      <input type="file" id="edImgFile" accept="image/*" hidden />
      <div class="edside" id="edSide"><div class="edrefs" id="edRefs"></div><div class="chlib" id="edChLib"><div class="cl-head">Chord Library</div><div class="cl-add"><input type="search" id="edChSearch" placeholder="Add a Chord" title="Add" autocomplete="off" spellcheck="false" /><div class="sgrp scfilter clfilter" id="edChFilter" role="group" aria-label="Show"><button data-f="all">All</button><button data-f="lib">Library</button><button data-f="mine">Mine</button></div><div class="cl-sug" id="edChSug" role="listbox" aria-label="Chords"></div></div><div class="chshapes" id="edShapes"></div></div></div>
    </div>
    <div class="modal-foot nfoot"><span class="grow"></span><button class="mdexp" id="edExport" title="Export">${ic("download", 14)}<span>Export</span></button><button id="notesDone" title="Close">Close</button>
    </div>
  </div>
  <div class="modal-back top3" id="tabModal">
    <div class="modal tabed" role="dialog" aria-label="Tab editor">
      <div class="modal-head"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M1 2.5 H11 M1 4.8 H11 M1 7.1 H11 M1 9.4 H11" stroke-width="1.1"/><circle cx="4" cy="4.8" r="1.3" fill="currentColor" stroke="none"/><circle cx="8" cy="7.1" r="1.3" fill="currentColor" stroke="none"/></svg><input type="text" id="teName" class="tename" placeholder="Untitled Tab" maxlength="60" spellcheck="false" title="Name" /><select id="teList" class="telist" title="My Tabs"></select><button id="teNew" title="New">New Tab</button><button id="teSave" title="Save">Save</button><button id="teDel" class="danger" title="Delete">Delete</button><span class="grow"></span><span id="teTitle" hidden></span><button class="hbtn exit" id="teClose" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button></div>
      <div class="tebar">
        <label class="muted">Tuning <select id="teTuning"></select></label>
        <select id="teCapo" title="Capo"><option value="0">No Capo</option>${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">Capo ${i + 1}</option>`).join("")}</select>
        <span id="teCapoStr" class="sgrp capostr" role="group" aria-label="Capo strings" hidden></span>
        <label class="muted">Show <select id="teShow"><option value="fret">Finger Position</option><option value="note">Notes</option><option value="both">Notes and Finger Position</option></select></label>
        <label class="muted">Bars per Line <select id="tePer"><option>1</option><option>2</option><option>3</option><option>4</option><option>6</option><option>8</option></select></label>
        <div class="sgrp trgrp" role="group" aria-label="Transpose"><button id="teDown" class="arr" title="Transpose Down" aria-label="Transpose down a half step"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 4.6 L6 7.6 L9 4.6"/></svg></button><button id="teUp" class="arr" title="Transpose Up" aria-label="Transpose up a half step"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 7.4 L6 4.4 L9 7.4"/></svg></button></div>
        <span class="tsep"></span>
        <button id="teClear" title="Clear All">Clear All</button>
      </div>
      <div class="tebar">
        <button id="teAddBar" title="Add Bar">＋ Bar</button>
        <button id="teDelBar" title="Remove Bar">− Bar</button>
        <button id="teInsCol" title="Add Column">＋ Column</button>
        <button id="teDelCol" title="Remove Column">− Column</button>
        <span class="tsep"></span>
        <span class="muted">Add:</span>
        <button class="tq" data-tq="h" title="Hammer-on">h</button><button class="tq" data-tq="p" title="Pull-off">p</button><button class="tq" data-tq="/" title="Slide Up">/</button><button class="tq" data-tq="\\" title="Slide Down">\\</button><button class="tq" data-tq="b" title="Bend">b</button><button class="tq" data-tq="r" title="Release">r</button><button class="tq" data-tq="~" title="Vibrato">~</button><button class="tq" data-tq="x" title="Muted">x</button>
      </div>
      <div class="modal-body">
        <div id="teGrid"></div>
        <div class="muted tehelp">Type frets · Arrows move · Tab: next · Delete: empty · Ctrl+Enter: insert</div>
        <div class="err" id="teErr"></div>
      </div>
      <div class="modal-foot"><span class="muted grow" id="teInfo"></span><button id="teExport" class="mdexp" title="Export" data-menu-btn="1">${ic("download", 14)}<span>Export</span></button><button class="primary" id="teOk">Insert Tab into Editor</button><button id="teCancel">Close</button></div>
    </div>
  </div>
  <div class="modal-back top2" id="scaleModal">
    <div class="modal scalemod" role="dialog" aria-label="Chords, Scales, and Tabs">
      <div class="modal-head">${ic("scales", 16)}<span>Chords, Scales, and Tabs</span><button class="hbtn" id="scSideBtn" title="Hide the List" aria-pressed="false"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><rect x="1.3" y="2" width="9.4" height="8" rx="1.2"/><path d="M4.4 2 V10"/><path class="scside-ar" d="M3.4 4.8 L2.4 6 L3.4 7.2"/></svg></button><div class="sgrp sctabs" id="scTabs" role="tablist"><button data-tab="chords" role="tab">Chords</button><button data-tab="scales" role="tab">Scales</button><button data-tab="tabs" role="tab">Tabs</button><button data-tab="caged" role="tab">CAGED</button><button data-tab="circle" role="tab">Circle of Fifths</button></div><span class="grow"></span><button class="hbtn exit" id="scClose" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button></div>
      <div class="scwrap scpane" id="scPaneScales">
        <div class="scside">
          <input type="search" id="scSearch" placeholder="Find a Scale" title="Search" />
          <button class="newbtn" id="scNew" title="Customize">Customize Scale</button>
          <div class="sgrp scfilter" id="scFilter" role="group" aria-label="Show"><button data-f="all">All</button><button data-f="lib">Library</button><button data-f="mine">Mine</button></div>
          <div class="sclist" id="scList" role="listbox" aria-label="Scales"></div>
        </div>
        <div class="scmain">
          <div class="scbar">
            <div class="sgrp" id="scInstr" role="group" aria-label="Instrument"><button data-v="guitar">Guitar</button><button data-v="bass">Bass</button></div>
            <select id="scTuning" title="Tuning"></select>
            <label class="muted">Root <select id="scRoot"></select></label>
            <div class="sgrp trgrp" role="group" aria-label="Transpose"><button data-tr="-1" data-for="scales" class="arr" title="Transpose Down" aria-label="Transpose down a half step"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 4.6 L6 7.6 L9 4.6"/></svg></button><button data-tr="1" data-for="scales" class="arr" title="Transpose Up" aria-label="Transpose up a half step"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 7.4 L6 4.4 L9 7.4"/></svg></button></div>
            <span class="grow"></span>
            <div class="sgrp" id="scLabels" role="group" aria-label="Labels"><button data-v="notes" title="Notes">Notes</button><button data-v="intervals" title="Intervals">Intervals</button><button data-v="none" title="Dots">None</button></div>
          </div>
          <div class="sctitle"><span id="scName"></span><span class="scnotes" id="scNotes"></span><span class="scformula" id="scFormula"></span></div>
          <div class="scrows"><div class="scrowsl">
          <div class="scbar sctight">
            <span class="sclbl">Patterns</span>
            <div class="sgrp" id="scPos" role="group" aria-label="Pattern"></div>
            <label class="chk sctog" title="Sticky"><input type="checkbox" id="scStick" /> Sticky</label>
            <span class="sclbl">Strings</span>
            <div class="sgrp scstr" id="scStrings" role="group" aria-label="Strings"></div>
          </div>
          <div class="scbar sctight">
            <span class="sclbl">Notes / string</span>
            <select id="scPer" title="Per String">${["Whole Pattern", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n, i) => `<option value="${i}">${i ? n + " per String" : n}</option>`).join("")}</select>
            <span class="sclbl">Frets</span>
            <select id="scFrets" title="Frets">${[18, 19, 20, 21, 22, 23, 24].map((n) => `<option value="${n}">${n}</option>`).join("")}</select>
            <span class="sclbl">Capo</span>
            <select id="scCapo" title="Capo">${Array.from({ length: 13 }, (_, i) => `<option value="${i}">${i ? "Capo " + i : "No Capo"}</option>`).join("")}</select>
            <label class="chk sctog" title="Show All"><input type="checkbox" id="scGhost" /> Show All</label>
            <button class="screset" id="scReset" title="Reset">↺ Reset</button>
          </div>
          </div><div class="sckey" id="scKey" title="Key signature"></div></div>
          <div class="scneck" id="scNeck"></div>
          <div class="md"><div class="sctab" id="scTab"></div></div>
        </div>
      </div>
      <div class="scwrap scpane chpane" id="scPaneChords">
        <div class="scside">
          <input type="search" id="chSearch" placeholder="Find a Chord" title="Search" />
          <button class="newbtn" id="chNew" title="Customize">Customize Chord</button>
          <div class="sgrp scfilter" id="chFilter" role="group" aria-label="Show"><button data-f="all">All</button><button data-f="lib">Library</button><button data-f="mine">Mine</button></div>
          <div class="sclist" id="chList" role="listbox" aria-label="Chords"></div>
        </div>
        <div class="scmain chmain">
          <div class="scbar">
            <label class="muted">Root <select id="chRoot"></select></label>
            <select id="chTuning" title="Tuning"></select>
            <div class="sgrp" id="chView" role="group" aria-label="Show"><button data-v="diagram">Diagrams</button><button data-v="text">Text</button></div>
          </div>
          <div class="chhead"><b id="chName"></b><span class="muted" id="chNotes"></span></div>
          <div class="chgrid" id="chShapes"></div>
          <div class="chacts"><button id="chDel" class="danger">Delete</button></div>
        </div>
      </div>
      <div class="scpane cfpane" id="scPaneCircle">
        <div class="cfleft"><div id="cfSvg"></div><div class="muted cfhint">Outer ring: major keys. Inner ring: relative minors.</div></div>
        <div class="cfinfo" id="cfInfo"></div>
      </div>
      <div class="scpane cgpane" id="scPaneCaged">
        <div class="scbar">
          <label class="muted">Chord <select id="cgRoot"></select></label>
          <div class="sgrp trgrp" role="group" aria-label="Transpose"><button data-tr="-1" data-for="caged" class="arr" title="Transpose Down" aria-label="Transpose down a half step"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 4.6 L6 7.6 L9 4.6"/></svg></button><button data-tr="1" data-for="caged" class="arr" title="Transpose Up" aria-label="Transpose up a half step"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 7.4 L6 4.4 L9 7.4"/></svg></button></div>
          <div class="sgrp" id="cgQual" role="group" aria-label="Major or minor"><button data-v="major">Major</button><button data-v="minor">Minor</button></div>
          <span class="grow"></span>
          <div class="sgrp" id="cgLabels" role="group" aria-label="Labels"><button data-v="notes">Notes</button><button data-v="intervals">Intervals</button><button data-v="none">None</button></div>
        </div>
        <div class="cgboxes" id="cgBoxes"></div>
        <div class="scneck" id="cgNeck"></div>
        <div class="cginfo" id="cgInfo"></div>
      </div>
      <div class="scwrap scpane tbpane" id="scPaneTabs">
        <div class="scside">
          <input type="search" id="tbSearch" placeholder="Find a Tab" title="Search" />
          <button class="newbtn" id="tbNew" title="New">New Tab</button>
          <div class="sclist" id="tbList" role="listbox" aria-label="Tabs"></div>
        </div>
        <div class="scmain chmain">
          <div class="chhead"><b id="tbName"></b><span class="muted" id="tbMeta"></span></div>
          <div class="md"><div class="sctab" id="tbView"></div></div>
          <div class="chacts"><button id="tbEdit" title="Edit">Edit</button><button id="tbDel" class="danger" title="Delete">Delete</button></div>
        </div>
      </div>
      <div class="modal-foot"><span class="muted grow" id="scInfo"></span><button id="scExport" class="mdexp" title="Export" data-menu-btn="1">${ic("download", 14)}<span>Export</span></button><span class="insgrp"><button class="primary" id="scInsert" aria-haspopup="menu">Insert into Editor <span class="caret">▾</span></button><span class="insmenu" id="scInsMenu" role="menu" hidden><button data-as="text" role="menuitem">As Text</button><button data-as="image" role="menuitem">As Image</button></span></span><button id="scDone">Close</button></div>
    </div>
  </div>
  <div class="modal-back" id="tunerModal">
    <div class="modal tunermod" role="dialog" aria-label="Tuner">
      <div class="modal-head"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M4.3 1.2 V5.3 a1.7 1.7 0 0 0 3.4 0 V1.2 M6 7 V10.8 M4.8 10.8 H7.2"/></svg><span class="grow">Tuner</span><button class="hbtn exit" id="tuClose" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button></div>
      <div class="tubar">
        <div class="sgrp" id="tuInstr" role="group" aria-label="Instrument"><button data-v="guitar">Guitar</button><button data-v="bass">Bass</button></div>
        <select id="tuCount" title="Strings"></select>
        <select id="tuTuning" title="Tuning"></select>
        <label class="muted">A4 <select id="tuA4" title="Pitch">${Array.from({ length: 21 }, (_, i) => `<option value="${430 + i}">${430 + i} Hz</option>`).join("")}</select></label>
      </div>
      <div class="sgrp tumode" id="tuMode" role="group" aria-label="Mode"><button data-v="listen" title="Microphone"><svg class="hico mic" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><rect x="4.4" y="1" width="3.2" height="5.8" rx="1.6"/><path d="M2.6 5.6 a3.4 3.4 0 0 0 6.8 0 M6 9 V11 M4.3 11 H7.7"/></svg><span>Microphone</span></button><button data-v="play" title="Play Tone"><svg class="hico mic" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M1.6 4.5 H3.6 L6.4 2.2 V9.8 L3.6 7.5 H1.6 Z M8.2 4.2 a2.6 2.6 0 0 1 0 3.6 M9.6 2.8 a4.6 4.6 0 0 1 0 6.4"/></svg><span>Play Tone</span></button></div>
      <div class="tudisp" id="tuDisp">
        <svg class="tumeter" id="tuMeter" viewBox="0 0 300 150" width="300" height="150" aria-hidden="true"></svg>
        <div class="tunote"><b id="tuNote">–</b><span id="tuCents"></span></div>
        <div class="tumsg" id="tuMsg"></div>
      </div>
      <div class="tustrings" id="tuStrings" role="group" aria-label="Strings"></div>
      <div class="tuopts" id="tuOpts"><div class="sgrp" id="tuSound" role="group" aria-label="Sound"><button data-v="repeat" title="Pluck">Pluck</button><button data-v="constant" title="Constant">Constant</button></div></div>
      <div class="tuopts tuvol"><label class="muted" title="Volume">Volume <input type="range" id="tuVol" min="0" max="100" step="1" /></label></div>
      <div class="modal-foot"><span class="muted grow" id="tuInfo"></span><button id="tuDone">Close</button></div>
    </div>
  </div>
  <div class="modal-back top3" id="gkModal">
    <div class="modal lymod" role="dialog" aria-label="Guess Key">
      <div class="modal-head"><svg class="hico mic" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><circle cx="3.6" cy="6" r="2.3"/><path d="M5.9 6 H11 M9.3 6 V8 M10.9 6 V7.6"/></svg><span class="grow">Guess Key</span><button class="hbtn exit" id="gkClose" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button></div>
      <div class="modal-body lybody gkbody" id="gkBody"></div>
      <div class="modal-foot"><span class="grow"></span><button class="primary" id="gkIns">Insert Key</button><button id="gkCancel">Close</button></div>
    </div>
  </div>
  <div class="modal-back top3" id="lyModal">
    <div class="modal lymod" role="dialog" aria-label="Guess Lyrics">
      <div class="modal-head"><svg class="hico mic" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><rect x="4.4" y="1" width="3.2" height="5.8" rx="1.6"/><path d="M2.6 5.6 a3.4 3.4 0 0 0 6.8 0 M6 9 V11 M4.3 11 H7.7"/></svg><span class="grow">Guess Lyrics</span><button class="hbtn exit" id="lyClose" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button></div>
      <div class="modal-body lybody"><div id="lyBody"></div><label class="chk lyopt" id="lyOpt" title="Timestamps"><input type="checkbox" id="lyTimes" /> Include Timestamps</label></div>
      <div class="modal-foot"><span class="grow"></span><button class="primary" id="lyGo">Guess Lyrics</button><button id="lyCancel">Close</button></div>
    </div>
  </div>
  <div class="modal-back top3" id="linksModal">
    <div class="modal linksmod" role="dialog" aria-label="Links">
      <div class="modal-head">${ic("link", 16)}<span class="grow" id="lkTitle">Links</span><button class="hbtn exit" id="lkClose" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button></div>
      <div class="modal-body lkbody">
        <div class="lklist" id="lkList"></div>
        <div class="lkform">
          <b id="lkFormTitle">Add a Link</b>
          <label class="muted">Name<input type="text" id="lkName" spellcheck="false" maxlength="100" /></label>
          <label class="muted">Address<input type="text" id="lkUrl" spellcheck="false" /></label>
          <label class="muted">Comment (optional)<input type="text" id="lkNote" spellcheck="false" maxlength="300" /></label>
          <div class="row"><span class="grow"></span><button id="lkCancelEdit" hidden>Cancel</button><button class="primary" id="lkOk">Add Link</button></div>
        </div>
      </div>
      <div class="modal-foot"><span class="grow"></span><button id="lkDone">Close</button></div>
    </div>
  </div>
  <div class="modal-back top3" id="scEdModal">
    <div class="modal semod" role="dialog" aria-label="Customize Scale">
      <div class="modal-head">${ic("scales", 16)}<span class="grow" id="seTitle">Customize Scale</span><button class="hbtn exit" id="seClose" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button></div>
      <div class="modal-body sebody">
        <div class="serow"><label class="muted">Name<input type="text" id="seName" maxlength="60" spellcheck="false" /></label><span class="grow"></span><span class="muted" id="sePreview"></span><button id="seReset" title="Reset">Reset</button></div>
        <div class="sefret" id="seFret"></div>
      </div>
      <div class="modal-foot"><button id="seDel" class="danger">Delete</button><span class="grow"></span><button id="seCancel">Cancel</button><button class="primary" id="seSave">Save</button></div>
    </div>
  </div>
  <div class="modal-back top3" id="shapeModal">
    <div class="modal shapemod" role="dialog" aria-label="Chord fingering">
      <div class="modal-head">${ic("chord", 16)}<span class="grow" id="shTitle">Fingering</span><button class="hbtn exit" id="shClose" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button></div>
      <div class="modal-body shbody">
        <div class="shleft"><div id="shEdit" class="shedit" tabindex="0"></div></div>
        <div class="shside">
          <label class="muted">Chord Name<input type="text" id="shName" spellcheck="false" maxlength="30" title="Name" /></label>
          <label class="muted">Frets, Low E to High e<input type="text" id="shFrets" spellcheck="false" title="Frets" /></label>
          <div class="row"><span class="muted grow">Start Fret</span><button class="small" id="shBaseDown" title="Lower">−</button><b id="shBase">1</b><button class="small" id="shBaseUp" title="Higher">+</button></div>
          <div class="row"><span class="muted grow">Capo</span><button class="small" id="shCapoDown" title="Capo Down">−</button><b id="shCapo">No Capo</b><button class="small" id="shCapoUp" title="Capo Up">+</button></div>
          <button id="shOther" title="Other Shape">↻ Other Shape</button>
          <button id="shReset" title="Reset">Standard Fingering</button>
        </div>
      </div>
      <div class="modal-foot"><span class="grow"></span><button id="shCancel">Cancel</button><button class="primary" id="shSave">Save</button></div>
    </div>
  </div>
  <div class="modal-back" id="helpModal">
    <div class="modal" role="dialog" aria-label="Help">
      <div class="modal-head"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><circle cx="6" cy="6" r="4.9"/><path d="M4.55 4.75 a1.5 1.5 0 1 1 2.1 1.35 c-.45 .22 -.65 .55 -.65 1.05"/><circle cx="6" cy="8.8" r=".45" fill="currentColor" stroke="none"/></svg><span class="grow">How to Use Guitar Playa Companion</span><button class="hbtn exit" id="helpClose" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button></div>
      <div class="modal-body help" id="helpBody"></div>
      <div class="modal-foot"><button class="danger resetbtn" id="resetOpen" title="Reset to Default"><svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M2.6 4.4 A4 4 0 1 1 2.2 7.4 M2.6 1.8 V4.4 H5.2"/></svg><span>Reset to Default…</span></button><span class="grow"></span><button id="helpDone">Close</button></div>
    </div>
  </div>
  <div class="modal-back top3" id="resetModal">
    <div class="modal lymod" role="dialog" aria-label="Reset to Default">
      <div class="modal-head"><svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M2.6 4.4 A4 4 0 1 1 2.2 7.4 M2.6 1.8 V4.4 H5.2"/></svg><span class="grow">Reset to Default</span><button class="hbtn exit" id="rsClose" title="Close"><svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9"/></svg></button></div>
      <div class="modal-body rsbody">
        <div class="rsopt">
          <div class="grow"><b>Reset Settings</b><p>Theme, where the panel sits, speed, metronome, tuner, editor, scale and chord choices go back to how they were at the start. Your saved videos, loops, pages, links, tabs, chords and scales are kept.</p></div>
          <button id="rsSettings">Reset Settings</button>
        </div>
        <div class="rsopt rsall">
          <div class="grow"><b>Erase Everything</b><p>Starts over completely: resets the settings <i>and</i> deletes every saved video, loop, page, link and picture, your tabs, and your own chords and scales. This can’t be undone. Export first to keep a copy.</p></div>
          <div class="rsbtns"><button id="rsExport" title="Export">${ic("download", 13)}<span>Export First</span></button><button class="rsdanger" id="rsAll">Erase Everything</button></div>
        </div>
      </div>
      <div class="modal-foot"><span class="grow"></span><button id="rsCancel">Cancel</button></div>
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
    if ($("collapse") && $("collapse").dataset.c !== String(!!state.settings.collapsed)) {
      $("collapse").innerHTML = colIcon;
      $("collapse").dataset.c = String(!!state.settings.collapsed);
    }
    if ($("collapse")) $("collapse").title = state.settings.collapsed ? "Restore" : "Minimize";

    setIfIdle($("aIn"), fmt(state.a));
    setIfIdle($("bIn"), fmt(state.b));
    const lb = $("loop");
    const reps = state.looping && state.loopCount > 0 ? ` ×${state.loopCount}` : "";
    lb.textContent = state.looping ? (state.waiting ? `Loop: ON${reps} (pause…)` : `Loop: ON${reps}`) : "Loop: OFF";
    lb.title = "Loop";
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

    const mh = !!state.settings.metroHidden;
    $("metroSec").hidden = mh;
    $("metroShow").classList.toggle("off", mh);
    $("metroShow").title = "Metronome";
    $("metroShow").setAttribute("aria-pressed", String(!mh));
    const mo = state.settings.metroOpen !== false;
    if ($("metroSec").open !== mo) $("metroSec").open = mo;
    $("metroHint").textContent = mo ? "Hide" : "Show";
    $("metroSumRow").title = mo ? "Hide the metronome controls" : "Show the metronome controls";
    renderMetro();
    renderLibrary();
    renderSaveRow();

    if (!s.pos) placePanel();
    if (s.pos) {
      // where you dragged it, kept inside the window
      host.style.left = clamp(s.pos.left, 0, Math.max(0, window.innerWidth - 60)) + "px";
      host.style.top = clamp(s.pos.top, 0, Math.max(0, window.innerHeight - 30)) + "px";
      host.style.right = "auto";
      host.style.bottom = "auto";
    }
    renderMarks();
  }

  // where the panel starts: upper right, in the space beside the video (over the suggestions), not over the video
  function placePanel() {
    if (state.settings.pos) return;
    const pw = root.querySelector(".panel")?.offsetWidth || 348, ph = Math.min(root.querySelector(".panel")?.offsetHeight || 600, innerHeight);
    const pl = document.querySelector("#movie_player") || document.querySelector("video[data-ygc-main]") || document.querySelector("video");
    const r = pl ? pl.getBoundingClientRect() : null;
    let left = innerWidth - pw - 16, top = 72;
    if (r && r.width) {
      const room = innerWidth - r.right;
      if (room >= pw + 16) left = Math.round(r.right + (room - pw) / 2); // centred in the space right of the video
      top = Math.max(64, Math.round(r.top));
    }
    top = Math.max(0, Math.min(top, innerHeight - Math.min(ph, innerHeight - 8) - 8));
    host.style.left = Math.max(0, left) + "px";
    host.style.top = top + "px";
    host.style.right = "auto";
    host.style.bottom = "auto";
  }
  window.addEventListener("resize", () => !state.settings.pos && placePanel());

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
    }
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
  };
  $("delayDown").onclick = (e) => setDelay((+state.settings.delay || 0) - (e.shiftKey ? 2 : 0.5));
  $("delayUp").onclick = (e) => setDelay((+state.settings.delay || 0) + (e.shiftKey ? 2 : 0.5));
  $("delay").addEventListener("change", (e) => {
    state.settings.delay = clamp(+e.target.value || 0, 0, 10);
    persist();
    render();
  });
  if ($("collapse")) $("collapse").onclick = () => {
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
  $("metroShow").onclick = () => {
    state.settings.metroHidden = !state.settings.metroHidden;
    if (state.settings.metroHidden && metro.on) stopMetro();
    persist();
    render();
  };
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
        e.links = (Array.isArray(e.links) ? e.links : [])
          .filter((k) => k && typeof k.url === "string" && /^https?:\/\//i.test(k.url))
          .map((k) => ({ id: k.id || newId(), name: String(k.name || ""), url: k.url, comment: String(k.comment || ""), createdAt: k.createdAt || Date.now(), updatedAt: k.updatedAt || Date.now() }));
        if (e.drawing != null)
          e.drawing = Array.isArray(e.drawing)
            ? e.drawing.filter((k) => k && Array.isArray(k.p) && k.p.length >= 2 && k.p.every(Number.isFinite)).map((k) => ({ t: String(k.t || "pen"), c: String(k.c || "ink"), s: String(k.s || "m"), p: k.p }))
            : [];
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
        notes: e.notes || "",
        links: [],
        createdAt: t,
        updatedAt: t,
        loops: [
          { id: newId(), name: "Loop 1", a: e.a ?? null, b: e.b ?? null, looping: !!e.looping, speed: e.speed ?? 1, delay: e.delay ?? 0, metro: e.metro || {}, createdAt: t, updatedAt: t },
        ],
      });
    }
    return out;
  }
  // a video's loops stay in the order you give them (drag them in the loop list); new loops go at the end
  const sortLoops = () => {};
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
  }
  function deleteLoop(v, l, msg) {
    v.loops = v.loops.filter((x) => x.id !== l.id);
    if (v.videoId === state.videoId && state.loopId === l.id) state.loopId = null;
    v.updatedAt = Date.now();
    nameEdited = false;
    persist();
    saveLibrary();
    renderLibrary(true);
  }
  // save the video itself (no loop needed): the disk button left of the video's name, or Save in its list
  function saveVideo(quiet) {
    if (!state.videoId) return flash("Open a video first");
    if (videoEntry()) return;
    const now = Date.now();
    library = [{ id: newId(), videoId: state.videoId, title: videoTitle(), name: videoTitle(), desc: "", createdAt: now, updatedAt: now, loops: [] }, ...library];
    expanded.add(library[0].id);
    persist(); // now that it's saved, where you are in it (A, B, speed) is kept too
    saveLibrary();
    renderLibrary(true);
    if (!quiet) flash("Video saved");
  }
  // delete a saved video with its loops, page and links (the bin left of the video's name, or Saved Videos)
  function deleteVideo(v) {
    if (!v) return;
    library = library.filter((x) => x.id !== v.id);
    if (v.videoId === state.videoId) state.loopId = null;
    if (notesVid === v.videoId) {
      notesDirty = false;
      closeNotes();
    }
    if (lkVid === v.videoId) closeLinks();
    store.remove("video:" + v.videoId);
    saveLibrary();
    renderLibrary(true);
  }
  function stepLoop(dir) {
    const ls = curLoops();
    if (!ls.length) return;
    const i = ls.findIndex((l) => l.id === state.loopId);
    const j = i < 0 ? (dir > 0 ? 0 : ls.length - 1) : (i + dir + ls.length) % ls.length;
    applyLoop(ls[j]);
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
    if (p.range || p.seek != null) {
      // opened from a timestamp in the notes
      const v = getVideo();
      if (p.range) {
        state.loopId = null;
        state.a = round2(p.range[0]);
        state.b = round2(p.range[1]);
        state.looping = false;
        persist();
        toggleLoop(true);
        if (v && v.paused) v.play();
      } else if (v) {
        v.currentTime = p.seek;
        v.play();
      }
      if (p.notes) openNotes(id);
      return;
    }
    const ls = curLoops();
    const l = ls.find((x) => x.id === p.loopId) || ls[0];
    if (l) applyLoop(l);
  }

  // ----- the loop bar at the top of the panel -----
  // ＋ : start the next loop. Clears A and B (the A box shows where the video is until you press Set A).
  function newLoop() {
    state.loopId = null;
    state.a = state.b = null;
    state.looping = false;
    state.loopCount = 0;
    cancelWait();
    nameEdited = false;
    persist();
    render();
  }

  // ----- the loop list: pick a loop, delete one, or drag them into a different order -----
  let loopPop = null;
  let loopDelArm = null, loopDelTimer = null;
  const GRIP = '<svg class="hico" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M4.3 2.6 h.01 M7.7 2.6 h.01 M4.3 6 h.01 M7.7 6 h.01 M4.3 9.4 h.01 M7.7 9.4 h.01" stroke-width="2.2"/></svg>';
  function closeLoopPop() {
    if (!loopPop) return false;
    loopPop.remove();
    loopPop = null;
    loopDelArm = null;
    $("loopSel").classList.remove("open");
    return true;
  }
  function openLoopPop() {
    if (closeLoopPop() || !state.videoId) return;
    loopPop = el("div", "lpop");
    loopPop.setAttribute("role", "listbox");
    root.append(loopPop);
    renderLoopPop();
    const r = $("loopSel").getBoundingClientRect();
    const w = Math.max(r.width, 250);
    loopPop.style.minWidth = w + "px";
    const m = loopPop.getBoundingClientRect();
    loopPop.style.left = clamp(r.left, 8, innerWidth - m.width - 8) + "px";
    loopPop.style.top = (r.bottom + 4 + m.height < innerHeight ? r.bottom + 4 : Math.max(8, r.top - m.height - 4)) + "px";
    $("loopSel").classList.add("open");
    // drag to reorder
    loopPop.addEventListener("dragstart", (e) => {
      const row = e.target.closest(".lp-row[data-id]");
      if (!row) return;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.dataset.id);
    });
    loopPop.addEventListener("dragover", (e) => {
      e.preventDefault();
      const dragged = loopPop && loopPop.querySelector(".dragging");
      const row = e.target.closest(".lp-row[data-id]");
      if (!dragged || !row || row === dragged) return;
      const rr = row.getBoundingClientRect();
      row[e.clientY > rr.top + rr.height / 2 ? "after" : "before"](dragged);
    });
    loopPop.addEventListener("drop", (e) => e.preventDefault());
    loopPop.addEventListener("dragend", () => {
      if (!loopPop) return;
      const v = videoEntry();
      const ids = [...loopPop.querySelectorAll(".lp-row[data-id]")].map((x) => x.dataset.id);
      if (v && ids.join() !== v.loops.map((l) => l.id).join()) {
        v.loops = ids.map((id) => v.loops.find((l) => l.id === id)).filter(Boolean);
        v.updatedAt = Date.now();
        saveLibrary();
      }
      renderLoopPop();
    });
  }
  let lpRename = false;
  function renderLoopPop() {
    if (!loopPop) return;
    const ve = videoEntry();
    const ls = ve ? ve.loops : [];
    loopPop.innerHTML = "";
    const vrow = el("div", "lp-row lp-vid" + (!selectedLoop() ? " sel" : ""));
    vrow.title = "Whole Video";
    if (lpRename) {
      // the video's name, edited right here; Enter or the disk saves it (and saves the video if it isn't yet)
      const inp = el("input", "lp-ren");
      inp.type = "text";
      inp.maxLength = 120;
      inp.value = (ve && (ve.name || ve.title)) || videoTitle() || "";
      inp.setAttribute("aria-label", "Video name");
      const done = (keep) => {
        if (!lpRename) return;
        lpRename = false;
        const name = inp.value.trim().replace(/\s+/g, " ");
        if (keep && name) {
          let v = videoEntry();
          if (!v) {
            saveVideo(true);
            v = videoEntry();
          }
          if (v && name !== v.name) {
            v.name = name;
            v.updatedAt = Date.now();
            saveLibrary();
            renderLibrary(true);
          }
          flash(ve ? "Name saved" : "Video saved");
        }
        renderLoopPop();
        render();
      };
      inp.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.preventDefault(), done(true);
        else if (e.key === "Escape") e.preventDefault(), done(false);
      });
      // clicking away keeps a new name for a saved video; an unsaved video is only saved with Enter or the disk
      inp.addEventListener("blur", () => done(!!ve));
      inp.addEventListener("click", (e) => e.stopPropagation());
      const ok = el("button", "lp-del lp-edit lp-ok");
      ok.innerHTML = DISK;
      ok.title = ve ? "Save Name" : "Save Video";
      ok.setAttribute("aria-label", ok.title);
      ok.addEventListener("mousedown", (e) => e.preventDefault()); // keep the typing box focused until the click
      ok.addEventListener("click", (e) => {
        e.stopPropagation();
        done(true);
      });
      vrow.append(inp, ok);
      setTimeout(() => (inp.focus(), inp.select()), 0);
    } else {
      vrow.append(el("span", "lp-name", (ve && (ve.name || ve.title)) || videoTitle() || "This video"));
      const ren = el("button", "lp-del lp-edit");
      ren.innerHTML = ICON.edit;
      ren.title = ve ? "Rename" : "Name and Save";
      ren.addEventListener("click", (e) => {
        e.stopPropagation();
        lpRename = true;
        renderLoopPop();
      });
      vrow.append(ren);
    }
    vrow.addEventListener("click", () => {
      if (lpRename) return;
      closeLoopPop();
      newLoop();
    });
    loopPop.append(vrow);
    // nothing saved yet (or no loops): a Save button right here
    if (!ve || !ls.length) {
      const sv = el("button", "lp-save primary");
      sv.innerHTML = '<svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M2 2 h6.6 L10 3.4 V10 H2 Z M4 2 v2.4 h3.6 V2 M3.8 10 V7.2 h4.4 V10"/></svg>';
      const asLoop = !!ve || loopValid();
      sv.append(el("span", "", !ve && !loopValid() ? "Save Video" : "Save Loop"));
      sv.title = "Save";
      sv.disabled = !!ve && !loopValid();
      if (sv.disabled) sv.title = "Set A and B";
      sv.addEventListener("click", (e) => {
        e.stopPropagation();
        closeLoopPop();
        if (asLoop && loopValid()) saveLoop(false);
        else saveVideo();
        render();
      });
      loopPop.append(sv);
    }
    if (ls.length) loopPop.append(el("div", "lp-sep"));
    ls.forEach((l, k) => {
      const row = el("div", "lp-row" + (l.id === state.loopId ? " sel" : ""));
      row.dataset.id = l.id;
      row.setAttribute("role", "option");
      if (ls.length > 1) {
        row.draggable = true;
        const g = el("span", "lp-grip");
        g.innerHTML = GRIP;
        g.title = "Move";
        row.append(g);
      }
      const nm = el("span", "lp-name");
      nm.append(el("b", "", `${k + 1}. ${l.name}`), el("small", "", `${fmtRange(l)} · ${fmtSpeed(l.speed ?? 1)}`));
      row.append(nm);
      const ed = el("button", "lp-del lp-edit");
      ed.innerHTML = ICON.edit;
      ed.title = "Edit Loop";
      ed.addEventListener("click", (e) => {
        e.stopPropagation();
        closeLoopPop();
        openLoopEditor(state.videoId, l.id);
      });
      row.append(ed);
      const armed = loopDelArm === l.id;
      const del = el("button", "lp-del" + (armed ? " confirm" : ""));
      del.innerHTML = armed ? "Delete?" : ICON.del;
      del.title = armed ? "Confirm" : "Delete";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        clearTimeout(loopDelTimer);
        if (loopDelArm === l.id) {
          loopDelArm = null;
          deleteLoop(videoEntry(), l);
        } else {
          loopDelArm = l.id;
          loopDelTimer = setTimeout(() => {
            loopDelArm = null;
            renderLoopPop();
          }, 3000);
        }
        renderLoopPop();
      });
      row.append(del);
      row.addEventListener("click", () => {
        closeLoopPop();
        const cur = curLoops().find((x) => x.id === l.id);
        if (cur) applyLoop(cur);
      });
      loopPop.append(row);
    });
  }
  $("loopSel").addEventListener("click", openLoopPop);
  window.addEventListener(
    "mousedown",
    (e) => {
      if (!loopPop) return;
      const path = e.composedPath();
      if (!path.includes(loopPop) && !path.includes($("loopSel"))) closeLoopPop();
    },
    true
  );
  $("saveCur").onclick = () => loopValid() && saveLoop(false);
  // left of the video's name: 💾 saves the video; once saved it's a bin that deletes it (click twice)
  const DISK = '<svg class="hico" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M2 2 h6.6 L10 3.4 V10 H2 Z M4 2 v2.4 h3.6 V2 M3.8 10 V7.2 h4.4 V10"/></svg>';
  let vidDelArm = false, vidDelTimer = null;
  function renderVidSave() {
    const b = $("vidSave"), ve = videoEntry();
    const mode = !ve ? "unsaved" : vidDelArm ? "confirm" : "saved";
    if (b.dataset.m !== mode) {
      b.dataset.m = mode;
      b.className = "small vidsave " + mode;
      b.innerHTML = mode === "unsaved" ? DISK : mode === "confirm" ? ICON.del + "<span>Delete?</span>" : ICON.del;
    }
    const n = ve ? ve.loops.length : 0;
    b.title =
      mode === "unsaved"
        ? "Save Video"
        : mode === "confirm"
          ? "Click again to delete this video" + (n ? ` and its ${n === 1 ? "loop" : n + " loops"}` : "")
          : "Delete Video";
    b.setAttribute("aria-label", b.title);
  }
  $("vidSave").onclick = () => {
    const ve = videoEntry();
    clearTimeout(vidDelTimer);
    if (!ve) {
      vidDelArm = false;
      saveVideo();
    } else if (!vidDelArm) {
      vidDelArm = true; // ask first: deleting also removes the loops, the page and the links
      vidDelTimer = setTimeout(() => ((vidDelArm = false), renderVidSave()), 3000);
    } else {
      vidDelArm = false;
      deleteVideo(ve);
      flash("Video deleted");
    }
    render();
  };
  $("impBtn").onclick = () => $("libFile").click();
  $("saveNew").onclick = newLoop;
  // the metronome section can be folded away; remember the choice (open by default)
  $("metroSec").addEventListener("toggle", () => {
    if (state.settings.metroOpen === $("metroSec").open) return;
    state.settings.metroOpen = $("metroSec").open;
    store.set("settings", state.settings); // save right away
    render();
  });
  function renderSaveRow() {
    if (!state.videoId) return;
    const nb = $("notesBtn");
    nb.style.display = NL ? "" : "none";
    nb.classList.toggle("has", hasNotes(videoEntry()));
    nb.classList.toggle("open", notesOpen() && notesVid === state.videoId);
    const ls = curLoops();
    const i = ls.findIndex((l) => l.id === state.loopId);
    // the loop list button: shows the loop you're on (or the video when none is picked)
    const ve = videoEntry();
    const lab = !ve ? videoTitle() || "This video" : i >= 0 ? `${i + 1}. ${ls[i].name}` : ve.name || ve.title || "This video";
    if ($("loopSelLab").textContent !== lab) $("loopSelLab").textContent = lab;
    $("loopSel").disabled = false;
    renderVidSave();
    $("loopEdit").disabled = i < 0;
    $("loopSel").title = "Loops";
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
    const key = `${mode}|${label}`;
    if (btn.dataset.s !== key) {
      btn.innerHTML = (green ? '<svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M2.4 6.3 L5 8.7 L9.6 3.5"/></svg>' : '<svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M2 2 h6.6 L10 3.4 V10 H2 Z M4 2 v2.4 h3.6 V2 M3.8 10 V7.2 h4.4 V10"/></svg>') + `<span>${label}</span>`;
      btn.dataset.s = key;
    }
    btn.title = tip;
    $("saveNew").disabled = i < 0; // available once a loop is saved (and picked)
    $("saveNew").title = "New Loop";
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
    play: '<svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M3.6 2.2 L9.6 6 L3.6 9.8 Z"/></svg>',
    edit: '<svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M8.2 1.8 l2 2 L4.4 9.6 L1.8 10.2 L2.4 7.6 Z M7 3 l2 2"/></svg>',
    del: '<svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M2 3.2 h8 M4.6 3.2 V2 h2.8 v1.2 M3 3.2 l.6 7 h4.8 l.6 -7 M5 5 v3.6 M7 5 v3.6"/></svg>',
    notes: '<svg class="hico" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><path d="M3 1.5 H7.5 L9.5 3.5 V10.5 H3 Z M7.5 1.5 V3.5 H9.5 M4.6 5.6 H7.9 M4.6 7.3 H7.9 M4.6 9 H6.6"/></svg>',
  };
  const SORTS = { custom: "My Order", newest: "Newest First", oldest: "Oldest First", az: "Name A–Z", za: "Name Z–A" };
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
  const anyModalOpen = () => !!loopPop || !!exPop || !!lnPop || ["resetModal", "lyModal", "gkModal", "tunerModal", "linksModal", "scEdModal", "shapeModal", "libModal", "helpModal", "loopModal", "tabModal", "scaleModal", "notesWin"].some((id) => $(id).classList.contains("show"));
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
    const ok = el("button", "primary", "Save Changes");
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
    $("libSort").value = sortMode();
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
      b.title = "Save Video";
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
    const view = viewList().filter((v) => !q || has(v.name) || has(v.title) || has(v.desc) || has(v.notes) || loopHit(v));
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
      pick.title = "Open";
      const meta = el("div", "meta");
      meta.append(el("div", "name", v.name || v.title));
      if (v.desc) meta.append(el("div", "desc", v.desc));
      const n = v.loops.length;
      meta.append(el("div", "sub", `${here ? "This video · " : ""}${n ? `${n} loop${n === 1 ? "" : "s"}` : "no loops"}${hasNotes(v) ? " · editor" : ""} · saved ${fmtDate(v.updatedAt)}`));
      pick.append(img, meta);
      pick.addEventListener("click", () => openSaved(v.videoId, here ? state.loopId : v.loops[0]?.id));

      const acts = el("div", "acts");
      const open = expanded.has(v.id);
      const tog = iconBtn(open ? ICON.down : ICON.right, open ? "Hide loops" : "Show loops", () => {
        open ? expanded.delete(v.id) : expanded.add(v.id);
        renderLibrary(true);
      });
      const nbtn = iconBtn(ICON.notes, "Open the editor for this video", () => {
        closeLib();
        openNotes(v.videoId);
      }, hasNotes(v) ? "notesbtn has" : "notesbtn");
      if (!NL) nbtn.style.display = "none";
      acts.append(
        tog,
        nbtn,
        iconBtn(ICON.edit, "Edit title and description", () => {
          editing = { kind: "video", id: v.id };
          confirmDel = null;
          renderLibrary(true);
        }),
        iconBtn(ICON.del, "Delete this video and all its loops", () => {
          deleteVideo(v);
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
              editForm([{ label: "Loop Name", value: l.name, max: 80 }], ([name]) => {
                l.name = name || l.name;
                l.updatedAt = Date.now();
                if (here && l.id === state.loopId) nameEdited = false;
              })
            );
            loops.append(row);
            return;
          }
          const lp = el("div", "lpick");
          lp.title = "Edit";
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
  $("libSort").addEventListener("change", (e) => {
    state.settings.libSort = e.target.value;
    persist();
    renderLibrary(true);
  });
  $("libSearch").addEventListener("input", () => renderLibrary(true));

  // ----- saving a file: Chrome's Save dialog, so you choose the folder and the name -----
  // The type (and so the extension) is fixed: a name typed without it gets it added back.
  // makeBlob runs after you pick the place (it may take a moment, e.g. gathering pictures).
  const safeName = (s, dflt) => String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || dflt;
  async function saveFileAs(name, ext, mime, desc, makeBlob) {
    const base = safeName(String(name).replace(new RegExp("\\." + ext + "$", "i"), ""), "export");
    const fileName = `${base}.${ext}`;
    if (typeof window.showSaveFilePicker === "function") {
      let handle = null;
      try {
        handle = await window.showSaveFilePicker({ suggestedName: fileName, types: [{ description: desc, accept: { [mime]: ["." + ext] } }], excludeAcceptAllOption: true });
      } catch (e) {
        if (e && e.name === "AbortError") return false; // you closed the dialog
        handle = null; // the dialog isn't allowed here: download it instead
      }
      if (handle) {
        try {
          const blob = await makeBlob();
          const w = await handle.createWritable();
          await w.write(blob);
          await w.close();
          flash(`Saved ${handle.name || fileName}`);
          return true;
        } catch (e) {
          flash("Couldn't save the file");
          return false;
        }
      }
    }
    const blob = await makeBlob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return true;
  }

  // ----- export / import (every saved video and loop has a unique id, so duplicates are skipped) -----
  const FILE_APP = "YouTube Guitar Playa Companion";
  async function exportLibrary() {
    if (!library.length && !Object.keys(chordShapesMap).length && !customScales.length && !myTabs.length) return flash("Nothing saved to export yet");
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    await saveFileAs(`guitar-playa-companion-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, "gpyc", "application/json", "Guitar Playa Companion export", async () => {
      const data = { app: FILE_APP, format: 1, exportedAt: new Date().toISOString(), videos: library, chordShapes: chordShapesMap, scales: customScales, tabs: myTabs, images: await imagesFor(library) };
      return new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    });

  }
  const sameLoop = (x, y) =>
    x.id === y.id || (x.name === y.name && (x.a ?? null) === (y.a ?? null) && (x.b ?? null) === (y.b ?? null) && (x.speed ?? 1) === (y.speed ?? 1));
  async function importFiles(files) {
    let newVideos = 0, newLoops = 0, dups = 0, badFiles = 0, newNotes = 0;
    for (const f of files) {
      let vids = null;
      try {
        const data = JSON.parse(await f.text());
        vids = Array.isArray(data) ? data : Array.isArray(data && data.videos) ? data.videos : null;
        // chord fingerings in the file: add the ones you don't have
        if (vids && data && data.chordShapes && typeof data.chordShapes === "object") {
          let added = 0;
          for (const [k, v] of Object.entries(data.chordShapes))
            if (!chordShapesMap[k] && v && Array.isArray(v.frets) && v.frets.length === 6) (chordShapesMap[k] = v), added++;
          if (added) store.set("chordShapes", chordShapesMap), NL && NL.setCustomChords(chordShapesMap);
        }
        // your own scales: add the ones you don't have
        if (vids && data && Array.isArray(data.scales)) {
          let added = 0;
          for (const x of data.scales)
            if (x && typeof x.name === "string" && typeof x.formula === "string" && /^[1-7b# ]+$/.test(x.formula) && !customScales.some((y) => y.id === x.id || (y.name === x.name && y.formula === x.formula)))
              customScales.push({ id: String(x.id || "my-" + newId()), name: x.name.slice(0, 60), formula: x.formula }), added++;
          if (added) saveCustomScales();
        }
        // your tabs: add the ones you don't have
        if (vids && data && Array.isArray(data.tabs)) {
          let added = 0;
          for (const x of data.tabs)
            if (x && typeof x.name === "string" && typeof x.text === "string" && !myTabs.some((y) => y.id === x.id || (y.name === x.name && y.text === x.text)))
              myTabs.push({ id: String(x.id || newId()), name: x.name.slice(0, 60), text: x.text, capo: clamp(+x.capo || 0, 0, 12), perLine: +x.perLine || 2 }), added++;
          if (added) saveMyTabs();
        }
        // pictures used in the pages
        if (vids && data && data.images && typeof data.images === "object")
          for (const [id, d] of Object.entries(data.images))
            if (/^[a-z0-9]{1,40}$/.test(id) && typeof d === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/.test(d) && !(await loadImage(id))) {
              imgCache.set(id, d);
              store.set("img:" + id, d);
            }
      } catch (e) {}
      if (!vids) {
        badFiles++;
        continue;
      }
      vids = vids.filter((v) => v && typeof v.videoId === "string" && /^[\w-]{1,64}$/.test(v.videoId));
      for (const v of normalize(vids)) {
        const have = library.find((x) => x.id === v.id) || library.find((x) => x.videoId === v.videoId);
        if (!have) {
          library.push({ ...v, loops: v.loops.map((l) => ({ ...l })), links: v.links.map((k) => ({ ...k })) });
          newVideos++;
          if (hasNotes(v)) newNotes++;
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
        // notes: take them if you have none; otherwise add them below yours, unless you already have them
        let notesAdded = false;
        if (hasNotes(v)) {
          if (!hasNotes(have)) {
            have.notes = v.notes;
            notesAdded = true;
          } else if (!have.notes.includes(v.notes.trim())) {
            have.notes = have.notes.replace(/\s+$/, "") + "\n\n— Imported —\n\n" + v.notes.trim() + "\n";
            notesAdded = true;
          }
          if (notesAdded) {
            have.notesUpdatedAt = Date.now();
            newNotes++;
          }
        }
        if ((!have.drawing || !have.drawing.length) && v.drawing && v.drawing.length) have.drawing = v.drawing;
        if (Array.isArray(v.sideChords)) have.sideChords = [...new Set([...(have.sideChords || []), ...v.sideChords])];
        // links: add the ones whose address you don't have yet
        have.links = have.links || [];
        let linksAdded = 0;
        for (const k of v.links) if (!have.links.some((x) => x.url === k.url)) have.links.push({ ...k }), linksAdded++;
        if (!v.loops.length && !notesAdded && !linksAdded) dups++; // the same video, nothing new in it
        if (!have.desc && v.desc) have.desc = v.desc;
        newLoops += added;
        sortLoops(have);
      }
    }
    library.forEach(sortLoops);
    saveLibrary();
    renderLibrary(true);
    if (notesOpen() && !notesDirty && notesEntry() && notesTa.value !== (notesEntry().notes || "")) {
      notesTa.value = notesEntry().notes || "";
      renderPreview();
    }
    const parts = [];
    if (newVideos || newLoops || newNotes)
      parts.push(
        `Imported ${newVideos} video${newVideos === 1 ? "" : "s"} and ${newLoops} loop${newLoops === 1 ? "" : "s"}` +
          (newNotes ? `, with editor pages for ${newNotes} video${newNotes === 1 ? "" : "s"}` : "")
      );
    else parts.push("Nothing new to import");
    if (dups) parts.push(`skipped ${dups} duplicate${dups === 1 ? "" : "s"}`);
    if (badFiles) parts.push(`${badFiles} file${badFiles === 1 ? " wasn't" : "s weren't"} a saved-videos file`);
    flash(parts.join(", "), 4500);
  }
  $("libExport").onclick = exportLibrary;
  $("dlAll").onclick = exportLibrary;
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
    if (closeLoopPop()) return;
    if (closeActMenu()) return;
    if (closeExport()) return;
    if (closeLinkPop()) return;
    if (drawingOn) return setDrawing(false);
    if (closeMenu()) return notesTa.focus();
    if ($("resetModal").classList.contains("show")) return closeReset();
    if ($("linksModal").classList.contains("show")) return closeLinks();
    if ($("shapeModal").classList.contains("show")) return closeShapeEditor();
    if ($("scEdModal").classList.contains("show")) return closeScaleEditor();
    if ($("lyModal").classList.contains("show")) return closeLyricsAsk();
    if ($("gkModal").classList.contains("show")) return closeGuessKey();
    if ($("tunerModal").classList.contains("show")) return closeTuner();
    if ($("tabModal").classList.contains("show")) return closeTabEditor(); // the tab editor sits on top of the notes and the library
    if ($("scaleModal").classList.contains("show")) return closeScales();
    if ($("loopModal").classList.contains("show")) return closeLoopEditor(); // the editor sits on top; close it first
    if ($("libModal").classList.contains("show") || $("helpModal").classList.contains("show")) {
      closeLib();
      closeHelp();
      return;
    }
    closeNotes();
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
    $("leDel").innerHTML = ICON.del + "<span>Delete Loop</span>";
    $("loopModal").classList.add("show");
    setTimeout(() => {
      $("leName").focus();
      $("leName").select(); // type to rename
    }, 0);
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

  // ---------- notes: a Markdown page for each saved video, with guitar tab ----------
  // Stored as `notes` on the saved video (library entry), so it goes into Export/Import with the loops.
  const NL = globalThis.__ygcNotesLib || null;
  // The page editor: you type Markdown, but bold, headings, lists and links show formatted and their marks stay hidden.
  // The text (with the marks) is the model; every edit changes the text and draws it again.
  // notesTa behaves like a <textarea> (value, selectionStart/End, setSelectionRange …) so the rest of the code can use it.
  const notesTa = (() => {
    const elm = $("notesText");
    let text = "", hidden = [], sel = [0, 0], hist = [], fut = [], lastKind = "", lastAt = 0;
    const scroller = () => elm.parentElement;
    const draw = () => {
      const sc = scroller(), sx = sc.scrollLeft, sy = sc.scrollTop;
      const r = NL ? NL.liveMarkup(text) : { html: NL_esc(text), hidden: [] };
      elm.innerHTML = r.html + "<br data-end>";
      hidden = r.hidden;
      fillImages(elm);
      sc.scrollLeft = sx;
      sc.scrollTop = sy;
      sizeInk();
    };
    const NL_esc = (t) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
    const isMark = (n) => !!(n.parentElement && n.parentElement.closest(".mk, .bul"));
    const texts = () => {
      const out = [];
      const w = document.createTreeWalker(elm, NodeFilter.SHOW_TEXT);
      let n, at = 0;
      while ((n = w.nextNode())) {
        out.push({ n, at, len: n.data.length, mark: isMark(n) });
        at += n.data.length;
      }
      return out;
    };
    const offsetOf = (node, off) => {
      if (!elm.contains(node)) return null;
      if (node.nodeType !== 3) {
        // a position between children: count the text before that child
        const kids = node.childNodes;
        if (off >= kids.length) {
          const after = node === elm ? null : node;
          if (!after) return text.length;
          const r = document.createRange();
          r.selectNodeContents(elm);
          r.setEndAfter(after);
          return r.toString().length;
        }
        node = kids[off];
        off = 0;
        const r = document.createRange();
        r.selectNodeContents(elm);
        r.setEndBefore(node);
        return Math.min(text.length, r.toString().length);
      }
      for (const t of texts()) if (t.n === node) return t.at + Math.min(off, t.len);
      return null;
    };
    const readSel = () => {
      const s = root.getSelection ? root.getSelection() : document.getSelection();
      if (!s || !s.rangeCount) return null;
      const r = s.getRangeAt(0);
      if (!elm.contains(r.startContainer) || !elm.contains(r.endContainer)) return null;
      const a = offsetOf(r.startContainer, r.startOffset), b = offsetOf(r.endContainer, r.endOffset);
      return a == null || b == null ? null : [Math.min(a, b), Math.max(a, b)];
    };
    // a caret next to hidden marks goes outside them: after a closing ** or a bullet, not inside
    const norm = (p) => {
      for (let i = 0; i < 6; i++) {
        const h = hidden.find(([a, b, atomic, close]) => (p > a && p < b) || (p === a && (close || atomic)));
        if (!h) break;
        p = h[1];
      }
      return p;
    };
    const curSel = () => {
      if (root.activeElement === elm) {
        const r = readSel();
        if (r) sel = r[0] === r[1] && r[0] !== placedAt ? [norm(r[0]), norm(r[0])] : r;
      }
      return sel;
    };
    // put the caret at a text offset, on the visible side of any hidden marks
    const place = (p) => {
      const ts = texts();
      let best = null;
      for (const t of ts) {
        if (p < t.at || p > t.at + t.len) continue;
        if (!t.mark) {
          // prefer the start of a visible node over the end of the one before
          if (!best || best.mark || (p === t.at && best.at + best.len === p)) best = t;
        } else if (!best) best = t;
      }
      if (!best) return [elm, elm.childNodes.length - 1];
      if (best.mark) {
        const nxt = ts.find((t) => !t.mark && t.at >= best.at + best.len);
        if (nxt) return [nxt.n, 0];
      }
      return [best.n, p - best.at];
    };
    let placedAt = -1; // where the editor itself last put the caret (typing stays where it is, inside the bold)
    const setDomSel = (a, b) => {
      placedAt = a === b ? a : -1;
      const s = root.getSelection ? root.getSelection() : document.getSelection();
      if (!s) return;
      try {
        const [an, ao] = place(a), [bn, bo] = place(b);
        const r = document.createRange();
        r.setStart(an, ao);
        r.setEnd(bn, bo);
        s.removeAllRanges();
        s.addRange(r);
      } catch (e) {}
    };
    const fire = () => elm.dispatchEvent(new Event("input", { bubbles: true }));
    const snapshot = (kind) => {
      const now = Date.now();
      if (kind && kind === lastKind && now - lastAt < 800) {
        lastAt = now;
        return;
      }
      hist.push({ text, sel: sel.slice() });
      if (hist.length > 300) hist.shift();
      fut = [];
      lastKind = kind;
      lastAt = now;
    };
    function replace(a, b, str, ca, cb, kind) {
      a = Math.max(0, Math.min(a, text.length));
      b = Math.max(a, Math.min(b, text.length));
      if (str === "" && a === b) return;
      snapshot(kind || "");
      text = text.slice(0, a) + str + text.slice(b);
      const c0 = ca ?? a + str.length;
      sel = [c0, cb ?? c0];
      draw();
      if (root.activeElement === elm) setDomSel(sel[0], sel[1]);
      keepCaretInView();
      fire();
    }
    function keepCaretInView() {
      const s = root.getSelection ? root.getSelection() : null;
      if (!s || !s.rangeCount) return;
      const rr = s.getRangeAt(0).getClientRects()[0];
      if (!rr) return;
      const sc = scroller(), box = sc.getBoundingClientRect();
      if (rr.bottom > box.bottom - 8) sc.scrollTop += rr.bottom - box.bottom + 24;
      else if (rr.top < box.top + 4) sc.scrollTop -= box.top - rr.top + 24;
      if (rr.right > box.right - 8) sc.scrollLeft += rr.right - box.right + 40;
      else if (rr.left < box.left + 8) sc.scrollLeft -= box.left - rr.left + 40;
    }
    const hiddenEndingAt = (p) => hidden.find(([a, b]) => b === p);
    const hiddenStartingAt = (p) => hidden.find(([a, b]) => a === p);
    function delBack(a, b, unit) {
      if (a !== b) return replace(a, b, "", a, a, "del");
      if (!a) return;
      const h = hiddenEndingAt(a);
      if (h && h[2]) return replace(h[0], h[1], "", h[0], h[0], "del"); // a bullet or # goes as a whole
      let p = a;
      for (let g = hiddenEndingAt(p); g && !g[2]; g = hiddenEndingAt(p)) p = g[0]; // skip hidden ** to the letter before
      if (unit === "word") {
        let q = p;
        while (q > 0 && /\s/.test(text[q - 1]) && text[q - 1] !== "\n") q--;
        while (q > 0 && /\S/.test(text[q - 1])) q--;
        if (q === p && q > 0) q--;
        return replace(q, p, "", q, q, "del");
      }
      if (unit === "line") {
        const ls = text.lastIndexOf("\n", p - 1) + 1;
        return replace(ls === p && p ? p - 1 : ls, p, "", ls === p && p ? p - 1 : ls, undefined, "del");
      }
      const k = p >= 2 && /[\uDC00-\uDFFF]/.test(text[p - 1]) ? 2 : 1;
      replace(p - k, p, "", p - k, p - k, "del");
    }
    function delFwd(a, b, unit) {
      if (a !== b) return replace(a, b, "", a, a, "del");
      if (a >= text.length) return;
      let p = a;
      for (let g = hiddenStartingAt(p); g && !g[2]; g = hiddenStartingAt(p)) p = g[1];
      let q = p + 1;
      if (unit === "word") {
        q = p;
        while (q < text.length && /\s/.test(text[q]) && text[q] !== "\n") q++;
        while (q < text.length && /\S/.test(text[q])) q++;
        if (q === p) q++;
      }
      replace(p, Math.min(q, text.length), "", a, a, "del");
    }
    function undo() {
      if (!hist.length) return;
      fut.push({ text, sel: sel.slice() });
      const h = hist.pop();
      text = h.text;
      sel = h.sel;
      lastKind = "";
      draw();
      setDomSel(sel[0], sel[1]);
      fire();
    }
    function redo() {
      if (!fut.length) return;
      hist.push({ text, sel: sel.slice() });
      const h = fut.pop();
      text = h.text;
      sel = h.sel;
      lastKind = "";
      draw();
      setDomSel(sel[0], sel[1]);
      fire();
    }
    let composing = false;
    elm.addEventListener("compositionstart", () => (composing = true));
    elm.addEventListener("compositionend", () => {
      composing = false;
      // take what the input method typed from the page, then draw it again
      const before = text;
      const r = readSel();
      const raw = [...elm.childNodes].filter((n) => !(n.nodeType === 1 && n.hasAttribute("data-end"))).map((n) => n.textContent).join("");
      if (raw !== before) {
        hist.push({ text: before, sel: sel.slice() });
        text = raw;
        sel = r || [text.length, text.length];
        draw();
        setDomSel(sel[0], sel[1]);
        fire();
      }
    });
    elm.addEventListener("beforeinput", (e) => {
      if (composing || e.inputType === "insertCompositionText") return;
      const [a, b] = curSel();
      const t = e.inputType;
      const data = e.data ?? (e.dataTransfer ? e.dataTransfer.getData("text/plain") : "");
      e.preventDefault();
      if (t === "insertText" || t === "insertReplacementText") {
        const afterPic = a === b && hidden.some((h) => h[4] === "img" && h[1] === a);
        return replace(a, b, (afterPic ? "\n" : "") + (data || "").replace(/\r\n?/g, "\n"), undefined, undefined, data === " " ? "space" : "type");
      }
      if (t === "insertLineBreak" || t === "insertParagraph") return replace(a, b, "\n", undefined, undefined, "enter");
      if (t === "insertFromPaste" || t === "insertFromDrop" || t === "insertFromYank") return replace(a, b, (data || "").replace(/\r\n?/g, "\n"));
      if (t === "deleteContentBackward") return delBack(a, b);
      if (t === "deleteContentForward") return delFwd(a, b);
      if (t === "deleteWordBackward") return delBack(a, b, "word");
      if (t === "deleteWordForward") return delFwd(a, b, "word");
      if (t === "deleteSoftLineBackward" || t === "deleteHardLineBackward") return delBack(a, b, "line");
      if (t.startsWith("delete")) return replace(a, b, "", a, a, "del");
      if (t === "historyUndo") return undo();
      if (t === "historyRedo") return redo();
    });
    elm.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === "z" || k === "y")) {
        e.preventDefault();
        e.stopPropagation();
        return (k === "y" || e.shiftKey) ? redo() : undo();
      }
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        let [a, b] = curSel();
        if (a === b) a = b = norm(a); // a new line never splits a ** pair
        // carry a list on to the next line; Enter on an empty item ends the list
        const ls = text.lastIndexOf("\n", a - 1) + 1;
        const line = text.slice(ls, a);
        const m = line.match(/^(\s*)([-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)(.*)$/);
        if (m && b === a && !text.slice(a, (text.indexOf("\n", a) + 1 || text.length + 1) - 1).trim()) {
          if (!m[3].trim()) return replace(ls, a, "", ls, ls, "enter");
          const next = m[2].replace(/\[[xX]\]/, "[ ]").replace(/^\d+/, (n) => String(+n + 1));
          return replace(a, b, "\n" + m[1] + next, undefined, undefined, "enter");
        }
        return replace(a, b, "\n", undefined, undefined, "enter");
      }
    });
    // copy and cut keep the Markdown
    const copyOut = (e, cut) => {
      let [a, b] = curSel();
      for (const [s0, e0, , close] of hidden) {
        if (!close && e0 === a) a = s0; // take the opening ** too
        if (close && s0 === b) b = e0; // and the closing one
      }
      if (a === b) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", text.slice(a, b));
      if (cut) replace(a, b, "", a, a, "del");
    };
    elm.addEventListener("copy", (e) => copyOut(e, false));
    elm.addEventListener("cut", (e) => copyOut(e, true));
    elm.addEventListener("focus", () => setTimeout(() => root.activeElement === elm && !readSel() && setDomSel(sel[0], sel[1]), 0));
    document.addEventListener("selectionchange", () => {
      if (root.activeElement !== elm) return;
      const r = readSel();
      if (r) sel = r[0] === r[1] && r[0] !== placedAt ? [norm(r[0]), norm(r[0])] : r;
      if (r && r[0] !== placedAt) placedAt = -1;
    });
    const api = {
      el: elm,
      get value() {
        return text;
      },
      set value(v) {
        text = String(v ?? "").replace(/\r\n?/g, "\n");
        hist = [];
        fut = [];
        sel = [0, 0];
        draw();
      },
      get selectionStart() {
        return curSel()[0];
      },
      get selectionEnd() {
        return curSel()[1];
      },
      setSelectionRange(a, b) {
        sel = [Math.max(0, Math.min(a, text.length)), Math.max(0, Math.min(b ?? a, text.length))];
        if (root.activeElement === elm) setDomSel(sel[0], sel[1]);
      },
      focus() {
        const keep = sel.slice();
        if (root.activeElement !== elm) elm.focus({ preventScroll: true });
        sel = keep;
        setDomSel(sel[0], sel[1]);
      },
      replace,
      undo,
      redo,
      get scrollTop() {
        return scroller().scrollTop;
      },
      set scrollTop(v) {
        scroller().scrollTop = v;
      },
      addEventListener: (...a) => elm.addEventListener(...a),
      dispatchEvent: (e) => elm.dispatchEvent(e),
      getClientRects: () => elm.getClientRects(),
    };
    elm.__ed = api;
    return api;
  })();
  let notesVid = null; // the video whose notes are open
  let notesDirty = false;
  let notesTimer = null;
  let previewTimer = null;
  const notesOpen = () => $("notesWin").classList.contains("show");
  const notesEntry = () => (notesVid ? library.find((x) => x.videoId === notesVid) : null);
  const hasNotes = (v) => !!(v && v.notes && v.notes.trim());
  const setNotesStatus = () => {}; // the notes window shows only the video's title
  const fmtClock = (t) => {
    try {
      return new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    } catch (e) {
      return "";
    }
  };

  // Notes save themselves a moment after you stop typing. Saving notes also saves the video.
  function saveNotesNow() {
    clearTimeout(notesTimer);
    if (!notesVid || !notesDirty) return;
    const text = notesTa.value;
    let v = notesEntry();
    const now = Date.now();
    if (!v) {
      if (!text.trim()) {
        notesDirty = false;
        setNotesStatus("");
        return;
      }
      const title = notesVid === state.videoId ? videoTitle() : "YouTube video";
      v = { id: newId(), videoId: notesVid, title, name: title, desc: "", createdAt: now, updatedAt: now, loops: [] };
      library = [v, ...library];
    }
    v.notes = text;
    v.notesUpdatedAt = v.updatedAt = now;
    notesDirty = false;
    saveLibrary();
    setNotesStatus(`Saved ${fmtClock(now)}`);
  }
  notesTa.addEventListener("input", () => {
    notesDirty = true;
    setNotesStatus("Saving…");
    clearTimeout(notesTimer);
    notesTimer = setTimeout(saveNotesNow, 700);
    schedulePreview();
  });

  const notesMode = () => "write"; // the editor is a plain text editor (no preview)
  function applyNotesMode() {
    renderShapesBtn();
  }
  root.querySelectorAll("#notesMode button").forEach((b) =>
    b.addEventListener("click", () => {
      state.settings.notesMode = b.dataset.mode;
      persist();
      applyNotesMode();
      renderPreview();
      if (b.dataset.mode !== "preview") notesTa.focus();
    })
  );

  function placeNotes() {
    const w = $("notesWin");
    const sz = state.settings.notesSize;
    let W = Math.min((sz && sz.w) || 900, innerWidth - 8);
    const H = Math.min((sz && sz.h) || 540, innerHeight - 8);
    let p = state.settings.notesPos;
    if (!p) {
      // first time: beside the panel, on the side with more room, so the panel stays in view
      const r = root.querySelector(".panel").getBoundingClientRect();
      const roomL = r.left - 16, roomR = innerWidth - r.right - 16;
      const right = roomR >= roomL;
      const room = Math.max(roomL, roomR);
      if (room >= 480) W = Math.min(W, room);
      p = { left: right ? (room >= 480 ? r.right + 8 : innerWidth - W - 8) : Math.max(8, r.left - 8 - W), top: Math.max(8, Math.round((innerHeight - H) / 3)) };
    }
    w.style.width = W + "px";
    w.style.height = H + "px";
    w.style.left = clamp(p.left, 0, Math.max(0, innerWidth - 160)) + "px";
    w.style.top = clamp(p.top, 0, Math.max(0, innerHeight - 40)) + "px";
  }
  function openNotes(vid = state.videoId) {
    if (!NL) return;
    if (!vid) return flash("Open a video first");
    if (notesOpen() && notesVid === vid) return notesTa.focus();
    if (notesOpen()) saveNotesNow();
    notesVid = vid;
    notesDirty = false;
    notesCaretSet = false; // until you click or type in the page, Insert into Editor adds at the end
    const v = notesEntry();
    const title = v ? v.name || v.title : videoTitle();
    // a new page starts with the video's title (nothing is saved until you type)
    notesTa.value = (v && v.notes && asSongText(v.notes)) || exampleSong(title);
    ink = (v && Array.isArray(v.drawing) ? v.drawing : []).map((k) => ({ ...k, p: k.p.slice() }));
    inkUndo = [];
    setDrawing(false);
    applyNotesFont();
    renderInk();
    $("notesTitle").textContent = title;
    $("notesTitle").title = title;
    placeNotes();
    $("notesWin").classList.add("show");
    applyNotesMode();
    renderPreview();
    const fresh = !(v && v.notes);
    if (notesMode() !== "preview") {
      setTimeout(() => {
        notesTa.focus();
        const at = fresh ? Math.min(notesTa.value.indexOf("\n") + 1, notesTa.value.length) : 0; // a new page: the line under the title
        notesTa.setSelectionRange(at, at);
        notesTa.scrollTop = 0;
      }, 0);
    }
    renderSaveRow();
  }
  // text size of the page (10–28 px), remembered
  // how much narrower the bigger bold chord letters must be set, so each is as wide as a letter in the words
  function chordSpacing(fs, fam) {
    const ch = fs + 1;
    const probe = document.createElement("span");
    probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;font:400 ${fs}px ${fam}`;
    probe.textContent = "M".repeat(20);
    root.append(probe);
    const w0 = probe.getBoundingClientRect().width / 20;
    probe.style.font = `700 ${ch}px ${fam}`;
    const w1 = probe.getBoundingClientRect().width / 20;
    probe.remove();
    return { ch, ls: w0 && w1 ? w0 - w1 : 0 };
  }
  const pageColor = () => (FC.some(([c]) => c === state.settings.pageColor) ? state.settings.pageColor : "");
  function setPageColor(c) {
    state.settings.pageColor = c || "";
    persist();
    applyNotesFont();
  }
  function applyNotesFont() {
    const fs = pageSize(), fam = fontStack(pageFontKey());
    const live = $("notesText");
    live.classList.forEach((k) => k.startsWith("pc-") && live.classList.remove(k));
    if (pageColor()) live.classList.add("pc-" + pageColor());
    live.style.setProperty("--edfs", fs + "px");
    live.style.setProperty("--edff", fam);
    live.style.fontSize = fs + "px";
    // chords a little bigger and bold, but each letter as wide as one in the words, so they stay over the right word
    const { ch, ls } = chordSpacing(fs, fam);
    live.style.setProperty("--chfs", ch + "px");
    live.style.setProperty("--chls", (isFixedFont(pageFontKey()) ? ls : 0).toFixed(3) + "px");
    sizeInk();
  }
  try {
    document.fonts.ready.then(() => notesOpen() && applyNotesFont());
    document.fonts.addEventListener("loadingdone", () => notesOpen() && applyNotesFont());
  } catch (e) {}
  // Font and Size: with text selected, just that text; with nothing selected, the whole page
  for (const [id, prop] of [["edFont", "font"], ["edSize", "size"]]) {
    $(id).addEventListener("change", (e) => {
      if (drawingOn) setDrawing(false);
      const val = e.target.value;
      notesTa.focus();
      if (notesTa.selectionStart === notesTa.selectionEnd) {
        if (!val) return syncStyleBoxes();
        if (prop === "font") state.settings.pageFont = val;
        else state.settings.pageSize = clamp(+val, 9, 40);
        persist();
        applyNotesFont();
      } else mdSpan(prop, val);
      syncStyleBoxes();
    });
  }
  // the boxes show the font and size where the cursor is
  function syncStyleBoxes() {
    if (!notesOpen()) return;
    const live = $("notesText");
    const sel = root.getSelection ? root.getSelection() : null;
    if (!sel || !sel.rangeCount || !live.contains(sel.anchorNode)) return;
    const r = sel.getRangeAt(0);
    // the text the cursor is in, or every piece of text in the selection
    const nodes = [];
    if (r.collapsed) {
      let n = r.startContainer;
      if (n.nodeType !== 3) n = n.childNodes[r.startOffset] || n.childNodes[r.startOffset - 1] || n;
      if (n && n.nodeType !== 3) {
        const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
        n = w.nextNode() || n;
      }
      if (n) nodes.push(n);
    } else {
      const w = document.createTreeWalker(live, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) if (r.intersectsNode(n) && n.data.trim() && !(n.parentElement && n.parentElement.closest(".mk"))) nodes.push(n);
    }
    const sizes = new Set(), fonts = new Set();
    for (const n of nodes) {
      const e = n.nodeType === 3 ? n.parentElement : n;
      if (!e || !live.contains(e)) continue;
      sizes.add(Math.round(parseFloat(getComputedStyle(e).fontSize)));
      const f = e.closest('[style*="--ff-"]');
      fonts.add(f ? (f.getAttribute("style").match(/--ff-([a-z]+)/) || [])[1] || "" : pageFontKey());
    }
    const sz = sizes.size === 1 ? String([...sizes][0]) : "";
    const box = $("edSize");
    if (sz && ![...box.options].some((o) => o.value === sz)) {
      // a size not in the list (a heading, a chord line): show it anyway
      box.querySelectorAll("option.tmp").forEach((o) => o.remove());
      const o = new Option(sz, sz);
      o.className = "tmp";
      const after = [...box.options].find((x) => x.value && +x.value > +sz);
      box.insertBefore(o, after || null);
    }
    box.value = sz;
    $("edFont").value = fonts.size === 1 ? [...fonts][0] : "";
  }
  document.addEventListener("selectionchange", () => {
    if (root.activeElement === $("notesText")) syncStyleBoxes();
  });
  // ----- drawing on the page: pencil, pen, marker, chalk; the eraser removes whole lines -----
  // Lines are kept with the page (v.drawing), in page coordinates, so they scroll with the text.
  const INK_COLORS = [
    ["ink", "Black / white"],
    ["#e53935", "Red"],
    ["#1e88e5", "Blue"],
    ["#43a047", "Green"],
    ["#fb8c00", "Orange"],
    ["#8e24aa", "Purple"],
    ["#fdd835", "Yellow"],
  ];
  const INK_TOOLS = {
    pencil: { w: 1.6, o: 0.8 },
    pen: { w: 2.6, o: 1 },
    quill: { w: 4.6, o: 0.94, nib: true },
    marker: { w: 14, o: 0.35 },
    chalk: { w: 7, o: 0.9, filter: "url(#ygcChalk)" },
    smear: { w: 18, o: 0.32, filter: "url(#ygcSmear)" },
  };
  const INK_SIZES = { s: 0.6, m: 1, l: 1.9 };
  const sizeMul = (k) => INK_SIZES[k] || (+k > 0 ? +k : 1);
  let ink = [], inkUndo = [], inkLive = null, drawingOn = false;
  const inkSet = () => state.settings.draw || (state.settings.draw = { tool: "pen", color: "#e53935", size: "m" });
  const inkColor = (c) => (c === "ink" ? (host.getAttribute("data-theme") === "light" ? "#222" : "#eee") : c);
  function inkPath(pts) {
    if (pts.length < 4) return `M${pts[0]} ${pts[1]}l0.01 0`;
    let d = `M${pts[0]} ${pts[1]}`;
    for (let i = 2; i < pts.length - 2; i += 2) {
      const mx = (pts[i] + pts[i + 2]) / 2, my = (pts[i + 1] + pts[i + 3]) / 2;
      d += `Q${pts[i]} ${pts[i + 1]} ${mx} ${my}`;
    }
    return d + `L${pts[pts.length - 2]} ${pts[pts.length - 1]}`;
  }
  // the old ink pen: a slanted nib, thick on some strokes and thin on others
  function nibPath(pts, w) {
    const nx = (Math.SQRT1_2 * w) / 2, ny = -(Math.SQRT1_2 * w) / 2;
    let d = "";
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
      d += `M${ax - nx} ${ay - ny}L${bx - nx} ${by - ny}L${bx + nx} ${by + ny}L${ax + nx} ${ay + ny}Z`;
    }
    const [x0, y0] = pts;
    d += `M${x0 - nx} ${y0 - ny}L${x0 + nx} ${y0 + ny}L${x0 + nx + 0.6} ${y0 + ny + 0.6}L${x0 - nx + 0.6} ${y0 - ny + 0.6}Z`;
    return d;
  }
  function inkEl(k, ink0) {
    const t = INK_TOOLS[k.t] || INK_TOOLS.pen;
    if (t.nib) {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", nibPath(k.p, t.w * sizeMul(k.s)));
      p.setAttribute("fill", k.c === "ink" && ink0 ? ink0 : inkColor(k.c));
      p.setAttribute("fill-opacity", String(t.o));
      p.setAttribute("stroke", "none");
      p.setAttribute("class", "nib");
      return p;
    }
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", inkPath(k.p));
    p.setAttribute("stroke", k.c === "ink" && ink0 ? ink0 : inkColor(k.c));
    p.setAttribute("fill", "none");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    p.setAttribute("stroke-width", String(t.w * sizeMul(k.s)));
    p.setAttribute("stroke-opacity", String(t.o));
    if (t.filter) p.setAttribute("filter", t.filter);
    if (k.t === "marker") p.setAttribute("stroke-linecap", "square");
    return p;
  }
  function sizeInk() {
    const sc = $("edScroll"), svg = $("edInk"), live = $("notesText");
    if (!sc || !svg || !live) return;
    let w = Math.max(sc.clientWidth, live.scrollWidth, live.offsetWidth), h = Math.max(sc.clientHeight, live.scrollHeight, live.offsetHeight);
    const f = inkScale();
    for (const k of ink)
      for (let i = 0; i < k.p.length; i += 2) {
        w = Math.max(w, k.p[i] * f + 20);
        h = Math.max(h, k.p[i + 1] * f + 20);
      }
    $("edInkG").setAttribute("transform", `scale(${f})`);
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
  }
  function renderInk() {
    const g = $("edInkG");
    if (!g) return;
    g.replaceChildren(...ink.map((k) => inkEl(k)));
    sizeInk();
  }
  function renderDrawBar() {
    const d = inkSet();
    root.querySelectorAll("#drawBar [data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === d.tool));
    $("drawWidth").value = { s: "0.6", m: "1", l: "2.2" }[d.size] || String(d.size || "1");
    const cols = $("drawCols");
    if (!cols.childElementCount)
      INK_COLORS.forEach(([c, n]) => {
        const b = el("button", "dcol");
        b.dataset.color = c;
        b.title = n;
        cols.append(b);
      });
    $("drawBar").style.setProperty("--dcol", inkColor(d.color));
    cols.querySelectorAll(".dcol").forEach((b) => {
      b.style.background = inkColor(b.dataset.color);
      b.classList.toggle("on", b.dataset.color === d.color);
    });
    $("edScroll").classList.toggle("erasing", d.tool === "eraser");
    $("drawUndo").disabled = !inkUndo.length;
    $("drawClear").disabled = !ink.length;
  }
  function setDrawing(on) {
    drawingOn = !!on;
    $("notesWin").classList.toggle("drawing", drawingOn);
    $("edScroll").classList.toggle("drawing", drawingOn);
    $("edDraw").classList.toggle("active", drawingOn);
    $("notesText").contentEditable = drawingOn ? "false" : "true";
    if (drawingOn) renderDrawBar();
  }
  function saveInk() {
    if (!notesVid) return;
    let v = notesEntry();
    if (!v) {
      if (!ink.length) return;
      notesDirty = true;
      saveNotesNow(); // makes the saved video, with the page
      v = notesEntry();
      if (!v) return;
    }
    v.drawing = ink.map((k) => ({ ...k }));
    v.updatedAt = Date.now();
    saveLibrary();
    renderDrawBar();
  }
  const inkScale = () => pageSize() / 12;
  const inkPoint = (e) => {
    const r = $("edInk").getBoundingClientRect(), f = inkScale();
    return [Math.round((e.clientX - r.left) / f), Math.round((e.clientY - r.top) / f)];
  };
  const segDist = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  function eraseAt(x, y) {
    const r = 8 * sizeMul(inkSet().size) + 4;
    const keep = ink.filter((k) => {
      const t = INK_TOOLS[k.t] || INK_TOOLS.pen, reach = r + (t.w * sizeMul(k.s)) / 2;
      if (k.p.length < 4) return Math.hypot(k.p[0] - x, k.p[1] - y) > reach;
      for (let i = 0; i < k.p.length - 2; i += 2) if (segDist(x, y, k.p[i], k.p[i + 1], k.p[i + 2], k.p[i + 3]) <= reach) return false;
      return true;
    });
    if (keep.length === ink.length) return false;
    inkUndo.push(ink);
    ink = keep;
    renderInk();
    return true;
  }
  (() => {
    const svg = $("edInk");
    let erasing = false, erased = false;
    svg.addEventListener("pointerdown", (e) => {
      if (!drawingOn || e.button !== 0) return;
      e.preventDefault();
      try {
        svg.setPointerCapture(e.pointerId);
      } catch (err) {}
      const d = inkSet(), [x, y] = inkPoint(e);
      if (d.tool === "eraser") {
        erasing = true;
        erased = eraseAt(x, y);
        return;
      }
      inkLive = { k: { t: d.tool, c: d.color, s: d.size, p: [x, y] }, el: null };
      inkLive.el = inkEl(inkLive.k);
      $("edInkG").append(inkLive.el);
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drawingOn) return;
      const [x, y] = inkPoint(e);
      if (erasing) {
        if (eraseAt(x, y)) erased = true;
        return;
      }
      if (!inkLive) return;
      const p = inkLive.k.p;
      if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) < 2) return;
      p.push(x, y);
      if (INK_TOOLS[inkLive.k.t] && INK_TOOLS[inkLive.k.t].nib) inkLive.el.setAttribute("d", nibPath(p, INK_TOOLS[inkLive.k.t].w * sizeMul(inkLive.k.s)));
      else inkLive.el.setAttribute("d", inkPath(p));
    });
    const end = () => {
      if (erasing) {
        erasing = false;
        if (erased) saveInk();
        erased = false;
        return;
      }
      if (!inkLive) return;
      inkUndo.push(ink);
      ink = [...ink, inkLive.k];
      inkLive = null;
      renderInk();
      saveInk();
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
  })();
  root.querySelectorAll("#notesWin .ntools").forEach((bar) =>
    bar.addEventListener(
      "mousedown",
      (e) => {
        if (drawingOn && e.target.closest("button, select, input, label") && !e.target.closest("#edDraw")) setDrawing(false);
      },
      true
    )
  );
  $("edDraw").addEventListener("mousedown", (e) => e.preventDefault());
  $("edDraw").onclick = () => setDrawing(!drawingOn);
  $("drawDone").onclick = () => (setDrawing(false), notesTa.focus());
  $("drawBar").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const d = inkSet();
    if (b.dataset.tool && b.dataset.tool === d.tool && b.classList.contains("on")) return setDrawing(false), notesTa.focus(); // the chosen tool again: back to typing
    if (b.dataset.tool) d.tool = b.dataset.tool;
    else if (b.dataset.size) d.size = b.dataset.size;
    else if (b.dataset.color) {
      d.color = b.dataset.color;
      if (d.tool === "eraser") d.tool = "pen";
    } else return;
    persist();
    renderDrawBar();
  });
  $("drawWidth").addEventListener("change", (e) => {
    inkSet().size = e.target.value;
    persist();
  });
  $("drawUndo").onclick = () => {
    if (!inkUndo.length) return;
    ink = inkUndo.pop();
    renderInk();
    saveInk();
  };
  $("drawClear").onclick = () => {
    if (!ink.length) return;
    inkUndo.push(ink);
    ink = [];
    renderInk();
    saveInk();
  };
  $("notesWin").addEventListener("keydown", (e) => {
    if (drawingOn && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      $("drawUndo").click();
    }
  });
  new ResizeObserver(() => sizeInk()).observe($("edScroll"));

  function closeNotes() {
    if (!notesOpen()) return;
    closeMenu();
    setDrawing(false);
    hideChordPop();
    saveNotesNow();
    $("notesWin").classList.remove("show");
    notesVid = null;
    renderSaveRow();
  }
  $("scalesBtn").onclick = () => openScales("scales");
  $("tabsBtn").onclick = () => openScales("tabs");
  $("linksBtn").onclick = () => state.videoId && openLinks(state.videoId);
  $("chordsBtn").onclick = () => openScales("chords");
  $("chordsBtn2").onclick = () => openScales("chords");
  $("scalesBtn2").onclick = () => openScales();
  $("notesBtn").onclick = () => (notesOpen() && notesVid === state.videoId ? closeNotes() : openNotes());
  $("notesDone").onclick = () => $("notesClose").click();
  $("notesClose").onclick = closeNotes;

  // move the notes window by its title bar; remember where it was and how big
  (() => {
    const head = $("notesHead");
    const win = $("notesWin");
    let drag = null;
    head.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      const r = win.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const left = clamp(e.clientX - drag.dx, 0, window.innerWidth - 160);
      const top = clamp(e.clientY - drag.dy, 0, window.innerHeight - 40);
      win.style.left = left + "px";
      win.style.top = top + "px";
      state.settings.notesPos = { left, top };
    });
    window.addEventListener("mouseup", () => {
      if (drag) persist();
      drag = null;
    });
    let sizeTimer = null;
    try {
      new ResizeObserver(() => {
        if (!notesOpen()) return;
        clearTimeout(sizeTimer);
        sizeTimer = setTimeout(() => {
          const r = win.getBoundingClientRect();
          if (!r.width) return;
          state.settings.notesSize = { w: Math.round(r.width), h: Math.round(r.height) };
          persist();
        }, 400);
      }).observe(win);
    } catch (e) {}
  })();

  // ----- chord chips and chord shapes beside the song -----
  const CAPO_RE = /^\s*capo\s*:?\s*(\d{1,2})\b.*$/im;
  function pageCapo(text = notesTa.value) {
    const head = text.split("\n").slice(0, 8).join("\n");
    const m = head.match(CAPO_RE);
    return m ? clamp(+m[1], 0, 12) : 0;
  }
  const withCapo = (sh) => (sh && pageCapo() && !sh.capo ? { ...sh, capo: pageCapo() } : sh);
  $("edCapo").addEventListener("change", (e) => {
    const n = +e.target.value || 0;
    const v = notesTa.value;
    const ls = v.split("\n");
    const at = ls.slice(0, 8).findIndex((l) => CAPO_RE.test(l));
    if (at >= 0) {
      // change or take away the capo line
      const a = ls.slice(0, at).join("\n").length + (at ? 1 : 0), b = a + ls[at].length;
      if (n) edReplace(a, b, `Capo ${n}`);
      else edReplace(a, Math.min(v.length, b + 1), "");
    } else if (n) {
      // under the title
      const a = ls[0].length;
      edReplace(a, a, `\nCapo ${n}`);
    }
    renderPreview();
  });
  function renderPreview() {
    if (!NL) return;
    const t = notesTa.value;
    if (root.activeElement !== $("edCapo")) $("edCapo").value = String(pageCapo(t));
    const used = NL.sheetChords(t);
    renderRefs();
    const shapes = $("edShapes");
    $("edChLib").classList.toggle("off", state.settings.songShapes === false);
    root.querySelectorAll("#edChFilter button").forEach((b) => b.classList.toggle("active", b.dataset.f === sideFilter()));
    // the song's chords, then the ones you added to the chord library for this page
    const extra = sideChords().filter((c) => !used.includes(c) && NL.isChord(c));
    // All · Library · Mine also filters the chords already in the library (Mine: your own chords)
    const f = sideFilter(), mine = new Set(myChordNames());
    const keep = (c) => f === "all" || (f === "mine") === mine.has(c);
    const usedF = used.filter(keep), extraF = extra.filter(keep);
    const hiddenN = used.length + extra.length - usedF.length - extraF.length;
    const dg = (c, more) =>
      `<span class="cs-dg${more ? " extra" : ""}" data-chord="${NL.esc(c)}" title="Edit ${NL.esc(c)}">${NL.chordDiagramSvg(c, withCapo(NL.chordShape(c)), { rootPc: NL.chordRootPc(c) })}${more ? `<button class="cs-rm" data-rm="${NL.esc(c)}" title="Remove" aria-label="Remove">×</button>` : ""}</span>`;
    shapes.innerHTML =
      usedF.map((c) => dg(c, false)).join("") +
      extraF.map((c) => dg(c, true)).join("") +
      (hiddenN && !usedF.length && !extraF.length ? `<span class="cs-none">${f === "mine" ? "None of your own chords in this song." : "Only your own chords in this song."} <button class="linkish" data-f="all">Show All</button></span>` : "");
  }
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 150);
  }

  // point at a chord in the page for a moment: its fingering shows (with the page's capo)
  const CHORD_HOVER_MS = 450;
  let chHoverEl = null, chHoverTimer = null, chPop = null;
  function hideChordPop() {
    clearTimeout(chHoverTimer);
    if (chHoverEl) chHoverEl.classList.remove("hov");
    chHoverEl = null;
    if (chPop) chPop.classList.remove("show");
  }
  function showChordPop(span) {
    if (!NL || !span.isConnected) return;
    const name = span.dataset.chord;
    const sh = withCapo(NL.chordShape(name));
    if (!chPop) {
      chPop = el("div", "chpop");
      chPop.setAttribute("role", "tooltip");
      root.append(chPop);
    }
    chPop.innerHTML = NL.chordDiagramSvg(name, sh, { rootPc: NL.chordRootPc(name) }) + (sh ? `<div class="cp-fr">${NL.esc(fretsText(sh.frets))}</div>` : "");
    span.classList.add("hov");
    const r = span.getBoundingClientRect(), m = chPop.getBoundingClientRect();
    const below = r.bottom + 8 + m.height < innerHeight;
    chPop.style.left = clamp(r.left + r.width / 2 - m.width / 2, 6, innerWidth - m.width - 6) + "px";
    chPop.style.top = (below ? r.bottom + 6 : Math.max(6, r.top - m.height - 6)) + "px";
    chPop.classList.add("show");
  }
  $("notesText").addEventListener("mouseover", (e) => {
    const span = e.target.closest && e.target.closest(".chd");
    if (span === chHoverEl) return;
    hideChordPop();
    if (!span || drawingOn) return;
    chHoverEl = span;
    chHoverTimer = setTimeout(() => chHoverEl === span && showChordPop(span), CHORD_HOVER_MS);
  });
  $("notesText").addEventListener("mouseleave", hideChordPop);
  for (const ev of ["mousedown", "keydown", "input"]) $("notesText").addEventListener(ev, hideChordPop);
  $("edScroll").addEventListener("scroll", hideChordPop, { passive: true });

  // timestamps in the notes: jump there, or loop that part (opens the video first if it's another one)
  function notesSeek(t) {
    if (notesVid === state.videoId) {
      const v = getVideo();
      if (!v) return;
      cancelWait();
      v.currentTime = t;
      v.play();
      return;
    }
    jumpToVideo({ seek: t });
  }
  function notesLoop(a, b) {
    if (notesVid === state.videoId) {
      state.loopId = null;
      state.a = round2(a);
      state.b = round2(b);
      state.looping = false;
      persist();
      toggleLoop(true);
      const v = getVideo();
      if (v && v.paused) v.play();
      return;
    }
    jumpToVideo({ range: [a, b] });
  }
  async function jumpToVideo(extra) {
    const vid = notesVid;
    saveNotesNow();
    await store.set("pendingLoad", { videoId: vid, at: Date.now(), notes: true, ...extra });
    location.href = "https://www.youtube.com/watch?v=" + encodeURIComponent(vid);
  }

  // ----- editing helpers (keep the browser's undo working where possible) -----
  function edReplace(start, end, text, selStart, selEnd) {
    if (text === "" && start === end) {
      if (selStart != null) notesTa.setSelectionRange(selStart, selEnd ?? selStart);
      return;
    }
    if (notesTa.getClientRects().length) notesTa.focus();
    notesTa.replace(start, end, text, selStart, selEnd);
  }
  const insertInline = (text) => {
    const s = notesTa.selectionStart;
    edReplace(s, notesTa.selectionEnd, text, s + text.length);
  };
  function mdWrap(before, after, placeholder) {
    const s = notesTa.selectionStart, e = notesTa.selectionEnd, v = notesTa.value, sel = v.slice(s, e);
    if (sel.length >= before.length + after.length && sel.startsWith(before) && sel.endsWith(after))
      return edReplace(s, e, sel.slice(before.length, sel.length - after.length), s, e - before.length - after.length);
    if (v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after)
      return edReplace(s - before.length, e + after.length, sel, s - before.length, e - before.length);
    if (sel.includes("\n")) {
      // marks stay on one line: wrap each line of the selection by itself (spaces stay outside)
      const out = sel
        .split("\n")
        .map((l) => {
          const m = l.match(/^(\s*)(.*?)(\s*)$/);
          return m[2] ? m[1] + before + m[2] + after + m[3] : l;
        })
        .join("\n");
      return edReplace(s, e, out, s, s + out.length);
    }
    const inner = sel || placeholder;
    edReplace(s, e, before + inner + after, s + before.length, s + before.length + inner.length);
  }
  // highlight in a colour: ==text== (yellow) or =={green}text==; choosing again changes the colour, "none" takes it off
  const HL = [
    ["yellow", "Yellow"],
    ["green", "Green"],
    ["blue", "Blue"],
    ["pink", "Pink"],
    ["orange", "Orange"],
    ["purple", "Purple"],
  ];
  const FC = [
    ["red", "Red"],
    ["blue", "Blue"],
    ["green", "Green"],
    ["orange", "Orange"],
    ["purple", "Purple"],
    ["gray", "Grey"],
  ];
  // text colour works the same way, with %%{red}text%%
  // %%{red;size:18;font:serif}text%%: the span around the selection, if there is one on this line
  const SPAN_RE = /%%\{([a-z0-9:;. -]+)\}([^%\n]+?)%%/g;
  function spanAt(s, e) {
    const v = notesTa.value;
    const ls = v.lastIndexOf("\n", s - 1) + 1;
    let le = v.indexOf("\n", e);
    if (le < 0) le = v.length;
    const line = v.slice(ls, le);
    const re = new RegExp(SPAN_RE.source, "g");
    let m;
    while ((m = re.exec(line))) {
      const a = ls + m.index, b = a + m[0].length, open = `%%{${m[1]}}`;
      const i0 = a + open.length, i1 = i0 + m[2].length;
      if (s >= i0 && e <= i1) return { a, b, i0, i1, props: NL.parseSpanStyle(m[1]) };
    }
    return null;
  }
  function mdSpan(prop, value) {
    let s = notesTa.selectionStart, e = notesTa.selectionEnd;
    const v = notesTa.value;
    const wrapWith = (props, txt) => {
      const spec = NL.spanSpec(props);
      return spec ? { out: `%%{${spec}}${txt}%%`, pre: `%%{${spec}}`.length } : { out: txt, pre: 0 };
    };
    const sp = spanAt(s, e);
    if (sp) {
      const ss = s === e ? sp.i0 : Math.max(s, sp.i0), ee = s === e ? sp.i1 : Math.min(e, sp.i1);
      const np = { ...sp.props, [prop]: value || undefined };
      const pre = v.slice(sp.i0, ss), mid = v.slice(ss, ee), post = v.slice(ee, sp.i1);
      const L = pre ? wrapWith(sp.props, pre).out : "";
      const M = wrapWith(np, mid);
      const R = post ? wrapWith(sp.props, post).out : "";
      const at = sp.a + L.length + M.pre;
      return edReplace(sp.a, sp.b, L + M.out + R, at, at + mid.length);
    }
    if (prop === "color" && s === e) return setPageColor(value); // nothing selected: the whole page
    if (!value) return;
    if (s === e) {
      const ls = v.lastIndexOf("\n", s - 1) + 1;
      let le = v.indexOf("\n", e);
      if (le < 0) le = v.length;
      while (s > ls && /\S/.test(v[s - 1])) s--;
      while (e < le && /\S/.test(v[e])) e++;
      if (s === e) return flash("Select some text first");
    }
    const sel = v.slice(s, e);
    if (sel.includes("\n")) {
      // a span stays on one line: style each line of the selection
      const lines = sel.split("\n").map((l) => (l.trim() ? wrapWith({ [prop]: value }, l).out : l));
      const out = lines.join("\n");
      return edReplace(s, e, out, s, s + out.length);
    }
    const W = wrapWith({ [prop]: value }, sel);
    edReplace(s, e, W.out, s + W.pre, s + W.pre + sel.length);
  }
  // UPPER or lower case for the selection (or the whole page); chord lines, chords in [ ],
  // times, links, pictures and style names like {green} are left as they are
  function mdCase(kind) {
    let s = notesTa.selectionStart, e = notesTa.selectionEnd;
    const v = notesTa.value;
    if (s === e) (s = 0), (e = v.length); // nothing selected: the whole page
    const KEEP = /(\{[^}\n]*\}|\]\([^)\n]*\)|\[[^\]\n]*\]|img:[\w-]+|https?:\/\/\S+|www\.\S+)/;
    const conv = (t) => t.split(KEEP).map((part, i) => (i % 2 ? part : kind === "upper" ? part.toLocaleUpperCase() : part.toLocaleLowerCase())).join("");
    let pos = s;
    const out = v
      .slice(s, e)
      .split("\n")
      .map((part) => {
        const ls = v.lastIndexOf("\n", pos - 1) + 1;
        let le = v.indexOf("\n", pos);
        if (le < 0) le = v.length;
        pos += part.length + 1;
        return NL.isChordLine(v.slice(ls, le)) ? part : conv(part);
      })
      .join("\n");
    if (out === v.slice(s, e)) return;
    edReplace(s, e, out, s, s + out.length);
  }
  // highlight over several lines: each line gets its own == … == (an old highlight in the way is replaced)
  function mdHighlightLines(color) {
    const s = notesTa.selectionStart, e = notesTa.selectionEnd, v = notesTa.value;
    const ls = v.lastIndexOf("\n", s - 1) + 1;
    let le = v.indexOf("\n", e);
    if (le < 0) le = v.length;
    const open = color === "yellow" ? "==" : `=={${color}}`;
    const MARK = /==(?:\{\w+\})?([^=\n]+?)==/g;
    let pos = ls;
    const out = v
      .slice(ls, le)
      .split("\n")
      .map((L) => {
        const L0 = pos, L1 = pos + L.length;
        pos = L1 + 1;
        let a = Math.max(s, L0) - L0, b = Math.min(e, L1) - L0;
        if (b <= a) return L;
        // don't cut an old highlight in half
        for (const m of L.matchAll(MARK)) {
          const ma = m.index, mb = m.index + m[0].length;
          if (ma < b && mb > a) (a = Math.min(a, ma)), (b = Math.max(b, mb));
        }
        const seg = L.slice(a, b).replace(MARK, "$1");
        const w = seg.match(/^(\s*)(.*?)(\s*)$/);
        const mid = w[2] ? w[1] + (color ? open + w[2] + "==" : w[2]) + w[3] : seg;
        return L.slice(0, a) + mid + L.slice(b);
      })
      .join("\n");
    if (out === v.slice(ls, le)) return;
    edReplace(ls, le, out, ls, ls + out.length);
  }
  function mdHighlight(color, font) {
    if (font) return mdSpan("color", color);
    const mk = font ? "%%" : "==";
    let s = notesTa.selectionStart, e = notesTa.selectionEnd;
    const v = notesTa.value;
    if (v.slice(s, e).replace(/\n$/, "").includes("\n")) return mdHighlightLines(color);
    // already highlighted? find the == … == around the selection on this line
    const ls = v.lastIndexOf("\n", s - 1) + 1;
    let le = v.indexOf("\n", e);
    if (le < 0) le = v.length;
    const line = v.slice(ls, le);
    const re = font ? /%%\{(\w+)\}([^%\n]+?)%%/g : /==(?:\{(\w+)\})?([^=\n]+?)==/g;
    let m;
    while ((m = re.exec(line))) {
      const a = ls + m.index, b = a + m[0].length;
      if (s >= a && e <= b) {
        const inner = m[2];
        const open0 = m[0].slice(0, m[0].length - inner.length - mk.length); // ==, =={green} or %%{red}
        const open = font ? `%%{${color}}` : color && color !== "yellow" ? `=={${color}}` : "==";
        const i0 = a + open0.length, i1 = i0 + inner.length;
        const ss = Math.max(s, i0), ee = Math.min(e, i1);
        if (ss < ee && (ss > i0 || ee < i1)) {
          // only part of it is selected: change (or clear) just that part
          const pre = v.slice(i0, ss), mid = v.slice(ss, ee), post = v.slice(ee, i1);
          const left = pre.trim() ? open0 + pre + mk : pre;
          const midOut = color ? open + mid + mk : mid;
          const at = a + left.length + (color ? open.length : 0);
          return edReplace(a, b, left + midOut + (post.trim() ? open0 + post + mk : post), at, at + mid.length);
        }
        const out = color ? open + inner + mk : inner;
        const at = a + (color ? open.length : 0);
        return edReplace(a, b, out, at, at + inner.length);
      }
    }
    if (!color) return;
    if (s === e) {
      // no selection: the word the cursor is on
      while (s > ls && /\S/.test(v[s - 1])) s--;
      while (e < le && /\S/.test(v[e])) e++;
      if (s === e) return flash(font ? "Select some text to colour" : "Select some text to highlight");
    }
    const open = font ? `%%{${color}}` : color === "yellow" ? "==" : `=={${color}}`;
    const sel = v.slice(s, e);
    edReplace(s, e, open + sel + mk, s + open.length, s + open.length + sel.length);
  }
  function lineRange() {
    const v = notesTa.value;
    const s = notesTa.selectionStart;
    let e = notesTa.selectionEnd;
    if (e > s && v[e - 1] === "\n") e--;
    const ls = v.lastIndexOf("\n", s - 1) + 1;
    let le = v.indexOf("\n", e);
    if (le < 0) le = v.length;
    return [ls, le];
  }
  const PREFIX = /^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d{1,9}[.)]\s+)/;
  const HAS = { h1: /^#\s/, h2: /^##\s/, h3: /^###\s/, quote: /^\s*>/, ul: /^\s*[-*+]\s+(?!\[[ xX]\])/, ol: /^\s*\d{1,9}[.)]\s/, task: /^\s*[-*+]\s+\[[ xX]\]/ };
  // headings, lists, checklists and quotes work on whole lines; pressing again takes them off
  function mdLines(kind) {
    const [ls, le] = lineRange();
    const lines = notesTa.value.slice(ls, le).split("\n");
    if (kind === "p") {
      const text = lines.map((l) => l.replace(PREFIX, "$1")).join("\n");
      return edReplace(ls, le, text, lines.length === 1 ? ls + text.length : ls, ls + text.length);
    }
    const all = lines.some((l) => l.trim()) && lines.filter((l) => l.trim()).every((l) => HAS[kind].test(l));
    let k = 0;
    const out = lines.map((l) => {
      if (!l.trim() && lines.length > 1) return l;
      const base = l.replace(PREFIX, "$1");
      if (all) return base;
      const ind = base.match(/^\s*/)[0];
      const body = base.slice(ind.length);
      const pre = { h1: "# ", h2: "## ", h3: "### ", quote: "> ", ul: "- ", ol: `${++k}. `, task: "- [ ] " }[kind];
      return kind[0] === "h" ? pre + body : ind + pre + body;
    });
    const text = out.join("\n");
    if (lines.length === 1) edReplace(ls, le, text, ls + text.length);
    else edReplace(ls, le, text, ls, ls + text.length);
  }
  // tab, scales, CAGED and keys go in between two horizontal lines
  const RULE = "─".repeat(44);
  const isRule = (l) => /^─{8,}\s*$/.test(l);
  function insertRuled(text) {
    const s = notesTa.selectionStart, v = notesTa.value;
    const prev = v.slice(0, s).replace(/\s+$/, "").split("\n").pop();
    const next = v.slice(notesTa.selectionEnd).replace(/^\s+/, "").split("\n")[0];
    insertBlock((isRule(prev) ? "" : RULE + "\n") + text + (isRule(next) ? "" : "\n" + RULE));
  }
  function insertBlock(text, selFrom, selTo) {
    const s = notesTa.selectionStart, e = notesTa.selectionEnd, v = notesTa.value;
    const before = v.slice(0, s), after = v.slice(e);
    const pre = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const post = !after ? "\n" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
    const at = s + pre.length;
    edReplace(s, e, pre + text + post, at + (selFrom ?? text.length), at + (selTo ?? selFrom ?? text.length));
  }
  function mdCode() {
    const s = notesTa.selectionStart, e = notesTa.selectionEnd, v = notesTa.value, sel = v.slice(s, e);
    if (sel && !sel.includes("\n")) return mdWrap("`", "`", "code");
    if (!sel) {
      const ls = v.lastIndexOf("\n", s - 1) + 1;
      let le = v.indexOf("\n", s);
      if (le < 0) le = v.length;
      if (v.slice(ls, le).trim()) return mdWrap("`", "`", "code"); // in the middle of a line: inline code
    }
    insertBlock("```\n" + sel + "\n```", 4, 4 + sel.length);
  }
  // a link in the page: the words show, the address stays hidden (Ctrl+click opens it)
  let lnPop = null;
  function closeLinkPop() {
    if (!lnPop) return false;
    lnPop.remove();
    lnPop = null;
    return true;
  }
  function mdLink() {
    if (closeLinkPop()) return;
    const s = notesTa.selectionStart, e = notesTa.selectionEnd, sel = notesTa.value.slice(s, e).trim();
    const isUrl = /^https?:\/\/\S+$/.test(sel);
    lnPop = el("div", "npop expop lnpop");
    lnPop.innerHTML = `<label class="lbl">Text<input type="text" id="lnText" spellcheck="false" /></label>
      <label class="lbl">Address<input type="text" id="lnUrl" spellcheck="false" /></label>
      <div class="exbtns"><button id="lnCancel">Cancel</button><button id="lnOk">Insert</button></div>`;
    root.append(lnPop);
    lnPop.querySelector("#lnText").value = isUrl ? "" : sel;
    lnPop.querySelector("#lnUrl").value = isUrl ? sel : "";
    const r = $("notesText").getBoundingClientRect(), m = lnPop.getBoundingClientRect();
    lnPop.style.left = clamp(r.left + 40, 8, innerWidth - m.width - 8) + "px";
    lnPop.style.top = clamp(r.top + 30, 8, innerHeight - m.height - 8) + "px";
    setTimeout(() => lnPop && lnPop.querySelector(isUrl || !sel ? "#lnText" : "#lnUrl").focus(), 0);
    lnPop.querySelector("#lnCancel").onclick = () => (closeLinkPop(), notesTa.focus());
    lnPop.querySelector("#lnOk").onclick = () => {
      let url = lnPop.querySelector("#lnUrl").value.trim();
      if (!url) return flash("Type the address");
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      const text = lnPop.querySelector("#lnText").value.trim().replace(/[\[\]\n]/g, "") || url.replace(/^https?:\/\/(www\.)?/, "");
      closeLinkPop();
      const out = `[${text}](${url})`;
      edReplace(s, e, out, s + out.length);
    };
  }
  function mdTime() {
    if (notesVid !== state.videoId) return flash("Open this video to add its time");
    const v = getVideo();
    if (!v) return;
    insertInline(`[${NL.fmtTime(v.currentTime)}] `);
  }
  function mdLoopRef() {
    if (notesVid !== state.videoId) return flash("Open this video to add its loop");
    if (!loopValid()) return flash("Set A and B first");
    insertInline(`[${NL.fmtTime(state.a)}-${NL.fmtTime(state.b)}] `);
  }
  function indentLines(outdent) {
    const [ls, le] = lineRange();
    const old = notesTa.value.slice(ls, le);
    const lines = old.split("\n");
    const text = lines.map((l) => (outdent ? l.replace(/^( {1,2}|\t)/, "") : "  " + l)).join("\n");
    if (text === old) return;
    if (lines.length === 1) {
      const caret = clamp(notesTa.selectionStart + (text.length - old.length), ls, ls + text.length);
      edReplace(ls, le, text, caret);
    } else edReplace(ls, le, text, ls, ls + text.length);
  }
  // Enter in a list carries on the list; Enter on an empty item ends it
  function continueList() {
    const s = notesTa.selectionStart;
    if (s !== notesTa.selectionEnd) return false;
    const v = notesTa.value;
    const ls = v.lastIndexOf("\n", s - 1) + 1;
    let le = v.indexOf("\n", s);
    if (le < 0) le = v.length;
    const line = v.slice(ls, s);
    const m = line.match(/^(\s*)((?:>\s?)*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?/);
    if (!m) {
      const q = line.match(/^\s*(?:>\s?)+/);
      if (!q) return false;
      if (!line.slice(q[0].length).trim() && !v.slice(s, le).trim()) edReplace(ls, s, "");
      else edReplace(s, s, "\n" + q[0]);
      return true;
    }
    if (!line.slice(m[0].length).trim() && !v.slice(s, le).trim()) {
      edReplace(ls, s, ""); // empty item: end the list
      return true;
    }
    let marker = m[3];
    if (/\d/.test(marker)) marker = parseInt(marker, 10) + 1 + marker.slice(-1);
    edReplace(s, s, "\n" + m[1] + m[2] + marker + m[4] + (m[5] ? "[ ] " : ""));
    return true;
  }
  // PDF: the page (with its chord shapes and links) laid out for printing; choose "Save as PDF" in the print window
  const PRINT_CSS = `
    @page { margin: 16mm; }
    body { font-family: Roboto, Arial, sans-serif; color: #111; margin: 0; }
    h1 { font-size: 18px; margin: 0 0 10px; }
    pre { font: 12px/1.45 "Roboto Mono", Consolas, Menlo, monospace; white-space: pre-wrap; margin: 0; }
    pre * { font-family: inherit; } pre b, pre strong { font-weight: 700; }
    pre .h1, pre .h2, pre .h3 { font-family: Roboto, Arial, sans-serif; font-weight: 700; } pre .h1 { font-size: 17px; } pre .h2 { font-size: 15px; } pre .h3 { font-size: 13px; }
    pre .q { color: #555; border-left: 3px solid #ccc; padding-left: 8px; display: inline-block; }
    pre .hr { display: inline-block; width: 100%; border-top: 1px solid #bbb; vertical-align: middle; }
    pre mark { background: #fff3a8; } .hl-yellow { background:#ffe36e; } .hl-green { background:#a8eea0; } .hl-blue { background:#a6d8ff; } .hl-pink { background:#ffb8dc; } .hl-orange { background:#ffc98a; } .hl-purple { background:#d6c2ff; }
    .fc-red { color:#e53935; } .fc-blue { color:#1e88e5; } .fc-green { color:#2e9d44; } .fc-orange { color:#ef7d00; } .fc-purple { color:#9c3bc0; } .fc-gray { color:#8a8a8a; } pre code { background: #f1f1f1; padding: 0 2px; } pre a.ts { color: #065fd4; text-decoration: none; }
    .shapes { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }
    .shapes svg { width: 74px; height: auto; }
    h2 { font-size: 13px; margin: 18px 0 6px; }
    ul { margin: 0; padding-left: 18px; font-size: 12px; }
    li { margin: 3px 0; } a { color: #065fd4; } .c { color: #555; }
    .meta { font-size: 12px; line-height: 1.5; margin: 0 0 10px; }
    .pg { position: relative; } .pg .live { font: var(--edfs)/1.5 var(--edff); white-space: pre; padding: 10px 12px; color: #111; }
    .pg .pink { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
    .scneck { overflow: visible !important; margin: 6px 0 12px; } .scneck svg { width: 100%; height: auto; }
    .sctab { max-height: none !important; overflow: visible !important; }
    .cgboxes { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 10px; } .cgbox { cursor: default; }
    .cfprint { display: flex; gap: 24px; align-items: flex-start; } .cfprint svg { width: 300px; height: auto; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .cd-name { fill: #111; font: 700 12px Roboto, Arial, sans-serif; text-anchor: middle; }
    .cd-line { stroke: #777; stroke-width: 1; } .cd-nut { fill: #111; }
    .cd-fr, .cd-mark { fill: #555; font: 600 10px Roboto, Arial, sans-serif; text-anchor: middle; }
    .cd-open { fill: none; stroke: #555; stroke-width: 1.3; }
    .cd-dot, .cd-barre { fill: #333; } .cd-dot.root { fill: #d9463b; }
    .cd-fi { fill: #fff; font: 700 9px Roboto, Arial, sans-serif; text-anchor: middle; }
    .cd-capo { fill: #8a6a4a; } .cd-capol, .cd-sounds { fill: #8a6a4a; font: 600 11px Roboto, Arial, sans-serif; } .cd-sounds { text-anchor: middle; }
    .cd-capofr { fill: #8a6a4a; font: 700 8.5px Roboto, Arial, sans-serif; text-anchor: end; } .cd-capob { font-size: 9px; text-anchor: middle; }`;
  // print a page in a hidden frame, styled like the Day theme; the print window has "Save as PDF"
  function printDoc(title, body, landscape) {
    const appCss = (root.querySelector("style")?.textContent || "")
      .replace(/:host\(\[data-theme="light"\]\)/g, ":root")
      .replace(/:host\s*\{/, ".ygc-unused {");
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${NL.esc(title)}</title><style>${appCss}${PRINT_CSS}${landscape ? "@page { size: landscape; }" : ""}</style></head><body>${body}</body></html>`;
    document.getElementById("ygc-print")?.remove();
    const f = document.createElement("iframe");
    f.id = "ygc-print";
    f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(f);
    const d = f.contentDocument;
    d.open();
    d.write(html);
    d.close();
    setTimeout(() => {
      try {
        f.contentWindow.focus();
        f.contentWindow.print();
      } catch (e) {
        flash("Couldn't open the print window");
      }
      setTimeout(() => f.remove(), 60000);
    }, 250);
  }
  async function printNotesPdf(o = {}) {
    const v = notesEntry();
    const name = v ? v.name || v.title : videoTitle();
    let text = notesTa.value.replace(/\s+$/, "");
    const lines = text.split("\n");
    if (lines[0].replace(/^#{1,3}\s+/, "").trim() === name.trim()) text = lines.slice(1).join("\n").replace(/^\n+/, "");
    const esc = NL.esc;
    const used = o.chords ? [...new Set([...NL.sheetChords(notesTa.value), ...sideChords().filter((c) => NL.isChord(c))])] : [];
    const shapes = used.length ? `<div class="shapes">${used.map((c) => NL.chordDiagramSvg(c, withCapo(NL.chordShape(c)), { rootPc: NL.chordRootPc(c) })).join("")}</div>` : "";
    const links = (o.links && v && v.links) || [];
    const linkList = links.length
      ? `<h2>Links</h2><ul>${links.map((k) => `<li><a href="${esc(k.url)}">${esc(k.name || k.url)}</a>${k.name ? ` <span class="c">${esc(k.url)}</span>` : ""}${k.comment ? `<br><span class="c">${esc(k.comment)}</span>` : ""}</li>`).join("")}</ul>`
      : "";
    const video = o.links && notesVid ? `<h2>Video</h2><ul><li><a href="https://www.youtube.com/watch?v=${esc(notesVid)}">https://www.youtube.com/watch?v=${esc(notesVid)}</a></li></ul>` : "";
    // the page as it looks in the editor (formatting, colours, highlights), with the drawing on top
    const full = notesTa.value.replace(/\s+$/, "");
    const live = $("notesText"), fam = fontStack(pageFontKey()), cs = chordSpacing(pageSize(), fam);
    if (!isFixedFont(pageFontKey())) cs.ls = 0;
    let W = Math.max(live.scrollWidth, 600), H = live.scrollHeight;
    for (const k of ink)
      for (let q = 0; q < k.p.length; q += 2) {
        W = Math.max(W, k.p[q] + 20);
        H = Math.max(H, k.p[q + 1] + 20);
      }
    const zoom = Math.min(1, 670 / W);
    const inkSvg = ink.length
      ? `<svg class="pink" xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${$("edInk").querySelector("defs").outerHTML}${ink.map((k) => inkEl(k, "#222").outerHTML).join("")}</svg>`
      : "";
    const page = `<div class="pgwrap" style="zoom:${zoom.toFixed(3)}"><div class="pg"><div class="live${pageColor() ? " pc-" + pageColor() : ""}" style="--edfs:${pageSize()}px;--edff:${esc(fam)};--chfs:${cs.ch}px;--chls:${cs.ls.toFixed(3)}px">${NL.liveMarkup(full).html}</div>${inkSvg}</div></div>`;
    let pageHtml = page;
    for (const m of [...page.matchAll(/data-img="([a-z0-9]+)"/g)]) {
      const d = await loadImage(m[1]);
      if (d) pageHtml = pageHtml.replace(`data-img="${m[1]}"`, `src="${d}"`);
    }
    printDoc(name, `${shapes}${pageHtml}${linkList}${video}`);
  }
  const textWithout = (node, sel) => {
    const c = node.cloneNode(true);
    c.querySelectorAll(sel).forEach((x) => x.remove());
    return c.textContent.trim();
  };
  // the scale library: what's showing (scale, CAGED or circle of fifths) as a PDF
  function printScalesPdf() {
    const esc = NL.esc, c = SC();
    const tab = ["scales", "chords", "circle", "caged", "tabs"].includes(c.tab) ? c.tab : "scales";
    if (tab === "tabs") {
      const t = tbSel();
      return t && printTab(t.name, tabMeta(t), NL.parseTab(t.text));
    }
    if (tab === "chords") {
      if (!chView) return;
      const info = NL.chordInfo(chView.name);
      return printDoc(chView.name, `<h1>${esc(NL.pretty(chView.name))}</h1><p class="meta">${esc($("chNotes").textContent)}</p><div class="shapes">${chView.shapes.map((sh) => NL.chordDiagramSvg(chView.name, sh, { rootPc: NL.chordRootPc(chView.name), width: 104, low: chView.std ? undefined : chTuning().midi.slice().reverse() })).join("")}</div>`);
    }
    if (tab === "scales") {
      if (!scView) return;
      const { tuning, scale, info, pattern } = scView;
      const title = `${NL.pretty(c.root)} ${scale.name}`;
      const tname = tuning.name.replace(/^(Guitar|Bass): /, "");
      const meta = [
        pattern.label ? pattern.label.charAt(0).toUpperCase() + pattern.label.slice(1) + (c.per ? `, ${c.per} per string` : "") : "",
        `${c.instr === "bass" ? "Bass" : "Guitar"}, ${tname}${pattern.capo ? `, capo ${pattern.capo}` : ""}`,
        `Notes: ${info.notes.map((n) => NL.pretty(n.name)).join(" ")}`,
        `Intervals: ${info.notes.map((n) => NL.pretty(n.interval)).join(" ")}`,
      ].filter(Boolean);
      const tabHtml = pattern.tab ? `<div class="md"><div class="sctab">${$("scTab").innerHTML}</div></div>` : "";
      return printDoc(title, `<h1>${esc(title)}</h1><p class="meta">${meta.map(esc).join("<br>")}</p><div class="scneck">${$("scNeck").innerHTML}</div>${tabHtml}`, true);
    }
    if (tab === "caged") {
      const cg = CG();
      const title = `${NL.pretty(cg.root)} ${cg.minor ? "minor" : "major"}: CAGED shapes`;
      return printDoc(title, `<h1>${esc(title)}</h1><div class="cgboxes">${$("cgBoxes").innerHTML}</div><div class="scneck">${$("cgNeck").innerHTML}</div><p class="meta">${esc(textWithout($("cgInfo"), "button, a"))}</p>`, true);
    }
    const key = circleKey();
    printDoc(`Key of ${NL.pretty(key.title)}`, `<h1>Circle of fifths: ${esc(NL.pretty(key.title))}</h1><div class="cfprint"><div>${$("cfSvg").innerHTML}</div><div class="cfinfo">${$("cfInfo").innerHTML.replace(/<button[\s\S]*?<\/button>/g, "")}</div></div>`);
  }
  // Export: Text File or PDF; chord shapes and links only when you tick them
  let exPop = null;
  function closeExport() {
    if (!exPop) return false;
    exPop.remove();
    exPop = null;
    $("edExport").classList.remove("open");
    return true;
  }
  function openExport() {
    if (closeExport()) return;
    const st = state.settings;
    exPop = el("div", "npop expop");
    exPop.innerHTML = `<label class="chk"><input type="checkbox" id="exChords" ${st.exportChords ? "checked" : ""}/> Include Chords</label>
      <label class="chk"><input type="checkbox" id="exLinks" ${st.exportLinks ? "checked" : ""}/> Include Links</label>
      <div class="exbtns"><button id="exTxt">Text File</button><button id="exPdf" title="PDF">PDF</button><button id="exPrint" title="Print">Print</button></div>`;
    root.append(exPop);
    const r = $("edExport").getBoundingClientRect(), m = exPop.getBoundingClientRect();
    exPop.style.left = clamp(r.right - m.width, 8, innerWidth - m.width - 8) + "px";
    exPop.style.top = (r.bottom + 6 + m.height < innerHeight ? r.bottom + 6 : Math.max(8, r.top - m.height - 6)) + "px";
    $("edExport").classList.add("open");
    const opts = () => {
      st.exportChords = exPop.querySelector("#exChords").checked;
      st.exportLinks = exPop.querySelector("#exLinks").checked;
      persist();
      return { chords: st.exportChords, links: st.exportLinks };
    };
    exPop.querySelector("#exChords").addEventListener("change", opts);
    exPop.querySelector("#exLinks").addEventListener("change", opts);
    exPop.querySelector("#exTxt").addEventListener("click", () => {
      const o = opts();
      closeExport();
      downloadNotes(o);
    });
    exPop.querySelector("#exPrint").addEventListener("click", () => {
      const o = opts();
      closeExport();
      printNotesPdf(o);
    });
    exPop.querySelector("#exPdf").addEventListener("click", () => {
      const o = opts();
      closeExport();
      printNotesPdf(o);
    });
  }
  $("edExport").addEventListener("click", openExport);

  window.addEventListener(
    "mousedown",
    (e) => {
      if (!exPop) return;
      const path = e.composedPath();
      if (!path.includes(exPop) && !path.includes($("edExport"))) closeExport();
    },
    true
  );
  const shapeText = (c) => {
    const sh = NL.chordShape(c);
    return sh ? `${NL.pretty(c)}: ${fretsText(sh.frets)}${sh.capo ? ` (capo ${sh.capo})` : ""}` : NL.pretty(c);
  };
  // the page as plain text: what you see, without the formatting marks (**, ##, colours, pictures …)
  function plainText(src) {
    const r = NL.liveMarkup(src);
    const drop = [];
    for (const [a, b, atomic, , kind] of r.hidden) {
      const t = src.slice(a, b);
      if (kind === "img") {
        drop.push([a, src[b] === "\n" ? b + 1 : b]);
        continue;
      }
      if (atomic && (/^\s*[-*+]\s/.test(t) || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(t))) continue; // keep list bullets and lines
      drop.push([a, b]);
    }
    drop.sort((x, y) => x[0] - y[0]);
    let out = "", at = 0;
    for (const [a, b] of drop) {
      if (a < at) continue;
      out += src.slice(at, a);
      at = b;
    }
    return out + src.slice(at);
  }
  function downloadNotes(o = {}) {
    saveNotesNow();
    const v = notesEntry();
    const name = v ? v.name || v.title : videoTitle();
    let text = plainText(notesTa.value).replace(/\s+$/, "");
    if (!text.trimStart().startsWith(name)) text = `${name}\n\n` + text;
    const used = o.chords ? [...new Set([...NL.sheetChords(notesTa.value), ...sideChords().filter((c) => NL.isChord(c))])] : [];
    if (used.length) {
      // the chord shapes go at the top, under the title
      const ls = text.split("\n");
      ls.splice(1, 0, "", "Chords", ...used.map(shapeText));
      text = ls.join("\n");
    }
    const links = (o.links && v && v.links) || [];
    if (links.length) text += "\n\nLinks\n" + links.map((k) => [k.name, k.url, k.comment].filter(Boolean).join(" — ")).join("\n");
    saveFileAs(safeName(name, "video"), "txt", "text/plain", "Text file", () => new Blob([text.endsWith("\n") ? text : text + "\n"], { type: "text/plain" }));
  }
  function mdAction(k) {
    if (k.startsWith("loopins:")) return insertLoopLine(k.slice(8));
    if (k.startsWith("hl:")) return mdHighlight(k.slice(3));
    if (k.startsWith("fc:")) return mdHighlight(k.slice(3), true);
    if (notesMode() === "preview" && !["download", "wrap", "scales", "chords"].includes(k)) {
      state.settings.notesMode = "split"; // the buttons edit the text, so show it
      persist();
      applyNotesMode();
      renderPreview();
    }
    switch (k) {
      case "undo":
        return notesTa.undo();
      case "redo":
        return notesTa.redo();
      case "p":
        return mdLines("p");
      case "highlight":
        return mdWrap("==", "==", "text");
      case "inlinecode":
        return mdWrap("`", "`", "code");
      case "codeblock": {
        const sel = notesTa.value.slice(notesTa.selectionStart, notesTa.selectionEnd);
        return insertBlock("```\n" + sel + "\n```", 4, 4 + sel.length);
      }
      case "bold":
        return mdWrap("**", "**", "bold text");
      case "italic":
        return mdWrap("*", "*", "italic text");
      case "sup":
        return mdWrap("^^", "^^", "text");
      case "sub":
        return mdWrap(",,", ",,", "text");
      case "upper":
      case "lower":
        return mdCase(k);
      case "strike":
        return mdWrap("~~", "~~", "text");
      case "h1":
      case "h2":
      case "h3":
      case "ul":
      case "ol":
      case "task":
      case "quote":
        return mdLines(k);
      case "code":
        return mdCode();
      case "link":
        return mdLink();
      case "table":
        return insertBlock("| Part | Time | Chords / notes |\n|---|---|---|\n| Intro | [0:00] |  |\n| Verse |  |  |", 2, 6);
      case "hr":
        return insertBlock("---");
      case "time":
        return mdTime();
      case "loop":
        return mdLoopRef();
      case "tab":
        return openTabEditor(NL.tabBlockAt(notesTa.value, notesTa.selectionStart));
      case "scales":
        return openScales("scales");
      case "chords":
        return openScales("chords");
      case "links":
        return openLinks(notesVid);
      case "lyrics":
        return openLyricsAsk();
      case "key":
        return openGuessKey();
      case "image":
        return $("edImgFile").click();
      case "wrap":
        state.settings.notesWrap = state.settings.notesWrap === false;
        persist();
        return applyNotesMode();
      case "download":
        return downloadNotes();

    }
  }

  // ----- lyrics: read from the video's captions, when it has any -----
  function askPage(type, data, ms = 2500) {
    const id = newId();
    return new Promise((resolve) => {
      const done = (v) => (window.removeEventListener("message", on), clearTimeout(t), resolve(v));
      const on = (e) => e.source === window && e.data && e.data.source === "ygc2-page" && e.data.type === type && e.data.id === id && done(e.data);
      const t = setTimeout(() => done(null), ms);
      window.addEventListener("message", on);
      window.postMessage({ source: "ygc2", type, id, ...data }, "*");
    });
  }
  async function fetchJson3(url) {
    try {
      const u = new URL(url, location.href);
      u.searchParams.set("fmt", "json3");
      u.searchParams.delete("tlang");
      const r = await fetch(u.href, { credentials: "include" });
      const txt = r.ok ? await r.text() : "";
      const ev = txt.trim() ? NL.json3Events(JSON.parse(txt)) : [];
      return ev.length ? ev : null;
    } catch (e) {
      return null;
    }
  }
  // the transcript YouTube shows under the description, opened for a moment and read
  async function transcriptFromPage() {
    const segs = () => [...document.querySelectorAll("ytd-transcript-segment-renderer, transcript-segment-view-model")];
    let opened = false;
    if (!segs().length) {
      const btn = document.querySelector("ytd-video-description-transcript-section-renderer button, #primary button[aria-label='Show transcript']");
      if (!btn) return null;
      btn.click();
      opened = true;
      for (let i = 0; i < 40 && !segs().length; i++) await new Promise((r) => setTimeout(r, 150));
    }
    const ev = segs()
      .map((x) => {
        const ts = x.querySelector(".segment-timestamp, [class*='Timestamp']");
        const tx = x.querySelector(".segment-text, span.yt-core-attributed-string, [class*='SegmentText']");
        return { t: ts ? NL.parseTime(ts.textContent.trim()) : 0, d: 0, text: tx ? tx.textContent : "" };
      })
      .filter((x) => x.text.trim());
    if (opened) {
      const panel = document.querySelector("ytd-engagement-panel-section-list-renderer[target-id*='transcript']");
      const close = panel && panel.querySelector("#visibility-button button, button[aria-label='Close transcript']");
      if (close) close.click();
    }
    return ev.length ? ev : null;
  }
  async function getLyrics(videoId) {
    const res = await askPage("caption-tracks", { videoId });
    const tracks = (res && res.tracks) || [];
    const track = NL.pickCaptionTrack(tracks, document.documentElement.lang || navigator.language);
    let events = null;
    if (track) {
      events = await fetchJson3(track.baseUrl);
      // YouTube may want the token the player uses: borrow an address the player already loaded
      for (const seen of !events ? (res && res.seen) || [] : []) {
        const u = new URL(seen, location.href);
        u.searchParams.set("lang", track.languageCode);
        if (track.kind) u.searchParams.set("kind", track.kind);
        else u.searchParams.delete("kind");
        if ((events = await fetchJson3(u.href))) break;
      }
    }
    const auto = track ? track.kind === "asr" : true;
    if (!events) events = await transcriptFromPage();
    if (!events) return null;
    return { text: NL.captionsToLyrics(events, { times: !!state.settings.lyricsTimes }), auto };
  }
  const LY_ASK = "If the video has closed captions or subtitles, finding the lyrics is likely. They’re added at the cursor. This tool is not perfect. There may be mistakes. Check it.";
  const LY_NONE = "This video doesn’t contain any closed captions or subtitles, so the lyrics can’t be found.";
  // does the video have captions or a transcript? (null: couldn't tell)
  async function hasCaptions(videoId) {
    if (document.querySelector("ytd-video-description-transcript-section-renderer button")) return true;
    const res = await askPage("caption-tracks", { videoId }, 1500);
    if (!res) return null;
    return !!(res.tracks && res.tracks.length);
  }
  async function openLyricsAsk() {
    const show = (text, go) => {
      $("lyBody").textContent = text;
      $("lyOpt").hidden = !go;
      $("lyGo").hidden = !go;
      $("lyGo").disabled = false;
      $("lyModal").classList.add("show");
      setTimeout(() => (go ? $("lyGo") : $("lyCancel")).focus(), 0);
    };
    $("lyTimes").checked = !!state.settings.lyricsTimes;
    if (!state.videoId || notesVid !== state.videoId) return show("Play this video first: lyrics come from the video that’s playing.", false);
    show("Checking for closed captions or subtitles…", false);
    const has = await hasCaptions(state.videoId);
    if (!$("lyModal").classList.contains("show")) return;
    if (has === false) return show(LY_NONE, false);
    show(LY_ASK, true);
  }
  function closeLyricsAsk() {
    $("lyModal").classList.remove("show");
    if (notesOpen() && notesMode() !== "preview") notesTa.focus();
  }
  $("lyGo").onclick = () => insertLyrics();
  $("lyTimes").addEventListener("change", (e) => {
    state.settings.lyricsTimes = e.target.checked;
    persist();
  });
  $("lyCancel").onclick = $("lyClose").onclick = closeLyricsAsk;
  $("lyModal").addEventListener("click", (e) => e.target === $("lyModal") && closeLyricsAsk());
  // ----- guess the key from the song's chords -----
  let gkBest = null;
  const keyName = (k) => `${NL.pretty(k.root)} ${k.minor ? "Minor" : "Major"}`;
  function openGuessKey() {
    const chords = NL.songChords(notesTa.value);
    const extra = sideChords().filter((c) => NL.parseChord(c));
    const all = chords.length ? chords : extra;
    const box = $("gkBody");
    box.innerHTML = "";
    gkBest = null;
    if (!all.length) {
      box.append(el("p", "", "No chords found on the page. Put chords above the words (or add some to the Chord Library) and try again."));
    } else {
      const list = NL.guessKey(all);
      gkBest = list[0];
      const rel = NL.keyInfo(gkBest.root, gkBest.minor).relative;
      box.append(el("div", "gkkey", keyName(gkBest)));
      box.append(el("p", "muted", `Relative: ${NL.pretty(String(rel)).replace(/\b(major|minor)\b/, (w) => w[0].toUpperCase() + w.slice(1))}`));
      const capo = pageCapo();
      if (capo) box.append(el("p", "", `With capo ${capo} it sounds in ${NL.pretty(NL.transposeRoot(gkBest.root, capo))} ${gkBest.minor ? "Minor" : "Major"}.`));
      const relPc = (NL.chordRootPc(gkBest.root) + (gkBest.minor ? 3 : 9)) % 12;
      const others = list
        .slice(1)
        .filter((k) => !(k.minor !== gkBest.minor && NL.chordRootPc(k.root) === relPc)) // the relative key is shown above
        .filter((k) => k.score > 0 && k.score >= gkBest.score * 0.75)
        .slice(0, 2);
      if (others.length) box.append(el("p", "muted", `Also possible: ${others.map(keyName).join(", ")}`));
      const uniq = [...new Set(all)];
      box.append(el("p", "muted", `From ${uniq.length} chord${uniq.length > 1 ? "s" : ""}: ${uniq.slice(0, 12).map((c) => NL.pretty(c)).join(" ")}${uniq.length > 12 ? " …" : ""}`));
      box.append(el("p", "muted", "This tool is not perfect. Check it by ear."));
    }
    $("gkIns").hidden = !gkBest;
    $("gkModal").classList.add("show");
    setTimeout(() => (gkBest ? $("gkIns") : $("gkCancel")).focus(), 0);
  }
  function closeGuessKey() {
    $("gkModal").classList.remove("show");
    if (notesOpen() && notesMode() !== "preview") notesTa.focus();
  }
  // "Key: G Major" under the title (and under the capo line, if there is one); an old key line is replaced
  $("gkIns").onclick = () => {
    if (!gkBest || !notesOpen()) return closeGuessKey();
    const v = notesTa.value, ls = v.split("\n");
    const line = `Key: ${keyName(gkBest)}`;
    const old = ls.slice(0, 6).findIndex((l) => /^\s*key\s*:/i.test(l));
    closeGuessKey();
    if (old >= 0) {
      const a = ls.slice(0, old).join("\n").length + (old ? 1 : 0);
      edReplace(a, a + ls[old].length, line);
    } else {
      const capoAt = ls.slice(0, 4).findIndex((l) => CAPO_RE.test(l));
      const after = capoAt >= 0 ? capoAt : 0;
      const a = ls.slice(0, after + 1).join("\n").length;
      edReplace(a, a, "\n" + line);
    }
    renderPreview();
  };
  $("gkCancel").onclick = $("gkClose").onclick = closeGuessKey;
  $("gkModal").addEventListener("click", (e) => e.target === $("gkModal") && closeGuessKey());
  let lyricsBusy = false;
  async function insertLyrics() {
    if (lyricsBusy) return;
    const say = (t) => (($("lyBody").textContent = t), ($("lyGo").hidden = true), ($("lyOpt").hidden = true), $("lyModal").classList.add("show"));
    if (!state.videoId || notesVid !== state.videoId) return say("Play this video first: lyrics come from the video that’s playing.");
    const btn = $("edLyrics");
    $("lyBody").textContent = "Looking for closed captions or subtitles…";
    $("lyGo").disabled = true;
    lyricsBusy = true;
    btn.classList.add("busy");
    btn.disabled = true;
    let got = null;
    try {
      got = await getLyrics(state.videoId);
    } finally {
      lyricsBusy = false;
      btn.classList.remove("busy");
      btn.disabled = false;
    }
    $("lyGo").disabled = false;
    if (!got || !got.text.trim()) return say(LY_NONE);
    $("lyModal").classList.remove("show");
    if (!notesOpen()) return;
    insertBlock(`[Lyrics${got.auto ? ": Auto Captions" : ""}]\n${got.text}`);
    renderPreview();
  }

  // ----- toolbar menus -----
  let notesMenu = null;
  const MENUS = {
    style: () => [
      { icon: "paragraph", label: "Paragraph", md: "p" },
      { icon: "h1", label: "Heading 1", hint: "#", md: "h1" },
      { icon: "h2", label: "Heading 2", hint: "##", md: "h2" },
      { icon: "h3", label: "Heading 3", hint: "###", md: "h3" },
      { icon: "quote", label: "Quote", hint: ">", md: "quote" },
    ],
    text: () => [
      { icon: "strike", label: "Strikethrough", hint: "~~", md: "strike" },
      { icon: "code", label: "Code", hint: "`", md: "inlinecode" },
      { icon: "sup", label: "Superscript", hint: "^^", md: "sup" },
      { icon: "sub", label: "Subscript", hint: ",,", md: "sub" },
      "-",
      { icon: "caseUp", label: "Upper Case", hint: "AA", md: "upper" },
      { icon: "caseLow", label: "Lower Case", hint: "aa", md: "lower" },
    ],
    fcolor: () => [
      ...FC.map(([c, name]) => ({ swatch: "fc-" + c, label: name, md: "fc:" + c })),
      "-",
      { icon: "fontColor", label: "Default Colour", md: "fc:" },
    ],
    highlight: () => [
      ...HL.map(([c, name]) => ({ swatch: c, label: name, md: "hl:" + c })),
      "-",
      { icon: "highlighter", label: "No Highlight", md: "hl:" },
    ],
    list: () => [
      { icon: "ul", label: "Bulleted List", hint: "-", md: "ul" },
      { icon: "ol", label: "Numbered List", hint: "1.", md: "ol" },
      { icon: "task", label: "Checklist", hint: "- [ ]", md: "task" },
    ],
    loops: () => {
      const v = notesEntry();
      const ls = (v && v.loops) || [];
      const out = [{ head: ls.length ? "Put a loop here" : "No loops saved for this video yet" }];
      ls.forEach((l, k) => out.push({ icon: "loop", label: `${k + 1}. ${l.name}`, hint: fmtRange(l), md: "loopins:" + l.id }));
      if (notesVid === state.videoId && loopValid() && !selectedLoop()) out.push("-", { icon: "loop", label: "A–B now (not saved)", hint: `${fmt(state.a)}–${fmt(state.b)}`, md: "loopins:" });
      return out;
    },
    guess: () => [
      { icon: "mic", label: "Lyrics", md: "lyrics" },
      { icon: "key", label: "Key", md: "key" },
    ],
    insert: () => [
      { icon: "ul", label: "Bulleted List", hint: "-", md: "ul" },
      { icon: "ol", label: "Numbered List", hint: "1.", md: "ol" },
      { icon: "task", label: "Checklist", hint: "- [ ]", md: "task" },
      "-",
      { icon: "image", label: "Picture…", md: "image" },
      { icon: "link", label: "Link", hint: "Ctrl+K", md: "link" },
      { icon: "table", label: "Table", md: "table" },
      { icon: "codeBlock", label: "Code Block", md: "codeblock" },
      { icon: "hline", label: "Horizontal Line", md: "hr" },
    ],
  };
  function closeMenu() {
    if (!notesMenu) return false;
    notesMenu.anchor.classList.remove("open");
    notesMenu.el.remove();
    notesMenu = null;
    return true;
  }
  function openMenu(anchor) {
    const name = anchor.dataset.menu;
    const wasOpen = notesMenu && notesMenu.anchor === anchor;
    closeMenu();
    if (wasOpen) return;
    const pop = el("div", "npop");
    pop.setAttribute("role", "menu");
    for (const it of MENUS[name]()) {
      if (it === "-") {
        pop.append(el("div", "sep"));
        continue;
      }
      if (it.head) {
        pop.append(el("div", "head", it.head));
        continue;
      }
      const b = el("button");
      b.setAttribute("role", "menuitem");
      b.innerHTML = it.swatch ? `<span class="swatch ${it.swatch.startsWith("fc-") ? "sw-" + it.swatch : "hl-" + it.swatch}"></span>` : ic(it.icon, 15);
      b.append(el("span", "lab", it.label));
      if (it.hint) b.append(el("span", "hint", it.hint));
      b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor in the text
      b.addEventListener("click", () => {
        closeMenu();
        mdAction(it.md);
      });
      pop.append(b);
    }
    pop.addEventListener("keydown", (e) => {
      const items = [...pop.querySelectorAll("button")];
      const i = items.indexOf(root.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
      } else if (e.key === "Tab") {
        e.preventDefault();
        closeMenu();
        notesTa.focus();
      }
    });
    root.append(pop);
    const r = anchor.getBoundingClientRect(), m = pop.getBoundingClientRect();
    pop.style.left = clamp(r.left, 8, innerWidth - m.width - 8) + "px";
    pop.style.top = (r.bottom + 6 + m.height < innerHeight ? r.bottom + 6 : Math.max(8, r.top - m.height - 6)) + "px";
    anchor.classList.add("open");
    notesMenu = { el: pop, anchor };
    if (anchor.matches(":focus-visible")) pop.querySelector("button")?.focus();
  }
  root.querySelectorAll("#notesWin .ntools [data-menu]").forEach((b) => {
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => openMenu(b));
    b.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!notesMenu || notesMenu.anchor !== b) openMenu(b);
        notesMenu?.el.querySelector("button")?.focus();
      }
    });
  });
  // a click anywhere else closes the menu
  window.addEventListener(
    "mousedown",
    (e) => {
      if (!notesMenu) return;
      const path = e.composedPath();
      if (!path.includes(notesMenu.el) && !path.includes(notesMenu.anchor)) closeMenu();
    },
    true
  );

  root.querySelectorAll("#notesWin .ntools [data-md]").forEach((b) => {
    b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor in the text
    b.addEventListener("click", () => mdAction(b.dataset.md));
  });
  notesTa.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      notesDirty = true;
      return saveNotesNow();
    }
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      return insertInline("  ");
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      const k = { b: "bold", i: "italic", k: "link" }[e.key.toLowerCase()];
      if (k) {
        e.preventDefault();
        mdAction(k);
      }
    }
  });

  // ----- tab editor: a grid of strings × columns, saved as plain ASCII tab -----
  let te = null; // { model, cur: { m, c, s }, block (the tab being edited, or null for a new one) }
  const teGrid = $("teGrid");
  const flatCols = () => te.model.measures.flatMap((m, mi) => m.map((_, ci) => [mi, ci]));
  const teInput = (m, c, s) => teGrid.querySelector(`input[data-m="${m}"][data-c="${c}"][data-s="${s}"]`);
  function openTabEditor(block) {
    if (!NL) return;
    let model = block ? NL.parseTab(block.inner) : null;
    if (!model) {
      block = null;
      const t = NL.TUNINGS.find((x) => x.id === state.settings.tabTuning) || NL.TUNINGS[0];
      model = NL.newTab(t.strings, 4, 8);
      model.perLine = state.settings.tabPerLine || 2;
    }
    te = { model, cur: { m: 0, c: 0, s: 0 }, block, id: null, capoOn: null };
    $("teName").value = "";
    $("teCapo").value = "0";
    $("teShow").value = state.settings.tabShow || "fret";
    renderCapoStrings();
    te.dirty = false;
    teDirty(null);
    $("teOk").disabled = !notesOpen();
    $("teOk").title = notesOpen() ? "Insert" : "Unavailable";
    renderTabList();
    $("teOk").textContent = block ? "Update Tab in Editor" : "Insert Tab into Editor";
    $("teErr").textContent = model.lost ? "Text between the lines of tab, or a staff with a different number of strings, will be left out when you update it." : "";
    fillTuning();
    const per = $("tePer");
    if (![...per.options].some((o) => +o.value === model.perLine)) per.append(new Option(String(model.perLine)));
    per.value = String(model.perLine);
    buildTabGrid();
    $("tabModal").classList.add("show");
    teFocus(0, 0, 0);
  }
  function closeTabEditor() {
    $("tabModal").classList.remove("show");
    te = null;
    if (notesOpen() && notesMode() !== "preview") notesTa.focus();
  }
  function fillTuning() {
    const sel = $("teTuning");
    sel.innerHTML = "";
    const known = NL.tuningFor(te.model.names);
    fillTunings(sel, NL.TUNINGS);
    if (!known) sel.prepend(new Option(`Custom: ${te.model.names.join(" ")}`, "custom"));
    sel.value = known ? known.id : "custom";
  }
  function buildTabGrid() {
    const { model } = te;
    const n = model.names.length;
    teGrid.innerHTML = "";
    const per = Math.max(1, model.perLine || 2);
    const capo = teCapo();
    teGrid.dataset.show = $("teShow").value || "fret";
    let strip = null;
    model.measures.forEach((meas, mi) => {
      if (mi % per === 0) {
        // a new line of bars, like the tab in your notes
        const wrap = el("div", "tg");
        const names = el("div", "tg-names");
        model.names.forEach((nm) => names.append(el("span", "", nm)));
        const scroll = el("div", "tg-scroll");
        strip = el("div", "tg-strip");
        scroll.append(strip);
        wrap.append(names);
        if (capo) {
          // where the capo sits: a bar across the strings it holds down
          const cp = el("div", "tg-capo");
          cp.title = `Capo ${capo}`;
          cp.append(el("b", "tg-capo-n", String(capo)));
          model.names.forEach((_, s) => cp.append(el("span", capoHas(s) ? "on" : "")));
          wrap.append(cp);
        }
        wrap.append(scroll);
        teGrid.append(wrap);
      }
      const mw = el("div", "tg-m");
      mw.append(el("div", "tg-num", String(mi + 1)));
      const bar = el("div", "tg-bar");
      bar.style.gridTemplateColumns = `repeat(${meas.length}, 28px)`;
      for (let s = 0; s < n; s++)
        for (let c = 0; c < meas.length; c++) {
          const inp = document.createElement("input");
          inp.type = "text";
          inp.maxLength = 6;
          inp.spellcheck = false;
          inp.autocomplete = "off";
          inp.dataset.m = mi;
          inp.dataset.c = c;
          inp.dataset.s = s;
          inp.value = meas[c][s] || "";
          inp.title = `${model.names[s]} string`;
          if (inp.value) inp.classList.add("filled");
          const cell = el("span", "tc");
          cell.append(inp, el("span", "tn", cellNote(s, inp.value)));
          bar.append(cell);
        }
      mw.append(bar);
      strip.append(mw);
    });
    $("teDelBar").disabled = model.measures.length <= 1;
    updateTabPreview();
  }
  const updateTabPreview = () => {}; // the grid is the view
  const TAB_MAX_FRET = 24;
  // Save is on once something changed and the tab has a name
  function teDirty(on = true) {
    if (!te) return;
    if (on != null) te.dirty = on;
    $("teSave").disabled = !(te.dirty && $("teName").value.trim());
  }
  const teCapo = () => +$("teCapo").value || 0;
  // which strings the capo holds down (a partial capo can leave some open); all of them by default
  const capoHas = (s) => !te.capoOn || te.capoOn[s] !== false;
  const capoPartial = () => !!te.capoOn && te.model.names.some((_, s) => !capoHas(s));
  function cellNote(s, v) {
    if (!v || !/\d/.test(v)) return "";
    const names = te.model.names;
    const flats = names.some((n) => /^[A-Ga-g]b/.test(n));
    return NL.tabCellNotes(v, names[s], capoHas(s) ? teCapo() : 0, flats);
  }
  function renderCapoStrings() {
    const box = $("teCapoStr");
    box.innerHTML = "";
    box.hidden = !teCapo();
    // low string first, like looking down at the neck
    te.model.names
      .map((nm, s) => [nm, s])
      .reverse()
      .forEach(([nm, s]) => {
        const b = el("button", capoHas(s) ? "on" : "", nm);
        b.title = nm;
        b.setAttribute("aria-pressed", String(capoHas(s)));
        b.onmousedown = (e) => e.preventDefault();
        b.onclick = () => {
          const n = te.model.names.length;
          if (!te.capoOn || te.capoOn.length !== n) te.capoOn = Array(n).fill(true);
          te.capoOn[s] = !capoHas(s);
          if (!te.capoOn.some(Boolean)) te.capoOn[s] = true; // the capo holds at least one string
          teDirty();
          renderCapoStrings();
          rebuildKeep();
        };
        box.append(b);
      });
  }
  function rebuildKeep() {
    const { m, c, s } = te.cur;
    buildTabGrid();
    teFocus(m, c, s);
  }
  // "Name (capo 2)" or, for a partial capo, "Name (capo 2 on A D G B)"
  function capoLabelFor(names, capo, strings) {
    if (!capo) return "";
    if (!Array.isArray(strings) || strings.length >= names.length) return `capo ${capo}`;
    const on = names.map((nm, s) => [nm, s]).filter(([, s]) => strings.includes(s)).reverse().map(([nm]) => nm);
    return `capo ${capo} on ${on.join(" ")}`;
  }
  const capoLabel = () => capoLabelFor(te.model.names, teCapo(), capoPartial() ? te.model.names.map((_, s) => s).filter(capoHas) : null);
  let teNoSelect = false;
  function teFocus(m, c, s) {
    const inp = teInput(m, c, s);
    if (inp) {
      inp.focus();
      inp.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
  teGrid.addEventListener("focusin", (e) => {
    const inp = e.target.closest("input");
    if (!inp || !te) return;
    te.cur = { m: +inp.dataset.m, c: +inp.dataset.c, s: +inp.dataset.s };
    teGrid.querySelectorAll(".colcur").forEach((x) => x.classList.remove("colcur"));
    teGrid.querySelectorAll(`input[data-m="${te.cur.m}"][data-c="${te.cur.c}"]`).forEach((x) => x.classList.add("colcur"));
    if (teNoSelect) {
      teNoSelect = false;
      inp.setSelectionRange(inp.value.length, inp.value.length);
    } else inp.select();
    $("teDelCol").disabled = te.model.measures[te.cur.m].length <= 1;
  });
  teGrid.addEventListener("input", (e) => {
    const inp = e.target.closest("input");
    if (!inp || !te) return;
    const v = NL.clampCell(NL.cleanCell(inp.value), TAB_MAX_FRET);
    if (inp.value !== v) inp.value = v;
    te.model.measures[+inp.dataset.m][+inp.dataset.c][+inp.dataset.s] = v;
    inp.classList.toggle("filled", !!v);
    teDirty();
    const tn = inp.nextElementSibling;
    if (tn) tn.textContent = cellNote(+inp.dataset.s, v);
    updateTabPreview();
  });
  function setCell(inp, v) {
    inp.value = v;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function teAddBar(focus) {
    const { model, cur } = te;
    const cols = (model.measures[cur.m] || model.measures[model.measures.length - 1] || []).length || 8;
    model.measures.push(NL.newMeasure(model.names.length, cols));
    teDirty();
    buildTabGrid();
    if (focus) teFocus(model.measures.length - 1, 0, cur.s);
  }
  teGrid.addEventListener("keydown", (e) => {
    const inp = e.target.closest("input");
    if (!inp || !te) return;
    const { m, c, s } = te.cur;
    const n = te.model.names.length;
    const flat = flatCols();
    const i = flat.findIndex(([fm, fc]) => fm === m && fc === c);
    const go = (j) => {
      j = clamp(j, 0, flat.length - 1);
      teFocus(flat[j][0], flat[j][1], s);
    };
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      return applyTab();
    }
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        return teFocus(m, c, Math.max(0, s - 1));
      case "ArrowDown":
        e.preventDefault();
        return teFocus(m, c, Math.min(n - 1, s + 1));
      case "ArrowLeft":
        e.preventDefault();
        return go(i - 1);
      case "ArrowRight":
        e.preventDefault();
        return go(i + 1);
      case "Tab":
      case " ":
      case "Enter":
        e.preventDefault();
        if (e.shiftKey) return go(i - 1);
        if (i === flat.length - 1) return teAddBar(true); // carry on into a new bar
        return go(i + 1);
      case "Delete":
        e.preventDefault();
        return setCell(inp, "");
      case "Home":
        e.preventDefault();
        return go(0);
      case "End":
        e.preventDefault();
        return go(flat.length - 1);
    }
  });
  $("teTuning").addEventListener("change", (e) => {
    const t = NL.TUNINGS.find((x) => x.id === e.target.value);
    if (!t || !te) return;
    NL.retune(te.model, t.strings);
    if (te.capoOn && te.capoOn.length !== t.strings.length) te.capoOn = null;
    renderCapoStrings();
    state.settings.tabTuning = t.id;
    persist();
    teDirty();
    te.cur.s = Math.min(te.cur.s, t.strings.length - 1);
    fillTuning();
    buildTabGrid();
    teFocus(te.cur.m, te.cur.c, te.cur.s);
  });
  $("teCapo").addEventListener("change", () => {
    if (!te) return;
    teDirty();
    renderCapoStrings();
    rebuildKeep();
  });
  $("teShow").addEventListener("change", (e) => {
    state.settings.tabShow = e.target.value;
    persist();
    if (te) rebuildKeep();
  });
  $("tePer").addEventListener("change", (e) => {
    if (!te) return;
    te.model.perLine = +e.target.value;
    teDirty();
    buildTabGrid();
    teFocus(te.cur.m, te.cur.c, te.cur.s);
  });
  root.querySelectorAll("#tabModal .tebar button").forEach((b) => b.addEventListener("mousedown", (e) => e.preventDefault()));
  root.querySelectorAll("#tabModal [data-tq]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!te) return;
      const inp = teInput(te.cur.m, te.cur.c, te.cur.s);
      if (!inp) return;
      setCell(inp, NL.cleanCell(inp.value + b.dataset.tq));
      teNoSelect = true;
      inp.blur();
      inp.focus();
    })
  );
  const teTranspose = (n) => {
    if (!te) return;
    if (!NL.transposeTab(te.model, n)) return flash("Can't go lower: a note is already on the open string");
    if (te.model.measures.some((m) => m.some((col) => col.some((v) => /\d+/.test(v) && Math.max(...v.match(/\d+/g).map(Number)) > TAB_MAX_FRET)))) {
      NL.transposeTab(te.model, -n);
      return flash(`Can't go higher than fret ${TAB_MAX_FRET}`);
    }
    teDirty();
    const { m, c, s } = te.cur;
    buildTabGrid();
    teFocus(m, c, s);
  };
  $("teDown").onclick = () => teTranspose(-1);
  $("teUp").onclick = () => teTranspose(1);
  $("teAddBar").onclick = () => te && teAddBar(true);
  $("teDelBar").onclick = () => {
    if (!te || te.model.measures.length <= 1) return;
    te.model.measures.splice(te.cur.m, 1);
    teDirty();
    const m = Math.min(te.cur.m, te.model.measures.length - 1);
    buildTabGrid();
    teFocus(m, 0, te.cur.s);
  };
  $("teInsCol").onclick = () => {
    if (!te) return;
    const { m, c, s } = te.cur;
    te.model.measures[m].splice(c, 0, NL.emptyCol(te.model.names.length));
    teDirty();
    buildTabGrid();
    teFocus(m, c, s);
  };
  $("teDelCol").onclick = () => {
    if (!te) return;
    const { m, c, s } = te.cur;
    if (te.model.measures[m].length <= 1) return;
    te.model.measures[m].splice(c, 1);
    teDirty();
    buildTabGrid();
    teFocus(m, Math.min(c, te.model.measures[m].length - 1), s);
  };
  $("teClear").onclick = () => {
    if (!te) return;
    te.model.measures.forEach((m) => m.forEach((col) => col.fill("")));
    teDirty();
    buildTabGrid();
    teFocus(0, 0, 0);
  };
  function applyTab() {
    if (!te || !notesOpen()) return;
    let text = NL.formatTab(te.model);
    const nm = $("teName").value.trim(), cl = capoLabel();
    if (!te.block && (nm || cl)) text = `${nm || "Tab"}${cl ? ` (${cl})` : ""}\n\n` + text;
    const b = te.block;
    state.settings.tabPerLine = te.model.perLine;
    persist();
    closeTabEditor();
    if (scOpen()) closeScales();
    const block = b && b.fenced ? "```" + b.lang + "\n" + text + "\n```" : text;
    if (b) edReplace(b.startOff, b.endOff, block);
    else insertRuled(block);
    renderPreview();
  }
  // a tab on paper: its name, tuning and capo, and the staff
  function printTab(name, meta, model) {
    if (!model) return;
    const esc = NL.esc;
    printDoc(name, `<h1>${esc(name)}</h1>${meta ? `<p class="meta">${esc(meta)}</p>` : ""}<div class="md"><div class="sctab">${NL.staffHtml(model)}</div></div>`);
  }
  // ----- the Tabs tab in Chords, Scales, and Tabs: your saved tabs to look at, print, edit or insert -----
  const tbSel = () => myTabs.find((t) => t.id === SC().tabSel) || null;
  function tabMeta(t) {
    const model = NL.parseTab(t.text);
    const tn = model && NL.tuningFor(model.names);
    const cap = model ? capoLabelFor(model.names, t.capo || 0, t.capoStrings) : t.capo ? `capo ${t.capo}` : "";
    return [tn ? tn.name : model ? model.names.join(" ") : "", cap.charAt(0).toUpperCase() + cap.slice(1)].filter(Boolean).join(" · ");
  }
  function savedTabText(t) {
    const model = NL.parseTab(t.text);
    const cap = model ? capoLabelFor(model.names, t.capo || 0, t.capoStrings) : "";
    return `${t.name}${cap ? ` (${cap})` : ""}\n\n${t.text}`;
  }
  function renderTabsPane() {
    $("tbSearch").hidden = !myTabs.length;
    const q = $("tbSearch").value.trim().toLowerCase();
    const list = $("tbList");
    list.innerHTML = "";
    if (!tbSel() && myTabs.length) SC().tabSel = myTabs.slice().sort((a, b) => a.name.localeCompare(b.name))[0].id;
    const shown = myTabs
      .filter((t) => !q || t.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const t of shown) {
      const b = el("button", t.id === SC().tabSel ? "active" : "");
      b.dataset.id = t.id;
      b.append(el("span", "", t.name), el("span", "f", t.capo ? `Capo ${t.capo}` : NL.parseTab(t.text)?.names.slice().reverse().join("") || ""));
      list.append(b);
    }
    if (!shown.length) list.append(el("div", "none", myTabs.length ? "No tab matches that." : "No saved tabs yet."));
    const t = tbSel();
    const model = t && NL.parseTab(t.text);
    $("tbName").textContent = t ? t.name : "";
    $("tbMeta").textContent = t ? tabMeta(t) : "";
    $("tbView").innerHTML = model ? NL.staffHtml(model) : "";
    $("tbEdit").hidden = $("tbDel").hidden = !t;
  }
  $("tbSearch").addEventListener("input", renderTabsPane);
  $("tbList").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (!b) return;
    SC().tabSel = b.dataset.id;
    persist();
    renderLib();
  });
  $("tbList").addEventListener("dblclick", (e) => e.target.closest("button[data-id]") && $("tbEdit").click());
  function openNewTab() {
    openTabEditor(null);
    $("teName").focus();
  }
  $("tbNew").onclick = openNewTab;
  $("tbEdit").onclick = () => {
    const t = tbSel();
    if (!t) return;
    openTabEditor(null);
    loadTab(t);
  };
  $("tbDel").onclick = () => {
    const t = tbSel();
    if (!t) return;
    myTabs = myTabs.filter((x) => x.id !== t.id);
    saveMyTabs();
    SC().tabSel = null;
    renderLib();
  };
  // ----- my tabs: named tabs kept for every video -----
  let myTabs = [];
  const saveMyTabs = () => store.set("tabs", myTabs);
  function renderTabList() {
    const sel = $("teList");
    sel.innerHTML = "";
    sel.append(new Option(myTabs.length ? "My Tabs…" : "No Saved Tabs", ""));
    myTabs
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((t) => sel.append(new Option(t.name, t.id)));
    sel.value = te && te.id && myTabs.some((t) => t.id === te.id) ? te.id : "";
    $("teDel").hidden = !(te && te.id);
    sel.hidden = !myTabs.length; // no saved tabs: nothing to pick from
  }
  function loadTab(t) {
    const model = NL.parseTab(t.text) || NL.newTab(NL.TUNINGS[0].strings, 4, 8);
    model.perLine = t.perLine || model.perLine || 2;
    te.model = model;
    te.id = t.id;
    te.cur = { m: 0, c: 0, s: 0 };
    $("teName").value = t.name;
    $("teCapo").value = String(t.capo || 0);
    const n = model.names.length;
    te.capoOn = Array.isArray(t.capoStrings) ? Array.from({ length: n }, (_, s) => t.capoStrings.includes(s)) : null;
    renderCapoStrings();
    fillTuning();
    $("tePer").value = String(model.perLine);
    buildTabGrid();
    renderTabList();
    teDirty(false);
    teFocus(0, 0, 0);
  }
  $("teNew").onclick = () => {
    if (!te) return;
    const t = NL.TUNINGS.find((x) => x.id === state.settings.tabTuning) || NL.TUNINGS[0];
    te.model = NL.newTab(t.strings, 4, 8);
    te.model.perLine = state.settings.tabPerLine || 2;
    te.id = null;
    te.capoOn = null;
    te.cur = { m: 0, c: 0, s: 0 };
    $("teName").value = "";
    $("teCapo").value = "0";
    renderCapoStrings();
    fillTuning();
    $("tePer").value = String(te.model.perLine);
    buildTabGrid();
    renderTabList();
    teDirty(false);
    $("teName").focus();
  };
  $("teList").addEventListener("change", (e) => {
    const v = e.target.value;
    const t = myTabs.find((x) => x.id === v);
    if (t) loadTab(t);
  });
  $("teSave").onclick = () => {
    if (!te) return;
    const name = $("teName").value.trim().replace(/\s+/g, " ").slice(0, 60);
    if (!name) return $("teName").focus();
    const capo = teCapo();
    const capoStrings = capo && capoPartial() ? te.model.names.map((_, s) => s).filter(capoHas) : undefined;
    const rec = { name, text: NL.formatTab(te.model), capo, capoStrings, perLine: te.model.perLine, updatedAt: Date.now() };
    const cur = myTabs.find((x) => x.id === te.id) || myTabs.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (cur) Object.assign(cur, rec), (te.id = cur.id);
    else myTabs.push({ id: newId(), createdAt: Date.now(), ...rec }), (te.id = myTabs[myTabs.length - 1].id);
    saveMyTabs();
    renderTabList();
    teDirty(false);
    if (scOpen() && SC().tab === "tabs") (SC().tabSel = te.id), renderLib();
  };
  $("teDel").onclick = () => {
    if (!te || !te.id) return;
    myTabs = myTabs.filter((x) => x.id !== te.id);
    saveMyTabs();
    te.id = null;
    $("teName").value = "";
    renderTabList();
    teDirty(false);
    if (scOpen() && SC().tab === "tabs") renderLib();
  };
  $("teOk").onclick = applyTab;
  $("teName").addEventListener("input", () => teDirty());
  const tePrint = () => {
    if (!te) return;
    const nm = $("teName").value.trim() || "Tab";
    const tn = NL.tuningFor(te.model.names);
    printTab(nm, [tn ? tn.name : te.model.names.join(" "), capoLabel()].filter(Boolean).join(" · "), te.model);
  };
  $("teExport").onclick = () =>
    openActMenu($("teExport"), [
      { label: "PDF", run: tePrint },
      { label: "Print", run: tePrint },
      {
        label: "Text File",
        run: () => {
          if (!te) return;
          const nm = $("teName").value.trim() || "Tab", cl = capoLabel(), tn = NL.tuningFor(te.model.names);
          downloadText(nm, [`${nm}${cl ? ` (${cl})` : ""}`, tn ? tn.name : "", "", NL.formatTab(te.model)].filter((x, i) => x || i === 2).join("\n"));
        },
      },
    ]);
  $("teCancel").onclick = closeTabEditor;
  $("teClose").onclick = closeTabEditor;
  $("tabModal").addEventListener("click", (e) => {
    if (e.target === $("tabModal")) closeTabEditor();
  });

  // ----- scale library: look up a scale, see it on the neck (several patterns) and as tab -----
  // the scale library's settings: one object, kept in the saved settings; missing values get their defaults
  const SC = () => {
    const cur = state.settings.scales || (state.settings.scales = {});
    const defaults = {
      instr: "guitar",
      tuning: { guitar: "std", bass: "bass4" },
      root: "C",
      scale: "major",
      labels: "notes",
      ghost: true,
      tab: "scales",
      views: [0], // patterns shown: "open", 0–4 (the five patterns), "all" (whole neck); any mix
      per: 0, // notes per string (0 = the whole pattern)
      showAll: false, // also show the rest of the scale, faintly
      stick: false, // off: one pattern at a time; on: clicking adds patterns
      frets: 22,
      capo: 0, // capo fret (0 = none)
      strings: null, // which strings are on, lowest first (null = all)
      circle: { i: 0, minor: false },
      caged: { root: "C", minor: false, shape: 0, labels: "notes" },
    };
    for (const k in defaults) if (cur[k] === undefined) cur[k] = defaults[k];
    return cur;
  };
  const scTuning = () => {
    const c = SC();
    const mine = c.customTun && c.customTun[c.instr];
    if (c.tuning[c.instr] === "custom" && mine) return { id: "custom", name: `Custom (${mine.strings.slice().reverse().map((x) => x.toUpperCase()).join(" ")})`, instr: c.instr, group: "Yours", strings: mine.strings, midi: mine.midi };
    return NL.TUNINGS.find((t) => t.id === c.tuning[c.instr] && t.instr === c.instr) || NL.TUNINGS.find((t) => t.instr === c.instr);
  };
  const scScale = () => NL.SCALES.find((x) => x.id === SC().scale) || NL.SCALES[0];
  const scOpen = () => $("scaleModal").classList.contains("show");
  let scView = null; // what's on screen: { tuning, scale, info, pattern }
  // "Key: G Major" near the top of the page (from Guess Key)
  function pageKey() {
    const m = notesTa.value.split("\n").slice(0, 8).join("\n").match(/^\s*key\s*:\s*([A-Ga-g])([#b♯♭]?)\s*(major|minor|maj|min|m)?\b/im);
    if (!m) return null;
    const root = m[1].toUpperCase() + m[2].replace("♯", "#").replace("♭", "b");
    return NL.ROOTS.includes(root) ? { root, minor: /^(minor|min|m)$/i.test(m[3] || "") } : null;
  }
  function openScales(tab) {
    if (!NL) return;
    if (tab === "tabs" && !myTabs.length) return openNewTab(); // nothing to look through yet
    if (tab) SC().tab = tab;
    if (notesOpen()) SC().capo = pageCapo();
    const key = notesOpen() && tab === "scales" ? pageKey() : null;
    if (key) Object.assign(SC(), { root: key.root, scale: key.minor ? "minor" : "major" }); // the key Guess Key found
    $("scSearch").value = "";
    for (const id of ["scRoot", "cgRoot"]) {
      const sel = $(id);
      if (!sel.options.length) NL.ROOTS.forEach((r) => sel.append(new Option(NL.pretty(r), r)));
    }
    renderScaleList();
    renderLib();
    renderScSide();
    $("scaleModal").classList.add("show");
    setTimeout(() => $("scList").querySelector(".active")?.scrollIntoView({ block: "nearest" }), 0);
  }
  function closeScales() {
    $("scaleModal").classList.remove("show");
    if (notesOpen() && notesMode() !== "preview") notesTa.focus();
  }
  function renderScaleList() {
    const q = $("scSearch").value.trim().toLowerCase();
    const list = $("scList");
    list.innerHTML = "";
    let group = null, any = false;
    const show = ["all", "lib", "mine"].includes(SC().filter) ? SC().filter : "all";
    setActive("scFilter", show);
    for (const sc of NL.SCALES) {
      if ((show === "lib" && sc.mine) || (show === "mine" && !sc.mine)) continue;
      if (q && !`${sc.name} ${sc.aka || ""} ${sc.group}`.toLowerCase().includes(q)) continue;
      if (sc.group !== group) {
        group = sc.group;
        list.append(el("div", "head", group));
      }
      const b = el("button", sc.id === SC().scale ? "active" : "");
      b.dataset.id = sc.id;
      b.setAttribute("role", "option");
      b.append(el("span", "", sc.name));
      b.title = NL.pretty(sc.formula);
      if (sc.mine) {
        const ed = el("span", "sced", "✎");
        ed.dataset.edit = sc.id;
        ed.title = "Edit";
        b.append(ed);
      }
      list.append(b);
      any = true;
    }
    if (!any) list.append(el("div", "none", show === "mine" ? "No custom scales yet." : "No scale matches that."));
  }
  $("scFilter").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-f]");
    if (!b) return;
    SC().filter = b.dataset.f;
    persist();
    renderScaleList();
  });
  const fretMarks = [3, 5, 7, 9, 15, 17, 19, 21];
  function neckSvg(tuning, info, pattern, ghosts, labels, fmax, strOn, capo = 0) {
    const midiLow = tuning.midi.slice().reverse(), names = tuning.strings.slice().reverse();
    // narrower frets when more of the neck is shown, so it still fits the window
    const n = midiLow.length, fw = fmax > 17 ? Math.max(30, Math.round((42 * 17) / fmax)) : 42, sg = 26, padL = 30, nutX = padL + 28, top = 16;
    const W = nutX + fmax * fw + 12, H = top + (n - 1) * sg + 36;
    const X = (f) => (f === 0 ? padL + 12 : nutX + (f - 0.5) * fw);
    const Y = (s) => top + (n - 1 - s) * sg;
    const bottom = top + (n - 1) * sg;
    const o = [`<svg class="neck" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Fretboard diagram">`];
    o.push(`<rect class="nk-board" x="${nutX}" y="${top - 9}" width="${fmax * fw}" height="${(n - 1) * sg + 18}" rx="3"/>`);
    for (const f of fretMarks) if (f <= fmax) o.push(`<circle class="nk-inlay" cx="${nutX + (f - 0.5) * fw}" cy="${(top + bottom) / 2}" r="5"/>`);
    for (const f of [12, 24])
      if (f <= fmax)
        for (const y of [top + (bottom - top) * 0.25, top + (bottom - top) * 0.75]) o.push(`<circle class="nk-inlay" cx="${nutX + (f - 0.5) * fw}" cy="${y}" r="5"/>`);
    for (let f = 1; f <= fmax; f++) o.push(`<line class="nk-fret" x1="${nutX + f * fw}" y1="${top - 9}" x2="${nutX + f * fw}" y2="${bottom + 9}"/>`);
    o.push(`<rect class="nk-nut" x="${nutX - 4}" y="${top - 9}" width="4" height="${(n - 1) * sg + 18}" rx="1"/>`);
    if (capo) {
      // the frets behind the capo are out of play
      o.push(`<rect class="nk-shade" x="${padL}" y="${top - 12}" width="${nutX + (capo - 1) * fw - padL}" height="${(n - 1) * sg + 24}"/>`);
      o.push(`<rect class="nk-capo" x="${X(capo) - 6}" y="${top - 14}" width="12" height="${(n - 1) * sg + 28}" rx="5"><title>Capo at fret ${capo}</title></rect>`);
    }
    for (let s = 0; s < n; s++) {
      const off = strOn && !strOn[s] ? " off" : "";
      o.push(`<line class="nk-str${off}" x1="${padL + 2}" y1="${Y(s)}" x2="${nutX + fmax * fw}" y2="${Y(s)}" stroke-width="${(0.8 + 0.3 * (n - 1 - s) * (6 / n)).toFixed(2)}"/>`);
      o.push(`<text class="nk-name tune${off}" data-s="${s}" x="12" y="${Y(s) + 4}"><title>Tune</title>${NL.esc(names[s])}</text>`);
    }
    for (const f of [...fretMarks, 12, 24]) if (f <= fmax && f !== capo) o.push(`<text class="nk-num" x="${nutX + (f - 0.5) * fw}" y="${bottom + 26}">${f}</text>`);
    if (capo) o.push(`<text class="nk-num nk-capon" x="${X(capo)}" y="${bottom + 26}">capo ${capo}</text>`);
    const dot = (x, ghost) => {
      const nn = info.byPc.get(((x.p % 12) + 12) % 12);
      const label = labels === "notes" ? NL.pretty(nn.name) : labels === "intervals" ? NL.pretty(nn.interval) : "";
      const cls = "nk-note" + (nn.semi === 0 ? " root" : "") + (ghost ? " ghost" : "");
      return `<g class="${cls}"><title>${NL.esc(NL.pretty(nn.name))} · ${NL.esc(NL.pretty(nn.interval))} · ${x.f === capo ? (capo ? "capo" : "open") : "fret " + x.f}</title><circle cx="${X(x.f)}" cy="${Y(x.s)}" r="10"/>${
        label ? `<text x="${X(x.f)}" y="${Y(x.s) + 3.5}">${NL.esc(label)}</text>` : ""
      }</g>`;
    };
    const on = new Set(pattern.notes.map((x) => `${x.s}:${x.f}`));
    for (const x of ghosts) if (!on.has(`${x.s}:${x.f}`) && x.f <= fmax) o.push(dot(x, true));
    for (const x of pattern.notes) o.push(dot(x, false));
    o.push("</svg>");
    return o.join("");
  }
  // a tuning list with its groups (Standard & Drop, Open, 7-String …)
  function fillTunings(sel, list, value, plain) {
    sel.innerHTML = "";
    const groups = new Map();
    for (const t of list) {
      const g = (plain ? "" : t.instr === "bass" ? "Bass: " : t.instr === "uke" ? "" : "Guitar: ") + (t.group || "");
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    for (const [g, ts] of groups) {
      const og = document.createElement("optgroup");
      og.label = g;
      ts.forEach((t) => og.append(new Option(t.name.replace(/^(Guitar|Bass): /, ""), t.id)));
      sel.append(og);
    }
    if (value) sel.value = value;
  }
  // a little menu under (or over) a button: [{ label, run }]
  let actPop = null;
  function closeActMenu() {
    if (!actPop) return false;
    actPop.remove();
    actPop = null;
    return true;
  }
  function openActMenu(anchor, items) {
    if (closeActMenu()) return;
    actPop = el("div", "npop mmenu");
    actPop.setAttribute("role", "menu");
    for (const it of items) {
      const b = el("button", "", it.label);
      b.setAttribute("role", "menuitem");
      b.onclick = () => (closeActMenu(), it.run());
      actPop.append(b);
    }
    root.append(actPop);
    const r = anchor.getBoundingClientRect(), m = actPop.getBoundingClientRect();
    actPop.style.left = clamp(r.right - m.width, 8, innerWidth - m.width - 8) + "px";
    actPop.style.top = (r.bottom + 6 + m.height < innerHeight ? r.bottom + 6 : Math.max(8, r.top - m.height - 6)) + "px";
    actPop.querySelector("button").focus();
    actPop.addEventListener("keydown", (e) => {
      const bs = [...actPop.querySelectorAll("button")], i = bs.indexOf(root.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        bs[(i + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length].focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeActMenu();
        anchor.focus();
      }
    });
  }
  window.addEventListener("mousedown", (e) => actPop && !e.composedPath().includes(actPop) && !e.composedPath().some((x) => x && x.dataset && x.dataset.menuBtn) && closeActMenu(), true);
  function downloadText(name, text) {
    return saveFileAs(safeName(name, "export"), "txt", "text/plain", "Text file", () => new Blob([text.endsWith("\n") ? text : text + "\n"], { type: "text/plain" }));
  }
  // the fretboard as text: one line per string, high to low, the notes (or intervals) at their frets
  function neckText(tuning, info, notes, labels, fmax, capo) {
    const n = tuning.midi.length, names = tuning.strings.slice().reverse();
    const at = new Map(notes.map((x) => [`${x.s}:${x.f}`, x]));
    const lab = (x) => {
      const nn = info.byPc.get(((x.p % 12) + 12) % 12);
      return labels === "intervals" ? NL.pretty(nn.interval) : labels === "none" ? "●" : NL.pretty(nn.name);
    };
    const cell = (t, w) => { const l = [...t].length; const a = Math.floor((w - l) / 2); return "-".repeat(Math.max(0, a)) + t + "-".repeat(Math.max(0, w - l - a)); };
    const nw = Math.max(...names.map((x) => x.length));
    const head = " ".repeat(nw + 4) + Array.from({ length: fmax }, (_, i) => String(i + 1).padStart(3).padEnd(4)).join("");
    const lines = [head];
    for (let s = n - 1; s >= 0; s--) {
      const o = at.get(`${s}:0`);
      let l = names[s].padEnd(nw) + " " + (o ? lab(o).padEnd(2) : "  ") + "‖";
      for (let f = 1; f <= fmax; f++) {
        const x = at.get(`${s}:${f}`);
        l += cell(x ? lab(x) : f === capo ? "C" : "", 3) + "|";
      }
      lines.push(l);
    }
    if (capo) lines.push(`(capo at fret ${capo})`);
    return lines.join("\n");
  }
  const setActive = (grp, v) => root.querySelectorAll(`#${grp} button`).forEach((b) => b.classList.toggle("active", (b.dataset.v ?? b.dataset.f) === v));
  function renderScales() {
    const c = SC();
    const tuning = scTuning(), scale = scScale();
    const info = NL.scaleInfo(c.root, scale);
    const midiLow = tuning.midi.slice().reverse();
    // controls
    setActive("scInstr", c.instr);
    setActive("scLabels", c.labels);
    const tsel = $("scTuning");
    const tkey = c.instr + "|" + (tuning.id === "custom" ? tuning.name : "");
    if (tsel.dataset.instr !== tkey) {
      tsel.dataset.instr = tkey;
      const list = NL.TUNINGS.filter((t) => t.instr === c.instr);
      fillTunings(tsel, tuning.id === "custom" ? [tuning, ...list] : list, null, true);
    }
    tsel.value = tuning.id;
    $("scRoot").value = c.root;
    // which strings are on (lowest first); a new instrument or tuning starts with all of them
    const n = midiLow.length;
    if (!Array.isArray(c.strings) || c.strings.length !== n) c.strings = Array(n).fill(true);
    const on = c.strings;
    const strGrp = $("scStrings");
    strGrp.innerHTML = "";
    tuning.strings
      .slice()
      .reverse()
      .forEach((nm, s) => {
        const b = el("button", on[s] ? "active" : "", nm);
        b.dataset.s = s;
        b.title = `${nm} string`;
        strGrp.append(b);
      });
    // patterns: any mix of Open, 1–5 and All
    const ORDER = ["open", 0, 1, 2, 3, 4, "all"];
    if (!Array.isArray(c.views)) c.views = [0];
    c.views = ORDER.filter((v) => c.views.includes(v));
    const posGrp = $("scPos");
    posGrp.innerHTML = "";
    ORDER.forEach((v) => {
      const b = el("button", c.views.includes(v) ? "active" : "", v === "open" ? "Open" : v === "all" ? "All" : String(v + 1));
      b.dataset.view = v;
      b.title = v === "open" ? "Open position" : v === "all" ? "Whole neck" : `Pattern ${v + 1}`;
      posGrp.append(b);
    });
    const fmax = clamp(c.frets || 22, 18, 24);
    $("scFrets").value = String(fmax);
    const per = clamp(+c.per || 0, 0, 12);
    $("scPer").value = String(per);
    $("scGhost").checked = !!c.showAll;
    $("scStick").checked = !!c.stick;
    // a capo: work out the patterns on the strings as the capo tunes them, then slide them up the neck.
    // The tab stays relative to the capo, the way capo tab is written; note names are the notes that sound.
    const capo = clamp(+c.capo || 0, 0, 12);
    $("scCapo").value = String(capo);
    const midiC = midiLow.map((m) => m + capo), fRel = fmax - capo;
    const neck = NL.scalePatterns(midiC, info, "neck", fRel)[0];
    const fives = NL.scalePatterns(midiC, info, "positions");
    const openP = NL.scalePatterns(midiC, info, "open")[0];
    const keep = (x) => on[x.s] && x.f <= fRel;
    const up = (xs) => xs.map((x) => ({ ...x, f: x.f + capo }));
    // each pattern you picked, in order; "notes per string" turns each into a run on the strings that are on
    const parts = c.views.map((v) => {
      if (v === "all") return { label: "the whole neck", all: true, notes: neck.notes.filter(keep) };
      const base = v === "open" ? openP : fives[v];
      const label = v === "open" ? "open position" : `pattern ${v + 1}`;
      if (per) return { label, byString: true, ...NL.perStringRun(midiC, info, base.anchor, per, on, fRel) };
      return { label, notes: base.notes.filter(keep) };
    });
    const seen = new Set();
    let shown = [];
    parts.forEach((p) => p.notes.forEach((x) => !seen.has(`${x.s}:${x.f}`) && (seen.add(`${x.s}:${x.f}`), shown.push(x))));
    const cells = scale.cells ? customCells(scale, c.root, fmax) : null;
    if (cells) {
      // a customized scale: exactly the notes you picked (moved to this key)
      const want = new Set(cells.map(([s, f]) => `${s}:${f}`));
      const full = NL.scalePatterns(midiLow, info, "neck", fmax)[0].notes;
      shown = full.filter((x) => want.has(`${x.s}:${x.f}`) && on[x.s]).map((x) => ({ ...x, f: x.f - capo })).filter((x) => x.f >= 0);
      parts.length = 0;
      parts.push({ label: scale.name, byString: true, notes: shown });
    }
    const ghosts = c.showAll ? neck.notes.filter((x) => on[x.s]) : [];
    $("scNeck").innerHTML = neckSvg(tuning, info, { notes: up(shown) }, up(ghosts), c.labels, fmax, on, capo);
    // name, notes, formula
    $("scName").textContent = cells ? scale.name : `${NL.pretty(c.root)} ${scale.name}`;
    const chips = $("scNotes");
    chips.innerHTML = "";
    const usedPc = cells ? new Set(shown.map((x) => (midiLow[x.s] + x.f + capo) % 12)) : null;
    const listed = usedPc ? info.notes.filter((nn) => usedPc.has(nn.pc)) : info.notes;
    listed.forEach((nn) => chips.append(el("span", nn.semi === 0 ? "r" : "", NL.pretty(nn.name))));
    $("scFormula").textContent = listed.map((nn) => NL.pretty(nn.interval).padEnd(4)).join("");
    renderScaleKey(info, cells ? null : scale);
    // tab: each pattern you picked, one after the other (the whole neck only when you've picked some strings)
    const allOn = on.every(Boolean);
    const tabParts = parts.filter((p) => p.notes.length && !(p.all && allOn));
    // each pattern starts its own line, three measures to a line
    let tabModel = null;
    const breaks = [], labels = {};
    tabParts.forEach((p) => {
      const t = NL.patternTab(p, tuning.strings, false, 8, !!(p.byString || p.all));
      const at = tabModel ? tabModel.measures.length : 0;
      breaks.push(at);
      labels[at] = p.label.charAt(0).toUpperCase() + p.label.slice(1);
      if (!tabModel) tabModel = t;
      else tabModel.measures.push(...t.measures);
    });
    if (tabModel) {
      tabModel.perLine = 3;
      tabModel.breaks = breaks;
      if (tabParts.length > 1) tabModel.labels = labels; // name each pattern when there's more than one
    }
    $("scTab").innerHTML = tabModel ? NL.staffHtml(tabModel) : "";
    const pattern = { notes: shown, tab: tabModel, label: tabParts.map((p) => p.label).join(", "), capo };
    scView = { tuning, scale, info, pattern };
  }
  // the key signature the scale is written in, beside the pattern rows
  function renderScaleKey(info, scale) {
    const box = $("scKey");
    if (!scale || !info || !info.notes || !info.notes.length) return (box.innerHTML = "");
    const k = NL.scaleKeySignature(info);
    const key = `${NL.pretty(k.root)} ${k.minor ? "minor" : "major"}`;
    const acc = k.count ? `<span>${NL.esc(`${k.count}${k.type === "sharps" ? "♯" : "♭"} · ${k.accidentals.map(NL.pretty).join(" ")}`)}</span>` : ""; // no sharps or flats: nothing to say
    box.innerHTML = NL.keySignatureImg(k.root, k.minor).replace(/ contenteditable="false"/, "") + `<div class="sk-t"><span>Key signature</span><b>${NL.esc(key)}</b>${acc}</div>`;
    box.title = k.parent ? `${NL.pretty(info.notes[0].name)} ${scale.name} uses the key signature of ${key}` : `Key signature: ${key}`;
  }
  // hide or show the list on the left (Scales, Chords and Tabs); the window gets narrower without it
  function renderScSide() {
    const off = !!SC().sideHidden;
    root.querySelector(".modal.scalemod").classList.toggle("noside", off);
    $("scSideBtn").classList.toggle("sbon", off);
    $("scSideBtn").title = off ? "Show the List" : "Hide the List";
    $("scSideBtn").setAttribute("aria-pressed", String(off));
  }
  $("scSideBtn").onclick = () => {
    SC().sideHidden = !SC().sideHidden;
    persist();
    renderScSide();
  };
  // one root shared by Scales, CAGED and the circle of fifths: choosing it on one screen sets the others
  const rootPcOf = (r) => NL.scaleInfo(r, NL.SCALES[0]).rootPc;
  function scSet(patch) {
    const c = SC();
    const before = { root: c.root, caged: c.caged && c.caged.root, circle: c.circle && `${c.circle.i}:${c.circle.minor}` };
    Object.assign(c, patch);
    if (patch.scale) {
      const sc = NL.SCALES.find((x) => x.id === patch.scale);
      if (sc && sc.cells && sc.instr && sc.tuning) {
        c.instr = sc.instr;
        c.tuning = { ...c.tuning, [sc.instr]: sc.tuning };
        c.strings = null;
      }
    }
    let r = null;
    if (patch.root && patch.root !== before.root) r = patch.root;
    else if (patch.caged && patch.caged.root && patch.caged.root !== before.caged) r = patch.caged.root;
    else if (patch.circle && `${patch.circle.i}:${patch.circle.minor}` !== before.circle) r = circleKey().root;
    if (r) {
      c.root = r;
      c.caged = { ...c.caged, root: r };
      if (!patch.circle) {
        const minor = !!(c.circle && c.circle.minor);
        const i = NL.CIRCLE.findIndex((k) => rootPcOf(minor ? k.minor : k.major) === rootPcOf(r));
        if (i >= 0) c.circle = { i, minor };
      }
    }
    persist();
    renderLib();
  }
  // which tab is showing, its footer and its Insert button
  function renderLib() {
    const c = SC();
    const tab = ["scales", "chords", "circle", "caged", "tabs"].includes(c.tab) ? c.tab : "scales";
    root.querySelectorAll("#scTabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    $("scSideBtn").classList.toggle("nolist", tab === "circle" || tab === "caged"); // those have no list to hide
    root.querySelector(".modal.scalemod").classList.toggle("narrow", tab === "circle" || tab === "caged");
    $("scPaneScales").classList.toggle("show", tab === "scales");
    $("scPaneCircle").classList.toggle("show", tab === "circle");
    $("scPaneCaged").classList.toggle("show", tab === "caged");
    $("scPaneChords").classList.toggle("show", tab === "chords");
    $("scPaneTabs").classList.toggle("show", tab === "tabs");
    if (tab === "scales") renderScales();
    else if (tab === "chords") renderChords();
    else if (tab === "tabs") renderTabsPane();
    else if (tab === "circle") renderCircle();
    else renderCaged();
    $("scInfo").textContent = "";
    // always clickable: with the editor closed it opens this video's page and adds it at the end
    $("scInsert").disabled = false;
    $("scInsMenu").hidden = true;
    $("scInsert").title = notesOpen() ? "Insert into the editor" : "Insert at the end of this video's page in the editor";
  }
  root.querySelectorAll("#scaleModal [data-tr]").forEach((b) =>
    b.addEventListener("click", () => {
      const n = +b.dataset.tr;
      if (b.dataset.for === "caged") scSet({ caged: { ...SC().caged, root: NL.transposeRoot(SC().caged.root, n), shape: SC().caged.shape } });
      else scSet({ root: NL.transposeRoot(SC().root, n) });
    })
  );
  $("scTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b && b.dataset.tab === "tabs" && !myTabs.length) return openNewTab();
    if (b) scSet({ tab: b.dataset.tab });
  });
  // ----- the chord library tab: every chord type for the shared root, shapes found on the neck, and your own chords -----
  const CH = () => {
    const c = SC();
    if (!c.chord || typeof c.chord !== "object") c.chord = { type: "", my: null, pick: 0 };
    return c.chord;
  };
  let chView = null; // { name, shapes: [{ frets, fingers, mine? }], key }
  // the chords' instrument: standard guitar (where your own shapes live), 7-string or bass
  const chTuning = () => NL.TUNINGS.find((t) => t.id === CH().tuning && t.instr !== "uke") || NL.TUNINGS[0];
  const myChordNames = () => Object.keys(chordShapesMap).filter((n) => !NL.parseChord(n)).sort((a, b) => a.localeCompare(b));
  function chordShapesFor(name) {
    const key = NL.chordKey(name);
    const out = [];
    const seen = new Set();
    const add = (sh, mine) => {
      if (!sh || !Array.isArray(sh.frets)) return;
      const k = sh.frets.join(",");
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ ...sh, fingers: sh.fingers || NL.autoFingers(sh.frets), mine });
    };
    add(chordShapesMap[key], true);
    for (const sh of NL.parseChord(name) ? NL.chordShapes(name) : []) add(sh, false);
    for (const sh of NL.parseChord(name) ? NL.chordVoicings(name, 12) : []) add(sh, false);
    return out.slice(0, 14);
  }
  // what the search box asks for: a root (from "Am7", "F#", "Bb sus") and/or words ("minor", "sus")
  function chordQuery() {
    const raw = $("chSearch").value.trim();
    const m = raw.match(/^([A-Ga-g])([#b♯♭]?)(.*)$/);
    if (m) {
      const root = m[1].toUpperCase() + m[2].replace("♯", "#").replace("♭", "b");
      const rest = m[3].trim();
      if (NL.ROOTS.includes(root) && (!rest || NL.CHORD_TYPES.some((t) => t.s.toLowerCase().startsWith(rest.toLowerCase())) || /^\s/.test(m[3]))) return { root, suffix: rest, words: "" };
    }
    return { root: null, suffix: "", words: raw.toLowerCase() };
  }
  function renderChordList() {
    const Q = chordQuery();
    const q = Q.words;
    const list = $("chList");
    const ch = CH();
    list.innerHTML = "";
    let group = null, any = false;
    const rootName = Q.root || SC().root;
    const root = NL.pretty(rootName);
    const show = ["all", "lib", "mine"].includes(ch.filter) ? ch.filter : "all";
    setActive("chFilter", show);
    for (const t of show === "mine" ? [] : NL.CHORD_TYPES) {
      const nm = rootName + t.s;
      if (Q.root && Q.suffix && !t.s.toLowerCase().startsWith(Q.suffix.toLowerCase()) && !t.name.toLowerCase().includes(Q.suffix.toLowerCase())) continue;
      if (q && !`${t.name} ${t.s} ${nm} ${t.group}`.toLowerCase().includes(q)) continue;
      if (t.group !== group) {
        group = t.group;
        list.append(el("div", "head", group));
      }
      const b = el("button", !ch.my && ch.type === t.s && rootName === SC().root ? "active" : "");
      b.dataset.type = t.s;
      b.dataset.root = rootName;
      b.append(el("span", "", `${root}${NL.pretty(t.s)}`), el("span", "f", t.name));
      list.append(b);
      any = true;
    }
    const qq = $("chSearch").value.trim().toLowerCase();
    const mine = show === "lib" ? [] : myChordNames().filter((n) => !qq || n.toLowerCase().includes(qq));
    if (mine.length) {
      list.append(el("div", "head", "My Chords"));
      for (const n of mine) {
        const b = el("button", ch.my === n ? "active" : "");
        b.dataset.my = n;
        b.append(el("span", "", NL.pretty(n)), el("span", "f", fretsText(chordShapesMap[n].frets)));
        list.append(b);
        any = true;
      }
    }
    if (!any) list.append(el("div", "none", show === "mine" ? "No custom chords yet." : "No chord matches that."));
    const act = list.querySelector("button.active[data-my]");
    if (act) act.scrollIntoView({ block: "nearest" });
  }
  function renderChords() {
    const c = SC(), ch = CH();
    const sel = $("chRoot");
    if (!sel.options.length) NL.ROOTS.forEach((r) => sel.append(new Option(NL.pretty(r), r)));
    sel.value = c.root;
    renderChordList();
    const name = ch.my && chordShapesMap[ch.my] ? ch.my : c.root + ch.type;
    if (ch.my && !chordShapesMap[ch.my]) ch.my = null;
    const tn = chTuning(), std = tn.id === "std";
    const low = tn.midi.slice().reverse();
    if (!$("chTuning").options.length) fillTunings($("chTuning"), NL.TUNINGS.filter((t) => t.instr !== "uke"));
    $("chTuning").value = tn.id;
    setActive("chView", ch.view === "text" ? "text" : "diagram");
    const shapes = ch.my ? [{ ...chordShapesMap[ch.my], mine: true }] : std ? chordShapesFor(name) : NL.chordVoicings(name, 12, low);
    ch.pick = clamp(ch.pick || 0, 0, Math.max(0, shapes.length - 1));
    chView = { name, shapes, key: ch.my || NL.chordKey(name), std: std || !!ch.my };
    const asText = ch.view === "text";
    const shLow = ch.my ? undefined : low, shNames = ch.my ? NL.TUNINGS[0].strings : tn.strings;
    const info = NL.chordInfo(name);
    const t = !ch.my && NL.CHORD_TYPES.find((x) => x.s === ch.type);
    $("chName").textContent = ch.my ? NL.pretty(name) : `${NL.pretty(name)}  ·  ${NL.pretty(c.root)} ${t ? t.name.toLowerCase() : ""}`;
    $("chNotes").textContent = info ? `Notes: ${info.notes.map((n) => NL.pretty(n)).join(" ")}   Formula: ${info.formula.join(" ")}` : ch.my ? (chordShapesMap[ch.my].from ? `From ${NL.pretty(chordShapesMap[ch.my].from)}` : "Your Chord") : "";
    $("chShapes").innerHTML = shapes.length
      ? shapes
          .map(
            (sh, i) =>
              `<div class="chcard${i === ch.pick ? " on" : ""}" data-i="${i}" role="button" tabindex="0" title="${sh.mine ? "Yours" : "Choose"}">${
                asText
                  ? `<pre class="chtext">${NL.esc(NL.chordText(name, notesOpen() && chView.std ? withCapo(sh) : sh, shNames))}</pre>`
                  : NL.chordDiagramSvg(name, notesOpen() && chView.std ? withCapo(sh) : sh, { rootPc: NL.chordRootPc(name), width: 104, low: shLow })
              }<span class="chlab">${sh.mine ? "Yours" : i === (shapes[0].mine ? 1 : 0) ? "Usual" : ""}</span>${chView.std ? `<button class="chpen" data-edit="${i}" title="Edit">${ICON.edit}</button>` : ""}</div>`
          )
          .join("")
      : `<div class="none">No shape found for this chord.</div>`;
    $("chDel").hidden = !ch.my && !chordShapesMap[chView.key];
    $("chDel").textContent = ch.my ? "Delete Chord" : "Forget My Shape";
  }
  $("chList").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const ch = CH();
    if (b.dataset.my != null) Object.assign(ch, { my: b.dataset.my, pick: 0 });
    else Object.assign(ch, { my: null, type: b.dataset.type, pick: 0 });
    if (b.dataset.root && b.dataset.root !== SC().root) return scSet({ root: b.dataset.root });
    persist();
    renderLib();
  });
  $("chSearch").addEventListener("input", renderChordList);
  $("chFilter").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-f]");
    if (!b) return;
    CH().filter = b.dataset.f;
    persist();
    renderChordList();
  });
  $("chSearch").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    $("chList").querySelector("button")?.click();
  });
  $("chTuning").addEventListener("change", (e) => {
    Object.assign(CH(), { tuning: e.target.value, pick: 0 });
    persist();
    renderChords();
  });
  $("chView").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    CH().view = b.dataset.v;
    persist();
    renderChords();
  });
  $("chRoot").addEventListener("change", (e) => {
    CH().my = null;
    scSet({ root: e.target.value });
  });
  $("chShapes").addEventListener("click", (e) => {
    const pen = e.target.closest(".chpen");
    if (pen) {
      const sh = chView && chView.shapes[+pen.dataset.edit];
      CH().pick = +pen.dataset.edit;
      return sh && openShapeEditor(chView.name, { shape: sh, any: true, mine: !NL.parseChord(chView.name) && !!chordShapesMap[chView.name] });
    }
    const b = e.target.closest(".chcard");
    if (!b) return;
    CH().pick = +b.dataset.i;
    persist();
    renderChords();
  });
  $("chShapes").addEventListener("dblclick", (e) => {
    const b = e.target.closest(".chcard");
    if (b && !e.target.closest(".chpen")) b.querySelector(".chpen").click();
  });
  // start from the shape that's chosen; save it under a new name, or the same name to change that chord
  $("chNew").onclick = () => {
    const sh = chView && chView.shapes[CH().pick];
    const base = chView ? chView.name : "";
    const from = base && NL.parseChord(base) ? base : (chordShapesMap[base] && chordShapesMap[base].from) || null;
    const name = base ? (NL.parseChord(base) ? `${base}__Custom` : base) : "";
    const mine = !!(base && !NL.parseChord(base) && chordShapesMap[base]); // one of yours: saving it under a new name renames it
    openShapeEditor(name, sh ? { any: true, shape: sh, from, mine } : { any: true, fresh: true, from, mine });
  };
  $("chDel").onclick = () => {
    if (!chView || !chordShapesMap[chView.key]) return;
    delete chordShapesMap[chView.key];
    saveChordShapes();
    CH().my = null;
    CH().pick = 0;
    renderLib();
  };

  // ----- Customize Scale: start from what's showing, click notes on the whole neck on or off, name it, save it -----
  // A customized scale keeps its notes as places on the neck (string + fret), with the scale it came from.
  // In another key the places move with the root.
  let customScales = [];
  let scEd = null; // { id, base, formula, tuning, instr, root, fmax, on: Set("s:f") }
  const saveCustomScales = () => {
    store.set("customScales", customScales);
    NL.setCustomScales(customScales);
  };
  // a customized scale's places, moved to the key that's chosen now
  function customCells(sc, rootName, fmax) {
    if (!Array.isArray(sc.cells)) return null;
    const d0 = (((rootPcOf(rootName) - (sc.rootPc || 0)) % 12) + 12) % 12;
    const d = d0 > 6 ? d0 - 12 : d0;
    return sc.cells.map(([s, f]) => {
      let g = f + d;
      if (g < 0) g += 12;
      if (g > fmax) g -= 12;
      return [s, g];
    });
  }
  function openScaleEditor(id) {
    const c = SC();
    const cur = id ? customScales.find((x) => x.id === id) : scScale().mine && scScale().cells ? customScales.find((x) => x.id === scScale().id) : null;
    const base = cur || scScale();
    const tuning = (cur && NL.TUNINGS.find((t) => t.id === cur.tuning)) || scTuning();
    const fmax = clamp(c.frets || 22, 18, 24);
    const on = new Set();
    if (cur && cur.cells) customCells(cur, c.root, fmax).forEach(([s, f]) => on.add(`${s}:${f}`));
    else if (scView && scView.pattern.notes.length) scView.pattern.notes.forEach((x) => on.add(`${x.s}:${x.f + (scView.pattern.capo || 0)}`));
    scEd = { id: cur ? cur.id : null, baseName: cur ? cur.baseName || cur.name : base.name, formula: base.formula, tuning, fmax, on };
    if (!on.size) allNotes().forEach((x) => on.add(`${x.s}:${x.f}`));
    scEd.start = new Set(on);
    $("seName").value = cur ? cur.name : "";
    $("seDel").hidden = !cur;
    $("seTitle").textContent = cur ? `Customize Scale: ${cur.name}` : `Customize Scale: ${NL.pretty(c.root)} ${base.name}`;
    renderScaleEditor();
    $("scEdModal").classList.add("show");
    setTimeout(() => $("seName").focus(), 0);
  }
  function closeScaleEditor() {
    $("scEdModal").classList.remove("show");
    scEd = null;
  }
  // every note of the scale on the neck (the choices)
  function allNotes() {
    const info = NL.scaleInfo(SC().root, { formula: scEd.formula });
    return NL.scalePatterns(scEd.tuning.midi.slice().reverse(), info, "neck", scEd.fmax)[0].notes;
  }
  function renderScaleEditor() {
    const info = NL.scaleInfo(SC().root, { formula: scEd.formula });
    const midiLow = scEd.tuning.midi.slice().reverse(), names = scEd.tuning.strings.slice().reverse();
    const n = midiLow.length, F = scEd.fmax, fw = 34, sg = 24, L = 40, T = 14;
    const W = L + 22 + F * fw + 12, Hh = T + (n - 1) * sg + 30;
    const X = (f) => (f === 0 ? L + 6 : L + 22 + (f - 0.5) * fw);
    const Y = (s) => T + (n - 1 - s) * sg;
    const o = [`<svg viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}" role="img" aria-label="Fretboard">`];
    for (let f = 1; f <= F; f++) o.push(`<line class="fr" x1="${L + 22 + f * fw}" y1="${T - 8}" x2="${L + 22 + f * fw}" y2="${Y(0) + 8}"/>`);
    o.push(`<rect class="nut" x="${L + 19}" y="${T - 8}" width="3" height="${(n - 1) * sg + 16}"/>`);
    for (const f of [3, 5, 7, 9, 12, 15, 17, 19, 21, 24]) if (f <= F) o.push(`<text class="fn" x="${X(f)}" y="${Y(0) + 24}">${f}</text>`);
    for (let st = 0; st < n; st++) {
      o.push(`<line class="str" x1="${L + 22}" y1="${Y(st)}" x2="${L + 22 + F * fw}" y2="${Y(st)}"/>`);
      o.push(`<g class="sname" data-s="${st}"><rect x="0" y="${Y(st) - sg / 2}" width="${L - 4}" height="${sg}" rx="4"/><text x="${(L - 4) / 2}" y="${Y(st) + 4}">${NL.esc(names[st])}</text><title>${NL.esc(names[st])} string</title></g>`);
    }
    for (const x of allNotes()) {
      const k = `${x.s}:${x.f}`, isOn = scEd.on.has(k), pc = (midiLow[x.s] + x.f) % 12;
      const nn = info.byPc.get(pc);
      const root = pc === info.rootPc;
      o.push(`<g class="sn${isOn ? " on" : ""}${root ? " root" : ""}" data-k="${k}"><circle cx="${X(x.f)}" cy="${Y(x.s)}" r="9.5"/><text x="${X(x.f)}" y="${Y(x.s) + 3.5}">${nn ? NL.pretty(nn.name) : ""}</text></g>`);
    }
    o.push("</svg>");
    $("seFret").innerHTML = o.join("");
    $("sePreview").textContent = `${scEd.on.size} notes on`;
    $("seSave").disabled = !scEd.on.size;
  }
  $("seFret").addEventListener("click", (e) => {
    if (!scEd) return;
    const g = e.target.closest(".sn");
    if (g) {
      const k = g.dataset.k;
      scEd.on.has(k) ? scEd.on.delete(k) : scEd.on.add(k);
      return renderScaleEditor();
    }
    const sn = e.target.closest(".sname");
    if (sn) {
      // the string name: all of that string's notes on, or all off
      const s = +sn.dataset.s;
      const mine = allNotes().filter((x) => x.s === s).map((x) => `${x.s}:${x.f}`);
      const anyOn = mine.some((k) => scEd.on.has(k));
      mine.forEach((k) => (anyOn ? scEd.on.delete(k) : scEd.on.add(k)));
      renderScaleEditor();
    }
  });
  $("seReset").onclick = () => {
    if (!scEd) return;
    scEd.on = new Set(scEd.start);
    renderScaleEditor();
  };
  $("seSave").onclick = () => {
    if (!scEd) return;
    const name = $("seName").value.trim().replace(/\s+/g, " ").slice(0, 60);
    if (!name) return $("seName").focus();
    const cells = [...scEd.on].map((k) => k.split(":").map(Number)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const rec = { name, formula: scEd.formula, baseName: scEd.baseName, cells, rootPc: rootPcOf(SC().root), tuning: scEd.tuning.id, instr: scEd.tuning.instr };
    // the same name again: that scale is changed (so you can save over it)
    const same = customScales.find((x) => x.id === scEd.id) || customScales.find((x) => x.name.toLowerCase() === name.toLowerCase());
    const id = same ? same.id : "my-" + newId();
    if (same) Object.assign(same, rec);
    else customScales.push({ id, ...rec });
    saveCustomScales();
    closeScaleEditor();
    if (SC().filter === "lib") SC().filter = "all";
    $("scSearch").value = "";
    scSet({ scale: id });
    renderScaleList();
  };
  $("seDel").onclick = () => {
    if (!scEd || !scEd.id) return;
    customScales = customScales.filter((x) => x.id !== scEd.id);
    saveCustomScales();
    if (SC().scale === scEd.id) SC().scale = "major";
    closeScaleEditor();
    persist();
    renderScaleList();
    renderLib();
  };
  $("seCancel").onclick = closeScaleEditor;
  $("seClose").onclick = closeScaleEditor;
  $("scNew").onclick = () => openScaleEditor(null);
  $("scList").addEventListener(
    "click",
    (e) => {
      const ed = e.target.closest(".sced");
      if (!ed) return;
      e.stopPropagation();
      openScaleEditor(ed.dataset.edit);
    },
    true
  );


  // ----- circle of fifths -----
  const pt = (cx, cy, r, deg) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)].map((v) => v.toFixed(2)).join(" ");
  const sigShort = (k) => (k.signature.count ? `${k.signature.count}${k.signature.type === "sharps" ? "♯" : "♭"}` : "no ♯ ♭");
  function circleSvg(sel) {
    const S = 380, cx = S / 2, cy = S / 2, r3 = 186, r2 = 130, r1 = 86;
    const o = [`<svg viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="Circle of fifths">`];
    const seg = (i, rin, rout, minor) => {
      const a0 = -90 + i * 30 - 15, a1 = a0 + 30;
      const near = !!sel.minor !== minor && i === sel.i; // the relative key
      const cls = "cf-seg" + (i === sel.i && !!sel.minor === minor ? " sel" : near ? " near" : "");
      return `<path class="${cls}" data-i="${i}" data-m="${minor ? 1 : 0}" d="M ${pt(cx, cy, rout, a0)} A ${rout} ${rout} 0 0 1 ${pt(cx, cy, rout, a1)} L ${pt(cx, cy, rin, a1)} A ${rin} ${rin} 0 0 0 ${pt(cx, cy, rin, a0)} Z"><title>${NL.esc(
        NL.pretty(minor ? NL.CIRCLE[i].minor + " minor" : NL.CIRCLE[i].major + " major")
      )}</title></path>`;
    };
    NL.CIRCLE.forEach((k, i) => {
      o.push(seg(i, r2, r3, false), seg(i, r1, r2, true));
      const a = -90 + i * 30;
      const on = i === sel.i;
      const [mx, my] = pt(cx, cy, (r2 + r3) / 2, a).split(" ").map(Number);
      const ki = NL.keyInfo(k.major, false);
      o.push(`<text class="cf-maj${on && !sel.minor ? " cf-on" : ""}" x="${mx}" y="${my - 1}">${NL.esc(NL.pretty(k.major))}</text>`);
      o.push(`<text class="cf-sig${on && !sel.minor ? " cf-on" : ""}" x="${mx}" y="${my + 12}">${NL.esc(sigShort(ki) + (k.alt ? " · " + NL.pretty(k.alt) : ""))}</text>`);
      const [nx, ny] = pt(cx, cy, (r1 + r2) / 2, a).split(" ").map(Number);
      o.push(`<text class="cf-min${on && sel.minor ? " cf-on" : ""}" x="${nx}" y="${ny + 4}">${NL.esc(NL.pretty(k.minor) + "m")}</text>`);
    });
    const key = NL.keyInfo(sel.minor ? NL.CIRCLE[sel.i].minor : NL.CIRCLE[sel.i].major, sel.minor);
    o.push(`<circle class="cf-mid" cx="${cx}" cy="${cy}" r="${r1 - 2}"/>`);
    o.push(`<text class="cf-t1" x="${cx}" y="${cy - 2}">${NL.esc(NL.pretty(key.title))}</text>`);
    o.push(`<text class="cf-t2" x="${cx}" y="${cy + 18}">${NL.esc(sigShort(key))}</text>`);
    o.push("</svg>");
    return o.join("");
  }
  function circleKey() {
    const c = SC().circle;
    const k = NL.CIRCLE[((c.i % 12) + 12) % 12];
    return NL.keyInfo(c.minor ? k.minor : k.major, !!c.minor);
  }
  function sigText(key) {
    const sg = key.signature;
    if (!sg.count) return "No sharps or flats";
    return `${sg.count} ${sg.count === 1 ? sg.type.slice(0, -1) : sg.type}: ${sg.accidentals.map(NL.pretty).join(" ")}`;
  }
  function renderCircle() {
    const c = SC().circle;
    const key = circleKey();
    $("cfSvg").innerHTML = circleSvg(c);
    const P = (x) => NL.esc(NL.pretty(x));
    const keyLink = (root, minor, label) => `<a class="k" data-root="${NL.esc(root)}" data-minor="${minor ? 1 : 0}">${P(label)}</a>`;
    $("cfInfo").innerHTML = `
      <h3>${P(key.title)}</h3>
      <div class="row2"><b>Key signature:</b> ${P(sigText(key))}<br />
        <b>Relative ${key.minor ? "major" : "minor"}:</b> ${keyLink(key.relativeRoot, !key.minor, key.relative)}</div>
      <div><div class="lbl2">Chords in the key</div><table class="cftable"><tr>${key.chords.map((ch) => `<td>${P(ch.roman)}</td>`).join("")}</tr><tr>${key.chords
        .map((ch) => `<td>${P(ch.name)}</td>`)
        .join("")}</tr></table></div>`;
  }
  const goKey = (rootName, minor) => {
    const i = NL.CIRCLE.findIndex((k) => NL.scaleInfo(minor ? k.minor : k.major, NL.SCALES[0]).rootPc === NL.scaleInfo(rootName, NL.SCALES[0]).rootPc);
    if (i >= 0) scSet({ circle: { i, minor: !!minor } });
  };
  $("cfSvg").addEventListener("click", (e) => {
    const seg = e.target.closest("path[data-i]");
    if (seg) scSet({ circle: { i: +seg.dataset.i, minor: seg.dataset.m === "1" } });
  });
  $("cfInfo").addEventListener("click", (e) => {
    const a = e.target.closest("a.k");
    if (a) return goKey(a.dataset.root, a.dataset.minor === "1");
    const b = e.target.closest("button[data-go]");
    if (!b) return;
    const key = circleKey();
    if (b.dataset.go === "scale") scSet({ tab: "scales", root: key.root, scale: key.minor ? "minor" : "major", pos: 0 });
    else scSet({ tab: "caged", caged: { ...SC().caged, root: key.root, minor: key.minor, shape: 0 } });
    renderScaleList();
  });
  function insertKey() {
    const key = circleKey();
    const P = NL.pretty;
    const sg = key.signature;
    const sigLine = sg.count ? `${sg.count} ${sg.count === 1 ? sg.type.slice(0, -1) : sg.type} (${sg.accidentals.map(P).join(" ")})` : "no sharps or flats";
    return [
      `Key of ${P(key.title)}`,
      `Key signature: ${sigLine}`,
      `Relative ${key.minor ? "major" : "minor"}: ${P(key.relative)}`,
      "",
      key.chords.map((ch) => P(ch.roman).padEnd(Math.max(P(ch.roman).length, P(ch.name).length) + 2)).join("").trimEnd(),
      key.chords.map((ch) => P(ch.name).padEnd(Math.max(P(ch.roman).length, P(ch.name).length) + 2)).join("").trimEnd(),
    ].join("\n");
  }

  // ----- CAGED -----
  const STD = () => NL.TUNINGS[0];
  const CG = () => SC().caged;
  const cgShapes = () => NL.cagedShapes(CG().root, !!CG().minor);
  function chordBox(sh, rootPc) {
    const start = sh.lo <= 1 ? 1 : sh.lo;
    const rows = Math.max(4, sh.hi - start + 1);
    const sx = 13, fy = 17, L = 22, T = 18;
    const W = L + 5 * sx + 14, H = T + rows * fy + 6;
    const o = [`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">`];
    if (start === 1) o.push(`<rect class="cb-nut" x="${L - 1}" y="${T - 3}" width="${5 * sx + 2}" height="3"/>`);
    else o.push(`<text class="cb-fr" x="${L - 12}" y="${T + fy / 2 + 4}">${start}</text>`);
    for (let r = 0; r <= rows; r++) o.push(`<line class="cb-line" x1="${L}" y1="${T + r * fy}" x2="${L + 5 * sx}" y2="${T + r * fy}"/>`);
    for (let s = 0; s < 6; s++) o.push(`<line class="cb-line" x1="${L + s * sx}" y1="${T}" x2="${L + s * sx}" y2="${T + rows * fy}"/>`);
    sh.frets.forEach((f, s) => {
      const x = L + s * sx;
      if (f == null) o.push(`<text class="cb-mark" x="${x}" y="${T - 6}">×</text>`);
      else if (f === 0) o.push(`<circle cx="${x}" cy="${T - 9}" r="3.5" fill="none" stroke="currentColor" class="cb-mark"/>`);
      else {
        const isRoot = (STD_MIDI_LOW[s] + f) % 12 === rootPc;
        o.push(`<circle class="cb-dot${isRoot ? " root" : ""}" cx="${x}" cy="${T + (f - start + 0.5) * fy}" r="5.5"/>`);
      }
    });
    o.push("</svg>");
    return o.join("");
  }
  const STD_MIDI_LOW = [40, 45, 50, 55, 59, 64];
  function renderCaged() {
    const cg = CG();
    $("cgRoot").value = cg.root;
    setActive("cgQual", cg.minor ? "minor" : "major");
    setActive("cgLabels", cg.labels);
    const shapes = cgShapes();
    cg.shape = clamp(cg.shape || 0, 0, 4);
    const sh = shapes[cg.shape];
    const info = NL.scaleInfo(cg.root, { formula: cg.minor ? "1 b3 5" : "1 3 5" });
    const boxes = $("cgBoxes");
    boxes.innerHTML = "";
    shapes.forEach((x, i) => {
      const b = el("button", "cgbox" + (i === cg.shape ? " active" : ""));
      b.dataset.i = i;
      b.title = `${x.name} shape`;
      b.innerHTML = chordBox(x, info.rootPc);
      b.append(el("b", "", `${x.name} shape`), el("small", "", x.lo === 0 ? "open" : `fret ${x.lo}`));
      boxes.append(b);
    });
    const fmax = Math.min(24, Math.max(15, sh.hi + 1));
    const ghosts = NL.scalePatterns(STD().midi.slice().reverse(), info, "neck", fmax)[0].notes;
    $("cgNeck").innerHTML = neckSvg(STD(), info, { notes: sh.notes }, ghosts, cg.labels, fmax);
    const keyName = `${NL.pretty(info.notes[0].name)} ${cg.minor ? "minor" : "major"}`;
    const chordName = keyName;
    $("cgInfo").innerHTML = "";
    $("cgInfo").append(
      el("span", "", `${chordName}, ${sh.name} shape: root on the ${["", "1st", "2nd", "3rd", "4th", "5th", "6th"][sh.rootString] || "?"} string, frets ${sh.lo}–${sh.hi}. Sits in scale pattern ${sh.pattern + 1} of ${keyName}.`)
    );
    const go = el("button", "", `See scale pattern ${sh.pattern + 1}`);
    go.dataset.go = "pattern";
    $("cgInfo").append(go);
  }
  $("cgBoxes").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (b) scSet({ caged: { ...CG(), shape: +b.dataset.i } });
  });
  $("cgRoot").addEventListener("change", (e) => scSet({ caged: { ...CG(), root: e.target.value, shape: 0 } }));
  $("cgQual").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (b) scSet({ caged: { ...CG(), minor: b.dataset.v === "minor" } });
  });
  $("cgLabels").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (b) scSet({ caged: { ...CG(), labels: b.dataset.v } });
  });
  $("cgInfo").addEventListener("click", (e) => {
    if (!e.target.closest('button[data-go="pattern"]')) return;
    const cg = CG(), sh = cgShapes()[cg.shape];
    const c = SC();
    scSet({ tab: "scales", instr: "guitar", tuning: { ...c.tuning, guitar: "std" }, root: cg.root, scale: cg.minor ? "minor" : "major", views: [sh.pattern], per: 0, strings: null });
    renderScaleList();
  });
  function insertCaged() {
    const cg = CG(), shapes = cgShapes();
    const info = NL.scaleInfo(cg.root, { formula: "1" });
    const chordName = `${NL.pretty(info.notes[0].name)} ${cg.minor ? "minor" : "major"} chord`;
    const fr = (sh) => sh.frets.map((f) => (f == null ? "x" : f)).join("-");
    const model = { names: STD().strings.slice(), measures: shapes.map((sh) => [sh.frets.slice().reverse().map((f) => (f == null ? "" : String(f)))]), perLine: 5, pre: "", post: "" };
    return [`${chordName}: CAGED shapes, going up the neck`, ...shapes.map((sh) => `${sh.name} shape: ${fr(sh)}`), "", NL.formatTab(model)].join("\n");
  }
  $("scList").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (!b) return;
    scSet({ scale: b.dataset.id });
    renderScaleList();
  });
  $("scSearch").addEventListener("input", renderScaleList);
  $("scSearch").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const b = $("scList").querySelector("button[data-id]");
    if (b) b.click();
  });
  $("scInstr").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (b) scSet({ instr: b.dataset.v, strings: null });
  });
  $("scTuning").addEventListener("change", (e) => {
    const c = SC();
    c.tuning = { ...c.tuning, [c.instr]: e.target.value };
    scSet({ strings: null });
  });
  $("scRoot").addEventListener("change", (e) => scSet({ root: e.target.value }));
  // click a string's letter beside the fretboard to tune that string (your own tuning; the tab follows)
  $("scNeck").addEventListener("click", (e) => {
    const nm = e.target.closest(".nk-name");
    if (!nm) return;
    const t = scTuning(), n = t.midi.length, s = +nm.getAttribute("data-s"), hi = n - 1 - s;
    const cur = t.midi[hi];
    if (closeActMenu()) return;
    actPop = el("div", "npop tunepop");
    for (let m = cur - 7; m <= cur + 7; m++) {
      const b = el("button", m === cur ? "on" : "", NL.midiName(m));
      b.onclick = () => {
        closeActMenu();
        const c = SC();
        const strings = t.strings.slice(), midi = t.midi.slice();
        midi[hi] = m;
        let name = NL.midiName(m).replace(/-?\d+$/, "");
        strings[hi] = c.instr === "guitar" && hi === 0 ? name.toLowerCase() : name;
        const same = NL.TUNINGS.find((x) => x.instr === c.instr && x.midi.join() === midi.join());
        c.customTun = { ...(c.customTun || {}), [c.instr]: { strings, midi } };
        c.tuning = { ...c.tuning, [c.instr]: same ? same.id : "custom" };
        scSet({});
      };
      actPop.append(b);
    }
    root.append(actPop);
    const r = nm.getBoundingClientRect(), mm = actPop.getBoundingClientRect();
    actPop.style.left = clamp(r.right + 6, 8, innerWidth - mm.width - 8) + "px";
    actPop.style.top = clamp(r.top - mm.height / 2, 8, innerHeight - mm.height - 8) + "px";
    actPop.querySelector("button.on").focus();
  });
  $("scLabels").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (b) scSet({ labels: b.dataset.v });
  });
  // click a pattern: one at a time, or with Sticky on, add it to (or take it off) the ones showing
  $("scPos").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (!b) return;
    const v = b.dataset.view === "open" || b.dataset.view === "all" ? b.dataset.view : +b.dataset.view;
    const cur = SC().views;
    const views = SC().stick ? (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]) : cur.length === 1 && cur[0] === v ? [] : [v];
    scSet({ views });
  });
  $("scStick").addEventListener("change", (e) => {
    const views = SC().views;
    scSet({ stick: e.target.checked, ...(!e.target.checked && views.length > 1 ? { views: [views[0]] } : {}) });
  });
  $("scReset").onclick = () => scSet({ views: [], strings: null, per: 0 });
  $("scFrets").addEventListener("change", (e) => scSet({ frets: +e.target.value }));
  $("scCapo").addEventListener("change", (e) => scSet({ capo: +e.target.value }));
  $("scStrings").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-s]");
    if (!b) return;
    const on = SC().strings.slice();
    on[+b.dataset.s] = !on[+b.dataset.s];
    scSet({ strings: on });
  });
  $("scPer").addEventListener("change", (e) => scSet({ per: +e.target.value }));
  $("scGhost").addEventListener("change", (e) => scSet({ showAll: e.target.checked }));
  // ← → step through the positions (not while typing in the search box or a list)
  window.addEventListener("keydown", (e) => {
    if (dead || !scOpen() || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const t = e.composedPath()[0];
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    const d = e.key === "ArrowRight" ? 1 : -1;
    const c = SC();
    if (c.tab === "circle") {
      e.preventDefault();
      e.stopPropagation();
      return scSet({ circle: { ...c.circle, i: (c.circle.i + d + 12) % 12 } });
    }
    if (c.tab === "caged") {
      e.preventDefault();
      e.stopPropagation();
      return scSet({ caged: { ...c.caged, shape: (c.caged.shape + d + 5) % 5 } });
    }
    if (c.tab === "chords") {
      e.preventDefault();
      e.stopPropagation();
      const n = chView ? chView.shapes.length : 0;
      if (n) (CH().pick = (CH().pick + d + n) % n), persist(), renderChords();
      return;
    }
    const ORDER = ["open", 0, 1, 2, 3, 4, "all"];
    const cur = c.views.length ? ORDER.indexOf(c.views[d > 0 ? c.views.length - 1 : 0]) : -1;
    e.preventDefault();
    e.stopPropagation();
    scSet({ views: [ORDER[(cur + d + ORDER.length) % ORDER.length]] });
  }, true);
  // Insert into Editor opens a little menu: As Text or As Image
  // why there's nothing to insert yet (empty when there is)
  function scInsertBlocked() {
    const tab = SC().tab;
    if (!notesOpen() && !state.videoId) return "Open a video first: what you insert goes into its page in the editor";
    if (tab === "chords") return chView && chView.shapes.length ? "" : "Pick a chord first";
    if (tab === "tabs") return tbSel() ? "" : "Pick a tab first";
    if (tab === "circle" || tab === "caged") return "";
    return scView && scView.pattern.tab ? "" : "Pick a pattern, or some strings, to insert it";
  }
  $("scInsert").onclick = (e) => {
    e.stopPropagation();
    const why = scInsertBlocked();
    if (why) {
      $("scInsMenu").hidden = true;
      $("scInfo").textContent = why;
      return flash(why);
    }
    const m = $("scInsMenu");
    m.hidden = !m.hidden;
    if (!m.hidden) m.querySelector("button").focus();
  };
  $("scInsMenu").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-as]");
    if (!b) return;
    $("scInsMenu").hidden = true;
    scInsert(b.dataset.as === "image");
  });
  $("scInsMenu").addEventListener("keydown", (e) => {
    const items = [...$("scInsMenu").querySelectorAll("button")];
    const i = items.indexOf(root.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      $("scInsMenu").hidden = true;
      $("scInsert").focus();
    }
  });
  $("scaleModal").addEventListener("click", (e) => {
    if (!e.target.closest(".insgrp")) $("scInsMenu").hidden = true;
  });
  // a picture into the page: kept like any picture, under a title line
  function insertPicture(title, data, text) {
    const id = newId().replace(/[^a-z0-9]/g, "");
    imgCache.set(id, data);
    store.set("img:" + id, data);
    closeScales();
    const nm = String(title).replace(/[\[\]|()\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "picture";
    insertRuled((text ? text + "\n\n" : "") + `![${nm}](img:${id})`);
    notesDirty = true;
    saveNotesNow();
    renderPreview();
  }
  // the editor isn't open (Chords, Scales or Tabs from the main panel), or you haven't put the cursor anywhere
  // in it yet: open this video's page and add it at the end
  let notesCaretSet = false;
  for (const ev of ["mouseup", "keyup"]) $("notesText").addEventListener(ev, () => (notesCaretSet = true));
  async function scInsert(asImage) {
    let atEnd = !notesCaretSet;
    if (!notesOpen()) {
      if (!state.videoId) return flash("Open a video first");
      openNotes(state.videoId);
      atEnd = true;
    }
    if (!notesOpen()) return;
    await new Promise((r) => setTimeout(r, 0)); // let the editor finish opening (it places the cursor)
    if (atEnd) {
      const n = notesTa.value.replace(/\s+$/, "").length;
      notesTa.setSelectionRange(n, n);
    }
    const P = NL.pretty;
    if (SC().tab === "tabs") {
      const t = tbSel();
      if (!t) return;
      if (asImage) {
        const txt = savedTabText(t);
        return textPicture(txt.split("\n").slice(2)).then((d) => insertPicture(t.name, d, txt.split("\n")[0]));
      }
      closeScales();
      insertRuled(savedTabText(t));
      return renderPreview();
    }
    if (SC().tab === "chords") {
      const sh = chView && chView.shapes[CH().pick];
      if (!sh) return;
      if (chView.std && !sh.mine && CH().pick > 0 && !CH().my) chordShapesMap[chView.key] = { frets: sh.frets.slice(), fingers: (sh.fingers || NL.autoFingers(sh.frets)).slice() };
      saveChordShapes();
      if (asImage) {
        const svg = $("chShapes").querySelector(".chcard.on svg") || $("chShapes").querySelector("svg");
        return svg && svgPicture(svg, 3).then((d) => insertPicture(chView.name, d, ""));
      }
      closeScales();
      insertInline(chView.name + " ");
      return renderPreview();
    }
    if (SC().tab === "circle" || SC().tab === "caged") {
      const circle = SC().tab === "circle";
      const text = circle ? insertKey() : insertCaged();
      if (asImage) {
        const svg = circle ? $("cfSvg").querySelector("svg") : $("cgNeck").querySelector("svg");
        return svg && svgPicture(svg).then((d) => insertPicture(text.split("\n")[0], d, text.split("\n")[0]));
      }
      closeScales();
      insertRuled(text);
      renderPreview();
      return;
    }
    if (!scView || !scView.pattern.tab) return;
    const { tuning, scale, info, pattern } = scView;
    const c = SC();
    const tname = tuning.name.replace(/^(Guitar|Bass): /, "");
    const line = [
      `${NL.pretty(c.root)} ${scale.name}`,
      `${pattern.label.charAt(0).toUpperCase() + pattern.label.slice(1)}${c.per ? `, ${c.per} per string` : ""}`,
      `${c.instr === "bass" ? "Bass" : "Guitar"}, ${tname}${pattern.capo ? `, capo ${pattern.capo}` : ""}`,
      `Notes: ${info.notes.map((nn) => NL.pretty(nn.name)).join(" ")}`,
      `Intervals: ${info.notes.map((nn) => NL.pretty(nn.interval)).join(" ")}`,
    ].join("\n");
    if (asImage) {
      // the fretboard as a picture in the page
      const svg = $("scNeck").querySelector("svg");
      return svg && svgPicture(svg).then((d) => insertPicture(`${P(c.root)} ${scale.name}`, d, line));
    }
    const tab = NL.formatTab(pattern.tab);
    closeScales();
    insertRuled(line + "\n\n" + tab);
    renderPreview();
  }
  // lines of text (a tab) as a picture, in a fixed-width font on white
  function textPicture(lines, scale = 2) {
    const fs = 13, lh = 17, pad = 10, cw = fs * 0.6;
    const w = Math.ceil(Math.max(20, ...lines.map((l) => l.length)) * cw + pad * 2), h = lines.length * lh + pad * 2;
    const esc = NL.esc;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>${lines
      .map((l, i) => `<text x="${pad}" y="${pad + (i + 1) * lh - 4}" font-family="Roboto Mono, Menlo, Consolas, monospace" font-size="${fs}" fill="#222" xml:space="preserve">${esc(l)}</text>`)
      .join("")}</svg>`;
    return svgToPng(svg, w, h, scale);
  }
  function svgToPng(svgText, w, h, scale) {
    return new Promise((ok, bad) => {
      const im = new Image();
      im.onerror = () => bad(new Error("draw"));
      im.onload = () => {
        const cv = document.createElement("canvas");
        cv.width = w * scale;
        cv.height = h * scale;
        const g = cv.getContext("2d");
        g.fillStyle = "#fff";
        g.fillRect(0, 0, cv.width, cv.height);
        g.drawImage(im, 0, 0, cv.width, cv.height);
        ok(cv.toDataURL("image/png"));
      };
      im.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
    });
  }
  // a drawing on screen as a PNG picture, in the Day colours on white so it reads in the page and the PDF
  function svgPicture(svg, scale = 2) {
    const was = host.getAttribute("data-theme");
    host.setAttribute("data-theme", "light");
    const clone = svg.cloneNode(true);
    const from = [svg, ...svg.querySelectorAll("*")], to = [clone, ...clone.querySelectorAll("*")];
    const PROPS = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "fill-opacity", "stroke-opacity", "font-family", "font-size", "font-weight", "font-style", "text-anchor", "dominant-baseline", "display", "visibility"];
    from.forEach((el0, i) => {
      const cs = getComputedStyle(el0);
      to[i].setAttribute("style", PROPS.map((k) => `${k}:${cs.getPropertyValue(k)}`).join(";"));
      to[i].removeAttribute("class");
    });
    const r = svg.getBoundingClientRect();
    if (was) host.setAttribute("data-theme", was);
    else host.removeAttribute("data-theme");
    const w = Math.round(r.width || +svg.getAttribute("width") || 600), h = Math.round(r.height || +svg.getAttribute("height") || 200);
    clone.setAttribute("width", w);
    clone.setAttribute("height", h);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return svgToPng(new XMLSerializer().serializeToString(clone), w, h, scale);
  }
  $("scClose").onclick = closeScales;
  $("scExport").onclick = () =>
    openActMenu($("scExport"), [
      { label: "PDF", run: printScalesPdf },
      { label: "Print", run: printScalesPdf },
      { label: "Text File", run: () => { const t = libText(); if (t) downloadText(t.name, t.text); } },
    ]);
  // what's on screen in Chords, Scales, and Tabs, as text (chord shapes and the fretboard drawn in letters)
  function libText() {
    const c = SC(), P = NL.pretty;
    const tab = ["scales", "chords", "circle", "caged", "tabs"].includes(c.tab) ? c.tab : "scales";
    if (tab === "tabs") {
      const t = tbSel();
      return t && { name: t.name, text: savedTabText(t) };
    }
    if (tab === "chords") {
      if (!chView) return null;
      const tn = chTuning();
      const blocks = chView.shapes.map((sh) => NL.chordText(chView.name, sh, tn.strings));
      return { name: chView.name, text: [`${P(chView.name)}`, $("chNotes").textContent, tn.id !== "std" ? tn.name : "", "", NL.sideBySide(blocks)].filter((x, i) => x || i === 3).join("\n") };
    }
    if (tab === "scales") {
      if (!scView) return null;
      const { tuning, scale, info, pattern } = scView;
      const title = `${P(c.root)} ${scale.name}`;
      const fmax = Math.max(12, ...pattern.notes.map((x) => x.f + 1));
      const lines = [title, `${tuning.name}${pattern.capo ? `, capo ${pattern.capo}` : ""}`, `Notes: ${info.notes.map((nn) => P(nn.name)).join(" ")}`, `Intervals: ${info.notes.map((nn) => P(nn.interval)).join(" ")}`, ""];
      lines.push(neckText(tuning, info, pattern.notes.map((x) => ({ ...x, f: x.f + (pattern.capo || 0) })), c.labels, Math.min(24, fmax + (pattern.capo || 0)), pattern.capo || 0));
      if (pattern.tab) lines.push("", NL.formatTab(pattern.tab));
      return { name: title, text: lines.join("\n") };
    }
    if (tab === "caged") return { name: "CAGED", text: insertCaged() };
    return { name: "Circle of Fifths", text: insertKey() };
  }
  $("scDone").onclick = closeScales;
  $("scaleModal").addEventListener("click", (e) => {
    if (e.target === $("scaleModal")) closeScales();
  });


  // ----- pictures in the page: ![name](img:id) on its own line; the picture itself is kept under "img:<id>" -----
  const imgCache = new Map();
  async function loadImage(id) {
    if (imgCache.has(id)) return imgCache.get(id);
    const d = await store.get("img:" + id);
    if (typeof d === "string" && d.startsWith("data:image/")) imgCache.set(id, d);
    return imgCache.get(id) || null;
  }
  function fillImages(box) {
    box.querySelectorAll("img[data-img]").forEach((im) => {
      const id = im.dataset.img;
      im.addEventListener("load", () => typeof sizeInk === "function" && sizeInk(), { once: true });
      const d = imgCache.get(id);
      if (d) im.src = d;
      else loadImage(id).then((x) => x && (im.src = x));
    });
  }
  // make the picture a sensible size (at most 1600 px wide) and small enough to keep
  function shrinkImage(file) {
    return new Promise((ok, bad) => {
      const fr = new FileReader();
      fr.onerror = () => bad(new Error("read"));
      fr.onload = () => {
        const im = new Image();
        im.onerror = () => bad(new Error("decode"));
        im.onload = () => {
          const k = Math.min(1, 1600 / im.naturalWidth);
          const w = Math.max(1, Math.round(im.naturalWidth * k)), h = Math.max(1, Math.round(im.naturalHeight * k));
          if (k === 1 && fr.result.length < 400000) return ok({ data: fr.result, w });
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          const g = c.getContext("2d");
          g.drawImage(im, 0, 0, w, h);
          const png = /png|gif|webp/.test(file.type) ? c.toDataURL("image/png") : null;
          const jpg = (() => {
            const c2 = document.createElement("canvas");
            c2.width = w;
            c2.height = h;
            const g2 = c2.getContext("2d");
            g2.fillStyle = "#fff";
            g2.fillRect(0, 0, w, h);
            g2.drawImage(im, 0, 0, w, h);
            return c2.toDataURL("image/jpeg", 0.85);
          })();
          ok({ data: png && png.length < jpg.length * 1.6 ? png : jpg, w });
        };
        im.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }
  async function insertImages(files) {
    const list = [...(files || [])].filter((f) => f && /^image\//.test(f.type));
    if (!list.length) return;
    for (const f of list) {
      let r;
      try {
        r = await shrinkImage(f);
      } catch (e) {
        flash("That picture couldn't be read");
        continue;
      }
      const id = newId().replace(/[^a-z0-9]/g, "");
      imgCache.set(id, r.data);
      store.set("img:" + id, r.data);
      const name = (f.name || "picture").replace(/\.[a-z0-9]+$/i, "").replace(/[\[\]|()\n]/g, " ").trim().slice(0, 40) || "picture";
      insertLine(`![${name}](img:${id})`);
    }
    notesDirty = true;
    saveNotesNow();
  }
  $("edImgFile").addEventListener("change", (e) => {
    const fs = [...e.target.files];
    e.target.value = "";
    insertImages(fs);
  });
  // paste or drop a picture into the page
  notesTa.addEventListener("paste", (e) => {
    const fs = e.clipboardData ? [...e.clipboardData.files] : [];
    if (fs.some((f) => /^image\//.test(f.type))) {
      e.preventDefault();
      e.stopImmediatePropagation();
      insertImages(fs);
    }
  });
  $("edScroll").addEventListener("dragover", (e) => {
    if (e.dataTransfer && [...e.dataTransfer.items].some((i) => i.kind === "file")) e.preventDefault();
  });
  $("edScroll").addEventListener("drop", (e) => {
    const fs = e.dataTransfer ? [...e.dataTransfer.files] : [];
    if (!fs.some((f) => /^image\//.test(f.type))) return;
    e.preventDefault();
    insertImages(fs);
  });
  // the pictures a list of videos uses (for Export)
  async function imagesFor(videos) {
    const out = {};
    for (const v of videos)
      for (const m of String(v.notes || "").matchAll(/\(img:([a-z0-9]+)\)/g)) {
        const d = await loadImage(m[1]);
        if (d) out[m[1]] = d;
      }
    return out;
  }
  // ----- loops and links in the editor: each on its own line; Ctrl/⌘+click (or the list beside the song) plays or opens it -----
  const LOOP_RE = /^\s*▶\s*Loop:\s*(.*?)\s*\((\d+:\d{1,2}(?:\.\d+)?)\s*[–-]\s*(\d+:\d{1,2}(?:\.\d+)?)\)\s*$/;
  const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
  function insertLine(text) {
    const v = notesTa.value, s = notesTa.selectionStart;
    const ls = v.lastIndexOf("\n", s - 1) + 1;
    let le = v.indexOf("\n", s);
    if (le < 0) le = v.length;
    if (!v.slice(ls, le).trim()) edReplace(ls, le, text, ls + text.length);
    else edReplace(le, le, "\n" + text, le + 1 + text.length);
    renderPreview();
  }
  function insertLoopLine(id) {
    const v = notesEntry();
    const l = id ? v && v.loops.find((x) => x.id === id) : { name: "A–B", a: state.a, b: state.b };
    if (!l || l.a == null || l.b == null) return flash("That loop has no A and B");
    insertLine(`▶ Loop: ${l.name} (${fmt(l.a)}–${fmt(l.b)})`);
  }
  function playLoopText(m) {
    if (notesVid !== state.videoId) return flash("Open this video to play its loops");
    const a = parseTime(m[2]), b = parseTime(m[3]);
    if (a == null || b == null || b <= a) return flash("That loop's times don't look right");
    const saved = curLoops().find((l) => l.name === m[1] && Math.abs(l.a - a) < 0.06 && Math.abs(l.b - b) < 0.06) || curLoops().find((l) => Math.abs(l.a - a) < 0.06 && Math.abs(l.b - b) < 0.06);
    if (saved) applyLoop(saved, true);
    else {
      state.loopId = null;
      state.a = a;
      state.b = b;
    }
    state.looping = false;
    toggleLoop(true);
    const vid = getVideo();
    if (vid && vid.paused) vid.play();
  }
  const openUrl = (u, id) => {
    const w = Math.min(1200, screen.availWidth - 80), h = Math.min(900, screen.availHeight - 80);
    const win = window.open(u, "ygc-link-" + (id || u.replace(/\W+/g, "").slice(-40)), `popup=yes,width=${w},height=${h},left=${screenX + 40},top=${screenY + 40}`);
    if (win) win.focus();
  };
  const linkClick = (a, id) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openUrl(a.href, id);
    });
  notesTa.addEventListener("click", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const lk = e.target.closest && e.target.closest("a.lk, .url");
    if (lk) return openUrl(lk.dataset.href || lk.textContent);
    const v = notesTa.value, p = notesTa.selectionStart;
    const ls = v.lastIndexOf("\n", p - 1) + 1;
    let le = v.indexOf("\n", p);
    if (le < 0) le = v.length;
    const line = v.slice(ls, le);
    const m = line.match(LOOP_RE);
    if (m) return playLoopText(m);
    const TM = String.raw`\d+:\d{1,2}(?:\.\d+)?`;
    for (const t of line.matchAll(new RegExp(String.raw`\[(${TM})(?:\s*[-–]\s*(${TM}))?\]`, "g"))) {
      if (p - ls < t.index || p - ls > t.index + t[0].length) continue;
      if (notesVid !== state.videoId) return flash("Open this video first");
      const a = NL.parseTime(t[1]), b = t[2] ? NL.parseTime(t[2]) : null;
      if (b != null && b > a) return playLoopText([null, "", t[1], t[2]]);
      const vid = getVideo();
      if (vid && a != null) vid.currentTime = a;
      return;
    }
    const urls = [...line.matchAll(URL_RE)];
    if (!urls.length) return;
    const at = urls.find((u) => p - ls >= u.index && p - ls <= u.index + u[0].length) || urls[0];
    openUrl(at[0]);
  });
  function renderRefs() {
    const box = $("edRefs");
    box.innerHTML = "";
    for (const line of notesTa.value.split("\n")) {
      const m = line.match(LOOP_RE);
      if (m) {
        const b = el("button", "rf");
        b.innerHTML = ic("loop", 13);
        b.append(el("span", "", m[1] || "Loop"), el("small", "", `${m[2]}–${m[3]}`));
        b.title = "Play";
        b.addEventListener("click", () => playLoopText(m));
        box.append(b);
        continue;
      }
    }
    const ve = notesEntry();
    for (const k of (ve && ve.links) || []) {
      const a = el("a", "rf");
      a.href = k.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.innerHTML = ic("link", 13);
      a.append(el("span", "", k.name || linkHost(k.url)));
      a.title = k.url + (k.comment ? `\n${k.comment}` : "");
      linkClick(a, k.id);
      box.append(a);
    }
  }
  // ----- the Links window: a video's links (scores, tabs, lessons …) with a name, the address and a comment -----
  const linkHost = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch (e) {
      return u;
    }
  };
  let lkVid = null, lkEdit = null;
  const linksEntry = () => (lkVid ? library.find((x) => x.videoId === lkVid) : null);
  function openLinks(videoId) {
    if (!videoId) return flash("Open a video first");
    lkVid = videoId;
    lkFormReset();
    renderLinks();
    $("linksModal").classList.add("show");
    setTimeout(() => $("lkName").focus(), 0);
  }
  function closeLinks() {
    $("linksModal").classList.remove("show");
    lkVid = lkEdit = null;
  }
  function lkFormReset() {
    lkEdit = null;
    $("lkName").value = $("lkUrl").value = $("lkNote").value = "";
    $("lkFormTitle").textContent = "Add a Link";
    $("lkOk").textContent = "Add Link";
    $("lkCancelEdit").hidden = true;
  }
  function renderLinks() {
    const v = linksEntry();
    const ls = (v && v.links) || [];
    const t = v ? v.name || v.title : lkVid === state.videoId ? videoTitle() : "this video";
    $("lkTitle").textContent = `Links · ${t}`;
    const box = $("lkList");
    box.innerHTML = "";
    ls.forEach((k) => {
      const row = el("div", "lkrow" + (lkEdit === k.id ? " editing" : ""));
      row.dataset.id = k.id;
      if (ls.length > 1) {
        row.draggable = true;
        const g = el("span", "lp-grip");
        g.innerHTML = GRIP;
        g.title = "Move";
        row.append(g);
      }
      const tx = el("div", "lkt");
      const a = el("a", "", k.name || linkHost(k.url));
      a.href = k.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.title = "Open";
      linkClick(a, k.id);
      const full = el("a", "lkurl", k.url);
      full.href = k.url;
      full.target = "_blank";
      full.rel = "noopener";
      full.title = "Open";
      linkClick(full, k.id);
      tx.append(a, full);
      if (k.comment) tx.append(el("div", "lkc", k.comment));
      const ed = el("button", "lp-del lp-edit");
      ed.innerHTML = ICON.edit;
      ed.title = "Edit";
      ed.addEventListener("click", () => {
        lkEdit = k.id;
        $("lkName").value = k.name || "";
        $("lkUrl").value = k.url;
        $("lkNote").value = k.comment || "";
        $("lkFormTitle").textContent = "Edit Link";
        $("lkOk").textContent = "Save";
        $("lkCancelEdit").hidden = false;
        renderLinks();
        $("lkName").focus();
      });
      const del = el("button", "lp-del");
      del.innerHTML = ICON.del;
      del.title = "Delete";
      del.addEventListener("click", () => {
        v.links = v.links.filter((x) => x.id !== k.id);
        if (lkEdit === k.id) lkFormReset();
        linksChanged(v);
      });
      row.append(tx, ed, del);
      box.append(row);
    });
  }
  // drag a link up or down the list
  let lkDrag = null;
  const lkList = $("lkList");
  lkList.addEventListener("dragstart", (e) => {
    const r = e.target.closest?.(".lkrow");
    if (!r) return;
    lkDrag = r.dataset.id;
    r.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", lkDrag);
  });
  lkList.addEventListener("dragover", (e) => {
    if (!lkDrag) return;
    e.preventDefault();
    const r = e.target.closest?.(".lkrow");
    lkList.querySelectorAll(".lkrow").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    if (!r || r.dataset.id === lkDrag) return;
    const b = r.getBoundingClientRect();
    r.classList.add(e.clientY < b.top + b.height / 2 ? "drop-before" : "drop-after");
  });
  lkList.addEventListener("drop", (e) => {
    if (!lkDrag) return;
    e.preventDefault();
    const r = e.target.closest?.(".lkrow");
    const v = linksEntry();
    if (r && v && r.dataset.id !== lkDrag) {
      const b = r.getBoundingClientRect();
      const after = e.clientY >= b.top + b.height / 2;
      const moving = v.links.find((x) => x.id === lkDrag);
      const rest = v.links.filter((x) => x.id !== lkDrag);
      const at = rest.findIndex((x) => x.id === r.dataset.id) + (after ? 1 : 0);
      rest.splice(at, 0, moving);
      v.links = rest;
      lkDrag = null;
      return linksChanged(v);
    }
  });
  lkList.addEventListener("dragend", () => {
    lkDrag = null;
    renderLinks();
  });
  function linksChanged(v) {
    v.updatedAt = Date.now();
    saveLibrary();
    renderLinks();
    if (notesOpen()) renderRefs();
  }
  function saveLinkForm() {
    let url = $("lkUrl").value.trim();
    if (!url) return flash("Paste the address first"), $("lkUrl").focus();
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    try {
      if (/\s/.test(url) || !new URL(url).hostname.includes(".")) throw 0;
    } catch (e) {
      return flash("That address doesn't look right");
    }
    const name = $("lkName").value.trim().replace(/\s+/g, " "), comment = $("lkNote").value.trim();
    let v = linksEntry();
    const now = Date.now();
    if (!v) {
      const title = lkVid === state.videoId ? videoTitle() : "YouTube video";
      v = { id: newId(), videoId: lkVid, title, name: title, desc: "", createdAt: now, updatedAt: now, loops: [], links: [] };
      library = [v, ...library];
    }
    v.links = v.links || [];
    const k = lkEdit && v.links.find((x) => x.id === lkEdit);
    if (k) Object.assign(k, { name, url, comment, updatedAt: now });
    else v.links.push({ id: newId(), name, url, comment, createdAt: now, updatedAt: now });
    lkFormReset();
    linksChanged(v);
    $("lkName").focus();
  }
  $("lkOk").onclick = saveLinkForm;
  $("lkCancelEdit").onclick = () => (lkFormReset(), renderLinks());
  $("lkClose").onclick = closeLinks;
  $("lkDone").onclick = closeLinks;
  $("linksModal").addEventListener("click", (e) => e.target === $("linksModal") && closeLinks());

  // ----- song tools: chords above the words, sections, transpose, chord shapes -----
  let chordShapesMap = {}; // your own fingerings, by chord name (kept in storage, used everywhere)
  const setChordShapes = (m) => {
    chordShapesMap = m && typeof m === "object" ? m : {};
    if (NL) NL.setCustomChords(chordShapesMap);
  };
  // a new page: just the video's title
  const exampleSong = (title) => `# ${title}\n\n`;
  // older pages: a ```song block or [chords] in the words are shown with the chords on their own line
  function asSongText(t) {
    if (!NL || !t) return t;
    let out = String(t).replace(/^```(?:song|chords|chordpro|lyrics)\s*\n([\s\S]*?)\n```\s*$/gm, (all, inner) => inner);
    if (out.split("\n").some((l) => !NL.isSectionLine(l) && !NL.isChordLine(l) && /\[[^\]]+\]/.test(l) && NL.sheetChords(l).length)) out = NL.inlineToOver(out);
    return out;
  }
  $("edSections").addEventListener("change", (e) => {
    const sec = e.target.value;
    e.target.value = "";
    if (!sec) return;
    notesTa.focus();
    const b = { dataset: { sec } };
    const v = notesTa.value, p = notesTa.selectionStart;
    const ls = v.lastIndexOf("\n", p - 1) + 1;
    let le = v.indexOf("\n", p);
    if (le < 0) le = v.length;
    const empty = !v.slice(ls, le).trim();
    const text = empty ? `[${b.dataset.sec}]\n` : `\n[${b.dataset.sec}]\n`;
    const at = empty ? ls : le;
    edReplace(at, at, text, at + text.length);
  });
  const edTranspose = (n) => {
    const t = NL.transposeSong(notesTa.value, n);
    if (sideChords().length) setSideChords(sideChords().map((c) => (NL.parseChord(c) ? NL.transposeChord(c, n) : c)));
    if (t !== notesTa.value) edReplace(0, notesTa.value.length, t, Math.min(notesTa.selectionStart, t.length));
  };
  $("edDown").onclick = () => edTranspose(-1);
  $("edUp").onclick = () => edTranspose(1);
  root.querySelectorAll("#notesTools button").forEach((b) => b.addEventListener("mousedown", (e) => e.preventDefault()));
  // ----- the editor's chord library: the song's chords, plus any you add for this page -----
  function sideChords() {
    const v = notesEntry();
    return v && Array.isArray(v.sideChords) ? v.sideChords : [];
  }
  function setSideChords(list) {
    let v = notesEntry();
    if (!v) {
      if (!notesVid) return;
      const now = Date.now(), title = notesVid === state.videoId ? videoTitle() : "YouTube video";
      v = { id: newId(), videoId: notesVid, title, name: title, desc: "", createdAt: now, updatedAt: now, loops: [], notes: notesTa.value };
      library = [v, ...library];
    }
    v.sideChords = list;
    v.updatedAt = Date.now();
    saveLibrary();
    renderPreview();
  }
  // what to offer for what's typed: "Am" -> Am, Am7, Am9 …; your own chords by name
  function sideFilter() {
    return ["all", "lib", "mine"].includes(state.settings.sideChFilter) ? state.settings.sideChFilter : "all";
  }
  function chordSuggestions(q, show = "all") {
    q = q.trim().replace(/♯/g, "#").replace(/♭/g, "b");
    const out = [];
    const add = (c) => out.length < (show === "mine" ? 40 : 12) && !out.includes(c) && out.push(c);
    if (show === "mine") {
      for (const n of myChordNames()) if (!q || n.toLowerCase().includes(q.toLowerCase())) add(n);
      return out;
    }
    if (!q) return [];
    if (NL.parseChord(q)) add(q);
    const m = q.match(/^([A-Ga-g])([#b]?)(.*)$/);
    if (m) {
      const r = m[1].toUpperCase() + m[2], rest = m[3].trim().toLowerCase();
      for (const t of NL.CHORD_TYPES) if (t.s.toLowerCase().startsWith(rest) || (rest.length > 1 && t.name.toLowerCase().includes(rest))) add(r + t.s);
    }
    const ql = q.toLowerCase();
    if (show === "all") for (const n of myChordNames()) if (n.toLowerCase().includes(ql)) add(n);
    return out;
  }
  function renderChordSug() {
    const box = $("edChSug");
    box.innerHTML = "";
    const q = $("edChSearch").value, show = sideFilter();
    root.querySelectorAll("#edChFilter button").forEach((b) => b.classList.toggle("active", b.dataset.f === show));
    if (!q.trim() && show !== "mine") return;
    const have = new Set([...NL.sheetChords(notesTa.value), ...sideChords()]);
    const all = chordSuggestions(q, show), sug = all.filter((c) => !have.has(c)); // already in the library: not offered again
    if (!sug.length)
      return box.append(
        el("span", "none", all.length ? (q.trim() ? "Already in the library." : "All your own chords are in the library.") : show === "mine" && !q.trim() ? (myChordNames().length ? "All your own chords are in the library." : "No custom chords yet.") : "No chord matches that.")
      );
    for (const c of sug) {
      const b = el("button", "", NL.pretty(c));
      b.dataset.add = c;
      b.title = "Add";
      box.append(b);
    }
  }
  function addSideChord(c) {
    if (!c || !NL.isChord(c)) return;
    if (!sideChords().includes(c) && !NL.sheetChords(notesTa.value).includes(c)) setSideChords([...sideChords(), c]);
    $("edChSearch").value = "";
    renderChordSug();
  }
  $("edChSearch").addEventListener("input", renderChordSug);
  $("edChFilter").addEventListener("mousedown", (e) => e.preventDefault());
  $("edChFilter").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-f]");
    if (!b) return;
    state.settings.sideChFilter = b.dataset.f;
    persist();
    renderChordSug();
    renderPreview();
  });
  $("edChSearch").addEventListener("keydown", (e) => {
    e.stopPropagation(); // typing here isn't a shortcut
    if (e.key === "Enter") {
      e.preventDefault();
      const first = $("edChSug").querySelector("button[data-add]");
      if (first) addSideChord(first.dataset.add);
    } else if (e.key === "Escape" && $("edChSearch").value) {
      e.preventDefault();
      $("edChSearch").value = "";
      renderChordSug();
    }
  });
  $("edChSug").addEventListener("mousedown", (e) => e.preventDefault());
  $("edChSug").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-add]");
    if (b) addSideChord(b.dataset.add);
  });
  $("edShapes").addEventListener("click", (e) => {
    const sa = e.target.closest("button[data-f]");
    if (sa) {
      state.settings.sideChFilter = sa.dataset.f;
      persist();
      renderChordSug();
      return renderPreview();
    }
    const rm = e.target.closest("[data-rm]");
    if (rm) {
      e.stopPropagation();
      return setSideChords(sideChords().filter((c) => c !== rm.dataset.rm));
    }
    const d = e.target.closest("[data-chord]");
    const c = d && d.dataset.chord;
    if (c) openShapeEditor(c, !NL.parseChord(c) && chordShapesMap[c] ? { any: true, mine: true } : {});
  });
  // Chord Shapes on the right: shown or hidden. Hiding it hides the whole side and makes the window narrower,
  // so more of the video shows; showing it again widens the window by the same amount.
  let lastSideW = 0;
  function renderShapesBtn() {
    const on = state.settings.songShapes !== false;
    $("notesWin").classList.toggle("noside", !on);
    const b = $("edShapesOn");
    b.classList.toggle("off", !on);
    b.title = on ? "Hide Chord Shapes" : "Show Chord Shapes";
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", b.title);
  }
  $("edShapesOn").addEventListener("mousedown", (e) => e.preventDefault());
  $("edShapesOn").addEventListener("click", () => {
    const w = $("notesWin"), on = state.settings.songShapes !== false;
    const r = w.getBoundingClientRect();
    const sideW = on ? (lastSideW = $("edSide").getBoundingClientRect().width) : lastSideW || 250;
    state.settings.songShapes = !on;
    renderShapesBtn();
    let W = on ? Math.max(420, r.width - sideW) : Math.min(r.width + sideW, innerWidth - 8);
    if (!on && r.left + W > innerWidth - 4) w.style.left = Math.max(4, innerWidth - 4 - W) + "px"; // keep it on screen
    if (sideW) {
      w.style.width = Math.round(W) + "px";
      state.settings.notesSize = { w: Math.round(W), h: Math.round(r.height) };
    }
    persist();
    renderPreview();
    sizeInk();
  });
  // pasting a sheet with [chords] in the words puts the chords on their own line above
  notesTa.addEventListener("paste", (e) => {
    const t = e.clipboardData && e.clipboardData.getData("text/plain");
    if (!t) return;
    const conv = asSongText(t);
    if (conv === t) return;
    e.preventDefault();
    edReplace(notesTa.selectionStart, notesTa.selectionEnd, conv);
  });

  // ----- fingering editor: click the diagram to change how a chord is played -----
  let sh = null; // { name, frets, fingers, base, alt }
  const shOpen = () => $("shapeModal").classList.contains("show");
  const fretsText = (frets) => (frets.some((f) => f != null && f > 9) ? frets.map((f) => (f == null ? "x" : f)).join(" ") : frets.map((f) => (f == null ? "x" : f)).join(""));
  function openShapeEditor(name, opts = {}) {
    if (!NL || (!opts.any && !NL.parseChord(name))) return;
    const blank = { frets: [null, null, null, null, null, null], fingers: [0, 0, 0, 0, 0, 0] };
    const cur = opts.fresh ? blank : opts.shape || chordShapesMap[name] || NL.chordShape(name) || blank;
    const from = opts.from || cur.from || (NL.parseChord(name) ? name : null);
    sh = { name, from, mine: !!opts.mine, any: !!opts.any, frets: cur.frets.slice(), fingers: (cur.fingers || [0, 0, 0, 0, 0, 0]).slice(), base: null, alt: 0, capo: +cur.capo || 0, sel: null };
    $("shTitle").textContent = name ? `Chord: ${NL.pretty(name)}` : "New Chord";
    $("shName").value = name;
    $("shReset").disabled = !chordShapesMap[NL.chordKey(name)];
    renderShape();
    $("shapeModal").classList.add("show");
    setTimeout(() => $("shName").select(), 0);
  }
  function closeShapeEditor() {
    $("shapeModal").classList.remove("show");
    sh = null;
  }
  const shBase = () => {
    if (sh.base) return sh.base;
    const played = sh.frets.filter((f) => f != null && f > 0);
    return !played.length || Math.max(...played) <= 4 ? 1 : Math.min(...played);
  };
  function renderShape() {
    const base = shBase();
    const W = 220, sx = 34, fy = 40, L = 30, T = 44, rows = 5;
    const capo = sh.capo || 0;
    const H = T + rows * fy + 10 + (capo ? 20 : 0);
    const rootPc = NL.chordRootPc(sh.name) ?? (sh.from ? NL.chordRootPc(sh.from) : null);
    const o = [`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`];
    o.push(`<text class="cd-name" x="${L + 2.5 * sx}" y="14">${NL.esc(NL.pretty(sh.name))}</text>`);
    if (capo) {
      const snd = NL.parseChord(sh.name) ? NL.transposeChord(sh.name, capo) : null;
      const txt = [base === 1 ? "" : `Capo ${capo}`, snd ? `sounds as ${NL.pretty(snd)}` : ""].filter(Boolean).join(" · ");
      if (txt) o.push(`<text class="cd-sounds" x="${L + 2.5 * sx}" y="${H - 6}">${NL.esc(txt)}</text>`);
    }
    // the capo takes the place of the nut, with its fret beside it, like "3fr"
    if (base === 1 && capo) o.push(`<rect class="cd-capo" x="${L - 8}" y="${T - 7}" width="${5 * sx + 16}" height="8" rx="3"/><text class="cd-capofr big" x="${L - 11}" y="${T + 1}">${capo}fr</text>`);
    else if (base === 1) o.push(`<rect class="cd-nut" x="${L - 2}" y="${T - 5}" width="${5 * sx + 4}" height="5"/>`);
    else o.push(`<text class="cd-fr" x="${L - 16}" y="${T + fy / 2 + 4}">${base}</text>`);
    for (let r = 0; r <= rows; r++) o.push(`<line class="cd-line" x1="${L}" y1="${T + r * fy}" x2="${L + 5 * sx}" y2="${T + r * fy}"/>`);
    for (let s = 0; s < 6; s++) o.push(`<line class="cd-line" x1="${L + s * sx}" y1="${T}" x2="${L + s * sx}" y2="${T + rows * fy}"/>`);
    for (let s = 0; s < 6; s++) {
      const x = L + s * sx, f = sh.frets[s];
      if (sh.sel === s && !(f > 0)) o.push(`<circle class="cd-sel" cx="${x}" cy="${T - 17}" r="10" pointer-events="none"/>`);
      if (f == null) o.push(`<text class="cd-mark" x="${x}" y="${T - 12}" style="font-size:15px">×</text>`);
      else if (f === 0) o.push(`<circle class="cd-open" cx="${x}" cy="${T - 17}" r="6"/>`);
      o.push(`<rect class="hit" data-s="${s}" data-top="1" x="${x - sx / 2}" y="0" width="${sx}" height="${T - 4}"/>`);
      for (let r = 0; r < rows; r++) o.push(`<rect class="hit" data-s="${s}" data-f="${base + r}" x="${x - sx / 2}" y="${T + r * fy}" width="${sx}" height="${fy}"/>`);
      if (f && f >= base && f < base + rows) {
        const y = T + (f - base + 0.5) * fy;
        const isRoot = rootPc != null && ([40, 45, 50, 55, 59, 64][s] + f) % 12 === rootPc;
        if (sh.sel === s) o.push(`<circle class="cd-sel" cx="${x}" cy="${y}" r="16" pointer-events="none"/>`);
        o.push(`<circle class="cd-dot${isRoot ? " root" : ""}" cx="${x}" cy="${y}" r="12" pointer-events="none"/>`);
        if (sh.fingers[s]) o.push(`<text class="cd-fi${isRoot ? " root" : ""}" x="${x}" y="${y + 5}" style="font-size:14px">${sh.fingers[s] === 5 ? "T" : sh.fingers[s]}</text>`);
      }
    }
    o.push("</svg>");
    $("shEdit").innerHTML = o.join("");
    $("shBase").textContent = base;
    $("shCapo").textContent = capo ? "Capo " + capo : "No Capo";
    if (root.activeElement !== $("shFrets")) $("shFrets").value = fretsText(sh.frets);
  }
  // click a fret: a circle appears; click it again to step the finger 1→5, once more removes it
  // above the nut: click toggles open ○ / muted ×. Keys 1–5, 0, x, Delete act on the selected string.
  function shSetFinger(s, n) {
    if (sh.frets[s] > 0) sh.fingers[s] = n;
  }
  function shClear(s) {
    sh.frets[s] = 0;
    sh.fingers[s] = 0;
  }
  $("shEdit").addEventListener("click", (e) => {
    const h = e.target.closest(".hit");
    if (!h || !sh) return;
    const s = +h.dataset.s;
    $("shEdit").focus();
    sh.sel = s;
    if (h.dataset.top) {
      sh.frets[s] = sh.frets[s] === 0 ? null : 0;
      sh.fingers[s] = 0;
    } else {
      const f = +h.dataset.f;
      if (sh.frets[s] !== f) {
        sh.frets[s] = f;
        sh.fingers[s] = 0;
      } else if ((sh.fingers[s] || 0) < 5) sh.fingers[s] = (sh.fingers[s] || 0) + 1;
      else shClear(s);
    }
    renderShape();
  });
  $("shEdit").addEventListener("contextmenu", (e) => {
    const h = e.target.closest(".hit");
    if (!h || !sh) return;
    e.preventDefault();
    const s = +h.dataset.s;
    $("shEdit").focus();
    sh.sel = s;
    shClear(s);
    renderShape();
  });
  $("shEdit").addEventListener("keydown", (e) => {
    if (!sh || sh.sel == null) return;
    const s = sh.sel, k = e.key.toLowerCase();
    if (/^[1-5]$/.test(k)) shSetFinger(s, +k);
    else if (k === "delete" || k === "backspace") {
      if (sh.frets[s] > 0 && sh.fingers[s]) sh.fingers[s] = 0;
      else shClear(s);
    } else if (k === "x") {
      sh.frets[s] = null;
      sh.fingers[s] = 0;
    } else if (k === "0" || k === "o") shClear(s);
    else if (k === "arrowleft") sh.sel = Math.max(0, s - 1);
    else if (k === "arrowright") sh.sel = Math.min(5, s + 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
    renderShape();
  });
  // typed frets are used as soon as they make sense (six of them, low E to high e)
  const parseFrets = (v) => {
    v = String(v).trim().toLowerCase();
    const toks = /[\s,-]/.test(v) ? v.split(/[\s,-]+/).filter(Boolean) : [...v];
    if (toks.length !== 6 || toks.some((t) => !/^(x|\d{1,2})$/.test(t))) return null;
    return toks.map((t) => (t === "x" ? null : +t));
  };
  $("shFrets").addEventListener("input", (e) => {
    const frets = parseFrets(e.target.value);
    if (!frets || !sh || frets.join() === sh.frets.join()) return;
    sh.fingers = sh.fingers.map((fi, i) => (frets[i] === sh.frets[i] ? fi : 0));
    sh.frets = frets;
    sh.base = null;
    renderShape();
  });
  $("shFrets").addEventListener("change", (e) => {
    if (!parseFrets(e.target.value)) flash("Six frets, low E to high e, like x32010");
    if (sh) $("shFrets").value = fretsText(sh.frets);
  });
  $("shFrets").addEventListener("keydown", (e) => e.key === "Enter" && e.target.blur());
  $("shCapoDown").onclick = () => sh && ((sh.capo = Math.max(0, (sh.capo || 0) - 1)), renderShape());
  $("shCapoUp").onclick = () => sh && ((sh.capo = Math.min(12, (sh.capo || 0) + 1)), renderShape());
  $("shBaseDown").onclick = () => sh && ((sh.base = Math.max(1, shBase() - 1)), renderShape());
  $("shBaseUp").onclick = () => sh && ((sh.base = Math.min(20, shBase() + 1)), renderShape());
  $("shOther").onclick = () => {
    if (!sh) return;
    const all = NL.chordShapes(sh.name);
    if (!all.length) return;
    sh.alt = (sh.alt + 1) % all.length;
    const k = all.findIndex((x) => x.frets.join() === sh.frets.join());
    const pick = all[k >= 0 ? (k + 1) % all.length : sh.alt];
    sh.frets = pick.frets.slice();
    sh.fingers = (pick.fingers || [0, 0, 0, 0, 0, 0]).slice();
    sh.base = null;
    renderShape();
  };
  function saveChordShapes() {
    store.set("chordShapes", chordShapesMap);
    NL.setCustomChords(chordShapesMap);
    renderPreview();
  }
  $("shReset").onclick = () => {
    if (!sh) return;
    delete chordShapesMap[NL.chordKey(sh.name)];
    const name = sh.name;
    saveChordShapes();
    closeShapeEditor();
  };
  $("shSave").onclick = () => {
    if (!sh) return;
    let name = $("shName").value.trim().replace(/^\[|\]$/g, "").replace(/\s+/g, " ").slice(0, 30);
    if (sh.any) {
      name = name.replace(/ /g, "-"); // one word, so it works on a chord line in your songs
      // never replace a chord from the library: a customized "Am7" is kept as "Am7__Custom"
      if (NL.parseChord(name) && !(sh.name === name && chordShapesMap[name] && !NL.parseChord(sh.name))) name += "__Custom";
      $("shName").value = name;
    }
    if (!name) return flash("Give the chord a name"), $("shName").focus();
    if (!sh.any && !NL.isChord(name)) return flash(`“${name}” isn't a chord name`);
    if (sh.any && !sh.frets.some((f) => f != null)) return flash("Click the strings to make the shape");
    // your song is left as it is: a new chord only goes into the chord library
    const key = NL.parseChord(name) ? NL.chordKey(name) : name;
    if (sh.any && sh.mine && sh.name && sh.name !== name && chordShapesMap[sh.name] && !NL.parseChord(sh.name)) delete chordShapesMap[sh.name]; // renamed
    chordShapesMap[key] = { frets: sh.frets.slice(), fingers: sh.fingers.slice(), ...(sh.base ? { base: sh.base } : {}), ...(sh.capo ? { capo: sh.capo } : {}), ...(key === name && !NL.parseChord(name) && sh.from ? { from: sh.from } : {}) };
    saveChordShapes();
    const any = sh.any;
    closeShapeEditor();
    if (scOpen() && SC().tab === "chords") {
      if (any) Object.assign(CH(), { my: key, pick: 0 }, CH().filter === "lib" ? { filter: "all" } : {});
      else CH().pick = 0;
      persist();
      renderLib();
    }
  };
  $("shCancel").onclick = closeShapeEditor;
  $("shClose").onclick = closeShapeEditor;
  $("shapeModal").addEventListener("click", (e) => {
    if (e.target === $("shapeModal")) closeShapeEditor();
  });

  // ----- tuner: listen through the microphone, or play each string's note -----
  const TU = () => {
    const t = state.settings.tuner && typeof state.settings.tuner === "object" ? state.settings.tuner : (state.settings.tuner = {});
    if (!["guitar", "bass"].includes(t.instr)) t.instr = "guitar";
    if (!t.a4 || t.a4 < 430 || t.a4 > 450) t.a4 = 440;
    if (!["listen", "play"].includes(t.mode)) t.mode = "listen";
    if (!["repeat", "constant"].includes(t.sound)) t.sound = "repeat"; // Pluck (again and again) or a constant tone
    if (!(t.vol >= 0 && t.vol <= 100)) t.vol = 70;
    return t;
  };
  const tu = { ctx: null, stream: null, src: null, an: null, timer: 0, buf: null, hist: [], quietSince: 0, lock: null, ring: null, ringTimer: 0, allTimer: 0, held: null, master: null };
  // guitar: 6 or 7 strings; bass: 4 or 5
  const tuCounts = () => (TU().instr === "bass" ? [4, 5] : [6, 7]);
  const tuList = () => {
    const t = TU(), counts = tuCounts();
    const n = counts.includes(t.count) ? t.count : counts[0];
    return NL.TUNINGS.filter((x) => x.instr === t.instr && x.midi.length === n);
  };
  const tuTuning = () => {
    const t = TU(), list = tuList();
    return list.find((x) => x.id === t.tuning) || list[0];
  };
  // strings low to high: { name, midi }
  const tuStrings = () => {
    const tn = tuTuning();
    return tn.strings.map((nm, i) => ({ name: nm, midi: tn.midi[i] })).reverse();
  };
  function tuCtx() {
    if (!tu.ctx) {
      tu.ctx = new (window.AudioContext || window.webkitAudioContext)();
      tu.master = tu.ctx.createGain(); // the volume slider
      const lim = tu.ctx.createDynamicsCompressor(); // keeps loud low notes from distorting
      lim.threshold.value = -6;
      lim.ratio.value = 12;
      tu.master.connect(lim).connect(tu.ctx.destination);
    }
    if (tu.ctx.state === "suspended") tu.ctx.resume();
    tu.master.gain.value = Math.pow(TU().vol / 100, 1.6);
    return tu.ctx;
  }
  function tuMeterSvg() {
    const cx = 150, cy = 140, r = 118;
    const pt = (deg, rr) => [cx + rr * Math.sin((deg * Math.PI) / 180), cy - rr * Math.cos((deg * Math.PI) / 180)];
    const arc = (a, b, rr) => {
      const [x1, y1] = pt(a, rr), [x2, y2] = pt(b, rr);
      return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${rr} ${rr} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    };
    const o = [`<path class="arc" d="${arc(-60, 60, r)}"/>`, `<path class="ok" d="${arc(-6, 6, r)}"/>`];
    for (let c = -50; c <= 50; c += 10) {
      const big = c % 50 === 0 || c === 0;
      const [x1, y1] = pt(c * 1.2, r - 10), [x2, y2] = pt(c * 1.2, r - (big ? 22 : 16));
      o.push(`<line class="tk${big ? " big" : ""}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`);
    }
    for (const [c, t] of [[-50, "♭"], [0, "0"], [50, "♯"]]) {
      const [x, y] = pt(c * 1.2, r - 32);
      o.push(`<text class="lbl" x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}">${t}</text>`);
    }
    o.push(`<line class="needle" id="tuNeedle" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r + 6}"/>`, `<circle class="hub" cx="${cx}" cy="${cy}" r="5"/>`);
    return o.join("");
  }
  function tuShow(f) {
    const meter = $("tuMeter"), msg = $("tuMsg");
    const strs = tuStrings(), a4 = TU().a4;
    root.querySelectorAll("#tuStrings button").forEach((b) => b.classList.remove("target", "in"));
    if (!f) {
      meter.classList.add("idle");
      meter.classList.remove("in");
      $("tuNeedle").style.transform = "rotate(0deg)";
      if (TU().mode === "listen" && tu.stream) {
        $("tuNote").textContent = "–";
        $("tuCents").textContent = "";
        msg.className = "tumsg";
        msg.textContent = "Play a String";
      }
      return;
    }
    const n = NL.noteForFreq(f, a4);
    // the string it's closest to (or the one you picked)
    let k = tu.lock;
    if (k == null) {
      let best = Infinity;
      strs.forEach((x, i) => {
        const dd = Math.abs(n.exact - x.midi);
        if (dd < best) (best = dd), (k = i);
      });
    }
    const target = strs[k];
    const cents = Math.round(1200 * Math.log2(f / NL.midiFreq(target.midi, a4)));
    const ok = Math.abs(cents) <= 5;
    meter.classList.remove("idle");
    meter.classList.toggle("in", ok);
    $("tuNeedle").style.transform = `rotate(${Math.max(-50, Math.min(50, cents)) * 1.2}deg)`;
    $("tuNote").textContent = n.name;
    $("tuCents").textContent = `${f.toFixed(1)} Hz`;
    const btn = root.querySelector(`#tuStrings button[data-i="${k}"]`);
    if (btn) btn.classList.add(ok ? "in" : "target");
    msg.className = "tumsg " + (ok ? "in" : cents < 0 ? "up" : "down");
    msg.textContent = ok ? `${NL.midiName(target.midi)} In Tune` : `${NL.midiName(target.midi)}: Tune ${cents < 0 ? "Up ↑" : "Down ↓"} (${cents > 0 ? "+" : ""}${cents} cents)`;
  }
  async function tuListen() {
    if (tu.stream) return;
    const msg = $("tuMsg");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg.textContent = "No microphone here";
      return;
    }
    msg.className = "tumsg";
    msg.textContent = "Asking for the microphone…";
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      msg.textContent = "Microphone blocked. Allow it for youtube.com, or use Play Tone.";
      return;
    }
    if (!$("tunerModal").classList.contains("show") || TU().mode !== "listen") return stream.getTracks().forEach((t) => t.stop());
    const v = getVideo();
    if (v && !v.paused) v.pause(); // the video's sound would confuse the tuner
    const ctx = tuCtx();
    const bass = TU().instr === "bass";
    tu.stream = stream;
    tu.src = ctx.createMediaStreamSource(stream);
    tu.an = ctx.createAnalyser();
    tu.an.fftSize = bass ? 8192 : 4096;
    tu.src.connect(tu.an);
    tu.buf = new Float32Array(tu.an.fftSize);
    tu.hist = [];
    tu.quietSince = performance.now();
    tuShow(0);
    tu.timer = setInterval(() => {
      if (!tu.an) return;
      tu.an.getFloatTimeDomainData(tu.buf);
      const f = NL.detectPitch(tu.buf, ctx.sampleRate, bass ? 28 : 55, bass ? 450 : 1100);
      const now = performance.now();
      if (!f) {
        if (now - tu.quietSince > 1200) (tu.hist = []), tuShow(0);
        return;
      }
      tu.quietSince = now;
      // steady reading: the middle of the last few
      tu.hist.push(f);
      if (tu.hist.length > 5) tu.hist.shift();
      const sorted = tu.hist.slice().sort((a, b) => a - b);
      tuShow(sorted[Math.floor(sorted.length / 2)]);
    }, bass ? 80 : 60);
  }
  function tuStopListen() {
    clearInterval(tu.timer);
    tu.timer = 0;
    if (tu.src) tu.src.disconnect();
    if (tu.stream) tu.stream.getTracks().forEach((t) => t.stop());
    tu.stream = tu.src = tu.an = null;
  }
  // a soft plucked note: a few harmonics that fade away
  // the mix of overtones for a note: low (bass) notes lean on their overtones, so they sound as loud as guitar notes
  function tuVoice(f, hold) {
    const low = f < 165;
    const amps = low ? [0.75, 1, 0.8, 0.55, 0.36, 0.22, 0.13] : hold ? [1, 0.45, 0.2, 0.08] : [1, 0.55, 0.3, 0.14, 0.07];
    const sum = amps.reduce((a, b) => a + b, 0);
    const boost = low ? Math.min(1.9, 1 + (165 - f) / 140) : 1;
    return { amps, peak: ((hold ? 0.2 : 0.3) * (low ? 2.06 : sum)) / sum * boost, cut: Math.max(hold ? 2200 : 2600, f * 9) };
  }
  function tuTone(midi) {
    const ctx = tuCtx(), t = ctx.currentTime, f = NL.midiFreq(midi, TU().a4);
    const vc = tuVoice(f, false);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vc.peak, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 2.6);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = vc.cut;
    lp.connect(g).connect(tu.master);
    vc.amps.forEach((amp, i) => {
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f * (i + 1);
      og.gain.value = amp;
      o.connect(og).connect(lp);
      o.start(t);
      o.stop(t + 2.7);
    });
  }
  // a steady note that keeps sounding until it's stopped
  function tuHold(midi) {
    const ctx = tuCtx(), t = ctx.currentTime, f = NL.midiFreq(midi, TU().a4);
    const vc = tuVoice(f, true);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vc.peak, t + 0.08);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = vc.cut;
    lp.connect(g).connect(tu.master);
    const oscs = vc.amps.map((amp, i) => {
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.frequency.value = f * (i + 1);
      og.gain.value = amp;
      o.connect(og).connect(lp);
      o.start(t);
      return o;
    });
    tu.held = { g, oscs };
  }
  function tuStopHold() {
    if (!tu.held || !tu.ctx) return (tu.held = null);
    const t = tu.ctx.currentTime, { g, oscs } = tu.held;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    oscs.forEach((o) => o.stop(t + 0.15));
    tu.held = null;
  }
  function tuStopRing() {
    tuStopHold();
    clearInterval(tu.ringTimer);
    clearTimeout(tu.allTimer);
    tu.ringTimer = 0;
    tu.ring = null;
    root.querySelectorAll("#tuStrings button.ringing").forEach((b) => b.classList.remove("ringing"));
  }
  function tuPlay(i) {
    const strs = tuStrings();
    if (!strs[i]) return;
    const sound = TU().sound;
    if (sound !== "once") {
      const again = tu.ring === i;
      tuStopRing();
      if (again) return; // a second click stops it
      tu.ring = i;
      if (sound === "constant") tuHold(strs[i].midi);
      else {
        tuTone(strs[i].midi);
        tu.ringTimer = setInterval(() => tuTone(strs[i].midi), 2000); // plucked again and again
      }
      root.querySelector(`#tuStrings button[data-i="${i}"]`)?.classList.add("ringing");
    } else {
      tuStopRing();
      tuTone(strs[i].midi);
      const b = root.querySelector(`#tuStrings button[data-i="${i}"]`);
      if (b) b.classList.add("ringing"), setTimeout(() => b.classList.remove("ringing"), 700);
    }
    $("tuNote").textContent = NL.pretty(NL.midiName(strs[i].midi).replace(/-?\d+$/, ""));
    $("tuCents").textContent = `${NL.midiFreq(strs[i].midi, TU().a4).toFixed(1)} Hz`;
    $("tuMsg").className = "tumsg";
    $("tuMsg").textContent = NL.midiName(strs[i].midi);
  }
  function renderTuner() {
    const t = TU();
    root.querySelectorAll("#tuInstr button").forEach((b) => b.classList.toggle("active", b.dataset.v === t.instr));
    root.querySelectorAll("#tuMode button").forEach((b) => b.classList.toggle("active", b.dataset.v === t.mode));
    const cnt = $("tuCount");
    cnt.innerHTML = "";
    tuCounts().forEach((n) => cnt.append(new Option(`${n} Strings`, String(n))));
    cnt.value = String(tuTuning().midi.length);
    const sel = $("tuTuning");
    fillTunings(sel, tuList().map((x) => ({ ...x, name: x.name.replace(/(7|5)-String /, "") })), tuTuning().id, true);
    $("tuA4").value = String(t.a4);
    const box = $("tuStrings");
    box.innerHTML = "";
    tuStrings().forEach((x, i) => {
      const b = el("button");
      b.dataset.i = i;
      b.title = NL.midiName(x.midi);
      b.textContent = NL.pretty(x.name);
      if (t.mode === "listen" && tu.lock === i) b.classList.add("target");
      box.append(b);
    });
    $("tuOpts").hidden = t.mode !== "play";
    root.querySelector(".tuvol").hidden = t.mode !== "play";
    root.querySelectorAll("#tuSound button").forEach((b) => b.classList.toggle("active", b.dataset.v === t.sound));
    $("tuVol").value = String(t.vol);
    $("tuMeter").style.display = t.mode === "play" ? "none" : ""; // the needle is for listening
    $("tuInfo").textContent = t.mode === "listen" ? (tu.lock != null ? `Only ${NL.midiName(tuStrings()[tu.lock].midi)}` : "Any String") : "";
    if (!$("tuMeter").childElementCount) $("tuMeter").innerHTML = tuMeterSvg();
  }
  function tuSetMode() {
    const t = TU();
    tuStopRing();
    if (t.mode === "listen") tuListen();
    else {
      tuStopListen();
      tuShow(0);
      $("tuNote").textContent = "–";
      $("tuCents").textContent = "";
      $("tuMsg").className = "tumsg";
      $("tuMsg").textContent = "Click a String";
    }
  }
  function openTuner() {
    if (!NL) return;
    tu.lock = null;
    renderTuner();
    $("tunerModal").classList.add("show");
    tuSetMode();
  }
  function closeTuner() {
    $("tunerModal").classList.remove("show");
    tuStopListen();
    tuStopRing();
  }
  $("tunerBtn").onclick = () => ($("tunerModal").classList.contains("show") ? closeTuner() : openTuner());
  $("tuClose").onclick = $("tuDone").onclick = closeTuner;
  $("tunerModal").addEventListener("click", (e) => e.target === $("tunerModal") && closeTuner());
  $("tuInstr").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b || b.dataset.v === TU().instr) return;
    TU().instr = b.dataset.v;
    TU().tuning = null;
    TU().count = null;
    tu.lock = null;
    persist();
    tuStopListen();
    renderTuner();
    tuSetMode();
  });
  $("tuCount").addEventListener("change", (e) => {
    TU().count = +e.target.value;
    TU().tuning = null;
    tu.lock = null;
    persist();
    tuStopRing();
    renderTuner();
  });
  $("tuTuning").addEventListener("change", (e) => {
    TU().tuning = e.target.value;
    tu.lock = null;
    persist();
    tuStopRing();
    renderTuner();
  });
  $("tuA4").addEventListener("change", (e) => {
    TU().a4 = +e.target.value;
    persist();
  });
  $("tuMode").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b || b.dataset.v === TU().mode) return;
    TU().mode = b.dataset.v;
    persist();
    renderTuner();
    tuSetMode();
  });
  $("tuStrings").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    const i = +b.dataset.i;
    if (TU().mode === "play") return tuPlay(i);
    tu.lock = tu.lock === i ? null : i; // listen: tune just this string, or click again for any
    renderTuner();
  });
  $("tuSound").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    TU().sound = b.dataset.v;
    persist();
    tuStopRing();
    renderTuner();
  });
  $("tuVol").addEventListener("input", (e) => {
    TU().vol = +e.target.value;
    if (tu.master) tu.master.gain.value = Math.pow(TU().vol / 100, 1.6);
  });
  $("tuVol").addEventListener("change", () => persist());

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
    const t = THEMES.includes(state.settings.theme) ? state.settings.theme : "system";
    const resolved = t === "system" ? (darkQuery && !darkQuery.matches ? "light" : "dark") : t;
    host.setAttribute("data-theme", resolved);
    const b = $("themeBtn");
    if (b.dataset.t !== t) {
      b.innerHTML = THEME_ICON[t];
      b.dataset.t = t;
    }
    const next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    b.title = `Theme: ${THEME_NAME[t]}`;
  }
  $("themeBtn").onclick = () => {
    const t = THEMES.includes(state.settings.theme) ? state.settings.theme : "system";
    state.settings.theme = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    state.settings.themeChosen = true;
    persist();
    applyTheme();
  };
  try {
    darkQuery && darkQuery.addEventListener("change", () => !dead && applyTheme());
  } catch (e) {}

  // ----- help -----
  const HELP_DIMS = { "help-loop.png": [300, 220], "help-loopbar.png": [300, 37], "help-editor.png": [300, 333], "help-metronome.png": [300, 210], "help-saved.png": [300, 212] };
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
      <h3>Quick Start</h3>
      <ol>
        <li>Open a YouTube video and click the cat in the toolbar.</li>
        <li>Click <b>Set A</b> where the part starts and <b>Set B</b> where it ends. It starts looping.</li>
        <li>Lower the <b>Speed</b>. The pitch stays the same.</li>
        <li>Click <b>Save Loop</b> to keep it. Saving a loop saves the video too.</li>
      </ol>

      <h3>Loops</h3>
      ${helpImg("help-loop.png", "The time, A and B, and the play and loop buttons")}
      <ul>
        <li>Fine-tune A and B with − and + (hold Shift for 1 second), or type a time such as <code>1:23.4</code>.</li>
        <li><b>Loop</b> turns looping on or off. <b>Clear</b> removes A and B.</li>
        <li><b>Speed</b> goes from 25% to 500% without changing the pitch.</li>
        <li><b>Pause Between Loops</b> waits before each repeat. <b>Change Speed Each Loop</b> gets a little faster every time.</li>
      </ul>
      ${helpImg("help-loopbar.png", "The loop list, Save Loop, New Loop and the loop editor")}
      <ul>
        <li>A video can have many loops. Pick one from the list. Drag to reorder, ✎ to edit, 🗑 to delete.</li>
        <li><b>＋</b> starts a new loop.</li>
      </ul>

      <h3>Saved Videos</h3>
      ${helpImg("help-saved.png", "Saved videos")}
      <ul>
        <li>The list button at the top shows your saved videos and their loops. The list next to the search box sorts them: My Order, Newest First, Oldest First, Name A–Z or Z–A.</li>
        <li><b>Export</b> (the down arrow at the top) saves everything in one .gpyc file (Chrome asks where to save it and what to call it; the .gpyc ending is kept); <b>Import</b> (the up arrow) brings it back.</li>
        <li>The list next to <b>Save Loop</b> shows the video’s name and its loops. ✎ renames the video: type the name, then press Enter or click the disk to save it (an unsaved video is saved with that name). When the video or its first loop isn’t saved yet, the list has a <b>Save</b> button.</li>
        <li>A video is only saved when you save it. The disk left of the video’s name saves it (saving a loop saves it too). Once it’s saved, the disk turns into a bin: click it twice to delete the video with its loops, page and links. Writing in the <b>Editor</b> or adding a link also saves the video, so your work isn’t lost.</li>
      </ul>

      <h3>Editor</h3>
      <ul>
        <li><b>Editor</b> (or ${k("N")}) opens a page for the video. A new page starts with the video’s title as a heading (H1), with the cursor on the line under it. Put the chords on the line above the words. It saves as you type.</li>
        <li>The top row formats text: font, size, headings, <b>bold</b>, <i>italic</i>, superscript, subscript, text colour, highlight colours, lists, links and tables. With text selected, only that text changes. Font and size with nothing selected change the whole page. The formatting shows as you type. The styles menu also has <b>Upper Case</b> and <b>Lower Case</b> for the selection, or the whole page when nothing is selected (chord lines are left alone). <b>Text Colour</b> with nothing selected colours the whole page; <b>Default Colour</b> takes it off.</li>
        <li><b>＋ → Picture</b> adds an image; you can also paste or drop one into the page. Backspace after it removes it.</li>
        <li>The squiggle button lets you draw on the page with a pencil, pen, old ink pen, marker or chalk, in any colour and size. Smear softens what’s under it; the eraser removes a line. <b>Done</b>, or clicking the chosen tool again, goes back to typing.</li>
        <li>The <b>Section</b> list adds [Verse], [Chorus] and so on. The <b>↓ ↑</b> arrows (Transpose) move every chord down or up a half step. The buttons after them are <b>Chords</b>, <b>Scales</b>, <b>Tabs</b>, <b>Loops</b>, <b>Links</b> and <b>Guess</b> (a menu: <b>Lyrics</b> or <b>Key</b>). In a narrow editor these buttons show just their icons.</li>
        <li>The <b>Chord Library</b> on the right shows the song’s chords. The side-panel button just right of <b>＋</b> (Show / Hide Chord Shapes) shows or hides that whole side; hiding it makes the editor window narrower so more of the video shows, and showing it widens it again. Type in <b>Add a Chord</b> to add others that aren’t in the words yet (All · Library · Mine filters both the choices and the chords already in the library; Mine is your own chords. Chords already in the library aren’t offered again); × removes one. They move with the arrows and go into the PDF. Click a chord shape to change it: click a fret to add a finger, click again to number it, and once more to remove it.</li>
        <li><b>Tabs</b>: click a string and type the fret. Name a tab and <b>Save</b> it to keep it for every video; pick it again from the list, change it or <b>Delete</b> it. <b>Save</b> turns on once the tab has a name and something changed. <b>New Tab</b> starts an empty one; <b>Export</b> makes a PDF, prints it or saves it as a text file; <b>Close</b> leaves without adding anything. Frets go from 0 to 24. <b>Capo</b> shows where the capo sits beside the strings; click string names to leave some strings out (a partial capo). <b>Show</b>: Finger Position (frets), Notes, or both. <b>Insert Tab into Editor</b> adds it with its name and capo.</li>
        <li><b>Guess → Lyrics</b> reads the lyrics from the video’s closed captions or subtitles and adds them at the cursor, one verse after another. Lyrics in capitals are turned into lower case (with a capital at the start of each line). <b>Include Timestamps</b> puts a time like [0:12] at the start of each verse; it’s off unless you turn it on. It checks first: if the video has captions, finding the lyrics is likely; if it has none, it says so. Captions written by people are used first. It’s not perfect: check the words.</li>
        <li><b>Guess → Key</b> looks at the chords in the page and names the likeliest key, its relative key, other possible keys and, with a capo, the key it sounds in. <b>Insert Key</b> puts a “Key: G Major” line under the title, and <b>Scales</b> then opens in that key. A key line near the top shows the start of a score beside it: the treble clef with the key’s sharps or flats (also in the PDF).</li>
        <li><b>Capo</b> (next to the arrows) puts a “Capo 3” line under the title; the chord shapes, the scales and the PDF follow it. Chord shapes show the capo the usual way: a bar in place of the nut with its fret beside it (“3fr”), and the chord shape is played from the capo. With no capo line it shows <b>No Capo</b>.</li>
        <li>Point at a chord in the page for a moment and its fingering pops up (with the capo, if there is one).</li>
        <li><b>Loops</b> adds one of your loops to the page. <b>Links</b> keeps links to scores, tabs and lessons (also the link button next to Tabs on the main panel). Click a link’s name or its full address to open it in its own window.</li>
        <li>Ctrl+click (⌘+click on a Mac) a loop, a time or a web address in the page to use it.</li>
        <li>At the bottom: <b>Export</b> (a text file with plain words and no formatting, a PDF or print, with or without chords and links) and <b>Close</b> (or × at the top). The PDF keeps the colours, highlights and drawings.</li>
      </ul>

      <h3>Chords, Scales, and Tabs</h3>
      <ul>
        <li><b>Scales</b>: 51 scales for guitar (6 or 7 strings) or bass (4 or 5 strings), in any key and tuning (Standard & Drop, Open and more). Click a string’s letter beside the fretboard to tune that string; the tab follows. In the tab each pattern starts its own line, three measures to a line. Red dots are the root. The key signature the scale is written in shows to the right of the pattern rows (a mode uses its parent key: D Dorian is written like C major). The button left of the Chords tab hides the list on the left (on Chords, Scales and Tabs), which makes the window narrower; click it again to bring the list back.</li>
        <li><b>Customize Scale</b> shows every note of the chosen scale on the neck. Click a note to turn it on or off, or a string name for the whole string; <b>Reset</b> goes back to what was showing. Name it and save it: it’s in the list under My Scales, in any key (All · Library · Mine filters the list). Library scales are never changed. ✎ edits or deletes it.</li>
        <li><b>Chords</b>: every chord type (major to 13ths) in any key, with several shapes to play each, on guitar, 7-string guitar or bass (the list next to Root). <b>Diagrams</b> or <b>Text</b> shows the fingerings as pictures or in letters. Type a chord (Am7, Gsus4 …) in the search box to find it. ✎ on a shape changes it and makes it the one your songs show. <b>Customize Chord</b> starts from the chosen shape: change it, give it a one-word name, and use that name in your songs. It starts with the name “Am7__Custom” (for an Am7), keeps the red roots of the chord it came from, and goes into the chord library under My Chords; your song is not changed. All · Library · Mine filters the list. Library chords are never changed.</li>
        <li><b>Tabs</b> (after Scales; CAGED and Circle of Fifths come next): every tab you saved, for any video. With none saved yet, Tabs goes straight to a new tab. Pick one to see it; <b>Edit</b>, <b>Delete</b>, <b>New Tab</b>, <b>Export</b>, or <b>Insert into Editor</b>.</li>
        <li><b>CAGED</b>: the five shapes of a chord. <b>Circle of Fifths</b>: keys and their chords.</li>
        <li><b>Insert into Editor ▾</b> adds what you see to the page at the cursor (at the end of the page if you haven’t clicked in it, or if the editor isn’t open: it opens this video’s page), <b>As Text</b> (tab, chord name, key) or <b>As Image</b> (a picture of the fretboard, chord shape, tab, CAGED neck or circle). <b>Export</b> makes a PDF, prints it, or saves a text file with the chord shapes and the fretboard drawn in letters.</li>
      </ul>

      <h3>Metronome</h3>
      ${helpImg("help-metronome.png", "The metronome")}
      <ul>
        <li><b>Start</b> the click. Set the speed with − and +, the slider or <b>Tap</b>.</li>
        <li><b>Auto BPM</b>: the cat listens to the video and finds the tempo.</li>
        <li>The metronome starts hidden. The metronome button at the top shows or hides it. The round arrow beside <b>Metronome</b> folds its controls away (<b>Show</b> / <b>Hide</b>).</li>
      </ul>

      <h3>Tuner</h3>
      <ul>
        <li>The tuning-fork button at the top opens the tuner, for guitar (6 or 7 strings) or bass (4 or 5 strings) in any tuning, with A4 from 430 to 450 Hz.</li>
        <li><b>Microphone</b> listens through your microphone (Chrome asks the first time) and pauses the video. Play a string: the needle and the note show how far off it is; <b>Tune Up</b> or <b>Tune Down</b> until it says <b>In Tune</b>. It finds the string by itself, or click a string to tune only that one.</li>
        <li><b>Play Tone</b> plays each string’s note when you click it: <b>Pluck</b> (plucked again and again) or <b>Constant</b> (a steady tone). Click the string again to stop. Bass notes play as loud as guitar notes. <b>Volume</b> sets how loud.</li>
      </ul>

      <h3>Buttons at the Top</h3>
      <p>Saved videos · import · export · tuner · metronome · theme · help · close. Under them, next to the time: <b>Editor</b>, <b>Chords</b>, <b>Scales</b>, <b>Tabs</b> and <b>Links</b>. The panel opens at the upper right, beside the video rather than over it; drag the title bar to move it.</p>

      <h3>Keyboard Shortcuts</h3>
      <table>
        <tr><td>${k("[")} / ${k("]")}</td><td>Set A / set B</td></tr>
        <tr><td>${k("\\")}</td><td>Loop on/off</td></tr>
        <tr><td>${k(";")}</td><td>Jump to A</td></tr>
        <tr><td>${k("Backspace")}</td><td>Clear the loop</td></tr>
        <tr><td>${k("-")} / ${k("=")}</td><td>Speed down / up 5%</td></tr>
        <tr><td>${k("N")}</td><td>Editor for this video</td></tr>
        <tr><td>${k("Esc")}</td><td>Close a pop-up</td></tr>
      </table>

      <h3>Troubleshooting</h3>
      <ul>
        <li><b>The speed won’t change, or a red warning appears</b>: another copy of this extension, or another speed extension (like Video Speed Controller), is fighting over the video. Keep one, then refresh.</li>
        <li><b>No panel</b>: click the toolbar icon on a YouTube tab. Just installed or updated? Refresh the tab.</li>
        <li><b>Auto BPM hears nothing</b>: the video has to be playing and not muted.</li>
        <li><b>The tuner hears nothing</b>: allow the microphone for youtube.com (the icon at the right of the address bar), or use <b>Play Tone</b>.</li>
        <li><b>Start over</b>: <b>Reset to Default…</b> at the bottom of this window. <b>Reset Settings</b> puts the theme, panel, speed, metronome and other choices back and keeps your saved work; <b>Erase Everything</b> also deletes every saved video, loop, page, tab and your own chords and scales (<b>Export First</b> keeps a copy).</li>
      </ul>

      <h3>Privacy</h3>
      <p>Nothing leaves your computer. No accounts, no analytics, no tracking. Your settings, saved videos, loops, pages and links are kept in the browser’s local extension storage. Auto BPM and the tuner analyse the sound inside your browser; the microphone is only used while the tuner is listening.</p>

      <h3>About</h3>
      <p>YouTube Guitar Playa Companion ${VERSION ? "v" + VERSION : ""}. Everything stays in this browser.</p>
      <div class="warnbox"><b>Warning</b><br />For personal use. Experimental and unsupported; use at your own risk. Provided as is, with no warranty. It may stop working when YouTube changes its website.</div>
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
  $("helpClose").onclick = $("helpDone").onclick = closeHelp;
  $("helpModal").addEventListener("click", (e) => {
    if (e.target === $("helpModal")) closeHelp();
  });

  // ----- Reset to Default: put the settings back, or erase everything and start over -----
  let rsArm = false, rsTimer = null;
  function openReset() {
    rsArm = false;
    renderReset();
    $("resetModal").classList.add("show");
    setTimeout(() => $("rsCancel").focus(), 0);
  }
  function closeReset() {
    clearTimeout(rsTimer);
    rsArm = false;
    $("resetModal").classList.remove("show");
  }
  function renderReset() {
    const b = $("rsAll");
    b.textContent = rsArm ? "Click Again to Erase" : "Erase Everything";
    b.title = rsArm ? "Deletes everything. This can’t be undone" : "Erase Everything";
  }
  // close every window and stop what's running, so nothing shows old settings or data
  function closeEverything() {
    closeLoopPop();
    closeExport();
    closeLinkPop();
    closeActMenu();
    if ($("loopModal").classList.contains("show")) closeLoopEditor();
    if ($("linksModal").classList.contains("show")) closeLinks();
    if ($("shapeModal").classList.contains("show")) closeShapeEditor();
    if ($("scEdModal").classList.contains("show")) closeScaleEditor();
    if ($("lyModal").classList.contains("show")) closeLyricsAsk();
    if ($("gkModal").classList.contains("show")) closeGuessKey();
    if ($("tunerModal").classList.contains("show")) closeTuner();
    if (te) closeTabEditor();
    if (scOpen()) closeScales();
    closeNotes();
    closeLib();
    closeHelp();
    closeReset();
    root.querySelectorAll(".modal-back.show").forEach((m) => m.classList.remove("show"));
    if (metro.on) stopMetro();
    stopDetect();
    state.looping = false;
    state.loopCount = 0;
    cancelWait();
  }
  function resetSettings() {
    const hidden = state.settings.hidden;
    state.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    state.settings.hidden = hidden;
    if (metro.gain) metro.gain.gain.value = Math.pow(M().vol / 100, 1.5);
    setSpeed(1);
    applyTheme();
    store.set("settings", state.settings);
    placePanel();
    render();
  }
  $("resetOpen").onclick = openReset;
  $("rsClose").onclick = $("rsCancel").onclick = closeReset;
  $("resetModal").addEventListener("click", (e) => e.target === $("resetModal") && closeReset());
  $("rsExport").onclick = () => exportLibrary();
  $("rsSettings").onclick = () => {
    closeEverything();
    resetSettings();
    flash("Settings are back to default");
  };
  $("rsAll").onclick = async () => {
    clearTimeout(rsTimer);
    if (!rsArm) {
      rsArm = true; // ask once more: this deletes everything
      rsTimer = setTimeout(() => ((rsArm = false), renderReset()), 4000);
      return renderReset();
    }
    closeEverything();
    try {
      await chrome.storage.local.clear();
    } catch (e) {}
    library = [];
    myTabs = [];
    customScales = [];
    if (NL) NL.setCustomScales([]);
    setChordShapes({});
    state.loopId = null;
    state.a = state.b = null;
    state.saved = [];
    nameEdited = false;
    expanded.clear();
    resetSettings();
    persist();
    flash("Everything is erased. Starting over");
  };
  // keep the list in sync when you save from another YouTube tab
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && ch.chordShapes && !dead) {
        setChordShapes(ch.chordShapes.newValue);
        if (notesOpen()) renderPreview();
      }
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
        KeyN: () => (notesOpen() && notesVid === state.videoId ? closeNotes() : openNotes()),
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
    if (te) closeTabEditor();
    if (scOpen()) closeScales();
    if (shOpen()) closeShapeEditor();
    closeNotes();
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
  async function openApp() {
    openRequested = true;
    const id = getVideoId();
    if (id !== state.videoId) await onVideoChange(id); // draw the panel whole, with this video, in one go
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
  try {
    const u = (f) => chrome.runtime.getURL("fonts/" + f);
    const latin = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
    const ext = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
    pageStyle.textContent += [400, 700]
      .flatMap((w) => [
        `@font-face { font-family:"Roboto Mono"; font-style:normal; font-weight:${w}; font-display:swap; src:url(${u(`roboto-mono-latin-${w}-normal.woff2`)}) format("woff2"); unicode-range:${latin}; }`,
        `@font-face { font-family:"Roboto Mono"; font-style:normal; font-weight:${w}; font-display:swap; src:url(${u(`roboto-mono-latin-ext-${w}-normal.woff2`)}) format("woff2"); unicode-range:${ext}; }`,
      ])
      .join("\n");
  } catch (e) {}

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
    if (!state.settings.themeChosen) state.settings.theme = "system"; // follows your computer until you pick a theme
    state.settings.hidden = true; // stays idle on every page until you click the toolbar icon
    state.settings.collapsed = false;
    if (openRequested) {
      state.settings.hidden = false;
      state.settings.collapsed = false;
    }
    delete state.settings.metro;
    await loadLibrary();
    setChordShapes(await store.get("chordShapes"));
    {
      const tb = await store.get("tabs");
      myTabs = Array.isArray(tb) ? tb.filter((x) => x && x.id && x.name && typeof x.text === "string") : [];
    }
    {
      const cs = await store.get("customScales");
      customScales = Array.isArray(cs) ? cs.filter((x) => x && x.id && x.name && x.formula) : [];
      if (NL) NL.setCustomScales(customScales);
    }
    // know the video before the panel is first drawn, so it appears whole (not the bottom first)
    const id0 = getVideoId();
    if (id0) await onVideoChange(id0);
    wireVideo(getVideo());
    updateNow();
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
