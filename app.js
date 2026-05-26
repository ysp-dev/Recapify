/* ==========================================================================
   Recapify - Application Bootstrap
   file:// compatible classic script entrypoint
   ========================================================================== */

document.addEventListener('DOMContentLoaded', function () {
  migrateLocalStorageKeys();
  setupApiKey();
  setupTheme();
  setupSettingsListeners();
  setupUploadZone();
  setupAudioPlayer();
  setupTabs();
  setupTranscriptActions();
  setupSummaryActions();
  setupChatActions();
  setupPromptHistory();
  restoreCachedTranscript();
  startVisualizer();
  setupPullToRefresh();
  if (window.lucide) window.lucide.createIcons();
});
