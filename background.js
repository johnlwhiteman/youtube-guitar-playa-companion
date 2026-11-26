// Toolbar icon: only active on YouTube. Everywhere else it is greyed out and does nothing.
const YT = /^https:\/\/(www|m|music)\.youtube\.com\//;

function updateIcon(tabId, url) {
  if (tabId == null || tabId < 0) return;
  // Chrome only tells this extension the address of YouTube tabs, so any other tab has no url here.
  const on = !!url && YT.test(url);
  (on ? chrome.action.enable(tabId) : chrome.action.disable(tabId)).catch(() => {});
}
async function updateAllTabs() {
  const tabs = await chrome.tabs.query({});
  tabs.forEach((t) => updateIcon(t.id, t.url));
}
chrome.action.disable(); // greyed out by default; YouTube tabs are switched on below
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status) updateIcon(tabId, tab.url);
});
chrome.tabs.onActivated.addListener(({ tabId }) => chrome.tabs.get(tabId).then((t) => updateIcon(t.id, t.url)).catch(() => {}));
chrome.tabs.onReplaced.addListener((tabId) => chrome.tabs.get(tabId).then((t) => updateIcon(t.id, t.url)).catch(() => {}));
chrome.runtime.onInstalled.addListener(updateAllTabs);
chrome.runtime.onStartup.addListener(updateAllTabs);
updateAllTabs();

// Clicking the toolbar icon opens the companion on the current YouTube tab.
// If that tab was already open before the extension was installed/updated, inject the scripts first.
async function openIn(tabId) {
  await chrome.tabs.sendMessage(tabId, { type: "open-panel" });
}
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url || !YT.test(tab.url)) return;
  try {
    await openIn(tab.id);
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["page-bridge.js"], world: "MAIN" });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["notes-lib.js", "content.js"] });
      await openIn(tab.id);
    } catch (err) {
      console.warn("Guitar Playa Companion: could not open in this tab", err);
    }
  }
});

// "Open extensions page" button in the panel (pages can't open chrome:// links themselves).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "open-extensions") chrome.tabs.create({ url: "chrome://extensions" });
});
