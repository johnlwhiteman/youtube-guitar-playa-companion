// Runs in YouTube's own page context (not the extension's isolated world).
//
// Speed lock: YouTube's player keeps re-applying its own speed to the <video>, turns pitch
// preservation off, and only accepts its own preset speeds. Other extensions (or older copies of
// this one) may also set the speed. While the companion is in charge, the main video is held at
// the companion's speed with pitch preserved:
//   - writes from YouTube's page code are intercepted (guard on the element's playbackRate),
//   - writes from anywhere else are undone the moment they happen (ratechange), and reported.
// During ads YouTube is left alone. On exit/removal everything is put back to normal.
(() => {
  if (window.__ygcLock) return;
  window.__ygcLock = true;
  // Switch off page scripts left by older versions of the companion (they'd block or fight this one).
  window.postMessage({ source: "ygc-content", type: "teardown" }, "*");

  const RATE = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "playbackRate");
  const PITCH = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "preservesPitch");
  let forced = null; // the companion's speed, or null when the companion is off
  const locked = new Set();
  let outsideWrites = [];
  let lastReport = 0;

  const inAd = () => !!document.querySelector("#movie_player.ad-showing");
  const isMain = (v) => v.hasAttribute("data-ygc-main");
  const holding = (v) => forced != null && isMain(v) && !inAd();
  const post = (msg) => window.postMessage({ source: "ygc2-page", ...msg }, "*");

  function lock(v) {
    if (locked.has(v)) return;
    Object.defineProperty(v, "playbackRate", {
      configurable: true,
      enumerable: true,
      get() {
        return RATE.get.call(this);
      },
      set(r) {
        RATE.set.call(this, holding(this) ? forced : r);
      },
    });
    if (PITCH) {
      Object.defineProperty(v, "preservesPitch", {
        configurable: true,
        enumerable: true,
        get() {
          return PITCH.get.call(this);
        },
        set(x) {
          PITCH.set.call(this, holding(this) ? true : x);
        },
      });
    }
    locked.add(v);
  }
  function unlockAll() {
    locked.forEach((v) => {
      delete v.playbackRate; // back to the normal built-in behaviour
      delete v.preservesPitch;
    });
    locked.clear();
  }
  function enforce() {
    if (forced == null) return;
    document.querySelectorAll("video[data-ygc-main]").forEach((v) => {
      lock(v);
      if (!holding(v)) return;
      if (PITCH && !PITCH.get.call(v)) PITCH.set.call(v, true);
      if (Math.abs(RATE.get.call(v) - forced) > 0.001) RATE.set.call(v, forced);
    });
  }
  const timer = setInterval(enforce, 200);

  // While holding the speed, speed-change events on the main video are handled here first and go no
  // further, so nothing else (YouTube, other extensions, older copies of the companion) can react
  // and start a tug-of-war. A change made from outside the page is undone immediately.
  let pauseUntil = 0;
  function onRateChange(e) {
    const v = e.target;
    if (!(v instanceof HTMLMediaElement) || !holding(v)) return;
    e.stopImmediatePropagation();
    if (Math.abs(RATE.get.call(v) - forced) < 0.001) return;
    const now = Date.now();
    outsideWrites = outsideWrites.filter((t) => now - t < 3000);
    outsideWrites.push(now);
    if (outsideWrites.length >= 3 && now - lastReport > 1000) {
      lastReport = now;
      post({ type: "conflict" });
    }
    if (now < pauseUntil) return; // safety valve against runaway loops
    if (outsideWrites.filter((t) => now - t < 1000).length > 40) {
      pauseUntil = now + 1000;
      return;
    }
    RATE.set.call(v, forced);
  }
  window.addEventListener("ratechange", onRateChange, true);

  // Keep YouTube's own speed setting in step when it's one YouTube supports (keeps its ⚙ menu honest).
  function tellPlayer(rate) {
    const p = document.getElementById("movie_player");
    try {
      const avail = (p && p.getAvailablePlaybackRates && p.getAvailablePlaybackRates()) || [];
      if (avail.includes(rate) && p.getPlaybackRate() !== rate) p.setPlaybackRate(rate);
    } catch (e) {}
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.source !== "ygc2") return;
    const d = e.data;
    if (d.type === "force-rate") {
      const r = Number(d.rate);
      if (r > 0) {
        forced = r;
        enforce();
        tellPlayer(r);
      } else {
        forced = null;
        unlockAll();
        tellPlayer(1);
      }
    } else if (d.type === "ping") {
      post({ type: "pong" });
    } else if (d.type === "teardown") {
      forced = null;
      unlockAll();
      clearInterval(timer);
      window.removeEventListener("ratechange", onRateChange, true);
      window.__ygcLock = false;
    }
  });
})();
