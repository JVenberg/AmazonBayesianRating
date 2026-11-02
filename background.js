chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// Content scripts can't open the settings page themselves.
chrome.runtime.onMessage.addListener(message => {
  if (message === "open-settings") chrome.runtime.openOptionsPage();
});
