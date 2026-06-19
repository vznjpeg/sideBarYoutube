// Toggle the sidebar when the toolbar icon is clicked.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url || !tab.url.startsWith("https://www.youtube.com/")) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "YTS_TOGGLE" });
  } catch (err) {
    // Content script may not be injected yet (e.g. page loaded before the
    // extension). Inject it on demand, then retry the toggle.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      await chrome.tabs.sendMessage(tab.id, { type: "YTS_TOGGLE" });
    } catch (e) {
      console.error("YouTube Transcript Sidebar: unable to toggle", e);
    }
  }
});
