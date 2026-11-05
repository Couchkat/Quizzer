// Quizzer background service worker.
// - Toolbar icon opens the side panel.
// - Right-click "Quiz me on this" and the on-page "Quiz me" chip both open the panel
//   and hand it the selected text through chrome.storage.session ("pendingQuiz"),
//   so nothing is lost while the panel is still opening (same handoff Noted uses).

const MENU_ID = "quizzer-selection";

function setup() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: "Quiz me on this", contexts: ["selection"] });
  });
}
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

// Runs inside the page: the selection with its line breaks (selectionText flattens them)
function readSelection() {
  const s = window.getSelection();
  return s && !s.isCollapsed ? s.toString() : "";
}

async function queueQuiz(quiz) {
  await chrome.storage.session.set({ pendingQuiz: { ...quiz, at: Date.now() } });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab) return;
  // sidePanel.open must run straight away, while Chrome still counts this as a user click
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  (async () => {
    let text = info.selectionText || "";
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
        func: readSelection,
      });
      if (res?.result?.trim()) text = res.result;
    } catch {}
    await queueQuiz({ kind: "selection", text, url: info.pageUrl || tab.url || "", title: tab.title || "", tabId: tab.id });
  })();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "quiz-selection" && sender.tab) {
    chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
    queueQuiz({ kind: "selection", text: msg.text, url: msg.url, title: msg.title, tabId: sender.tab.id });
  }
});
