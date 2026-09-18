chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'improveWithAI',
    title: 'Improve with AI',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'improveWithAI') {
    chrome.tabs.sendMessage(tab.id, {
      type: 'IMPROVE_SELECTION',
      text: info.selectionText
    }, () => {
      // Suppress the error if content script isn't ready yet
      if (chrome.runtime.lastError) {
        console.log('Content script not ready:', chrome.runtime.lastError.message);
      }
    });
  }
});