/* ==========================================================================
   UI, Settings & Shared Utilities
   ========================================================================== */

function migrateLocalStorageKeys() {
  var migrations = [
    ['aetherscribe_theme', 'recapify_theme'],
    ['aetherscribe_api_key', 'recapify_api_key']
  ];
  migrations.forEach(function (pair) {
    if (!localStorage.getItem(pair[1])) {
      var val = localStorage.getItem(pair[0]);
      if (val) { localStorage.setItem(pair[1], val); localStorage.removeItem(pair[0]); }
    }
  });
}



function setupTheme() {
  var savedTheme = localStorage.getItem('recapify_theme');
  if (!savedTheme) {
    savedTheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  if (savedTheme === 'light') {
    document.body.classList.add('light-mode');
    elements.themeToggleIcon.setAttribute('data-lucide', 'moon');
  } else {
    elements.themeToggleIcon.setAttribute('data-lucide', 'sun');
  }

  elements.btnThemeToggle.addEventListener('click', function () {
    var isLight = document.body.classList.toggle('light-mode');
    localStorage.setItem('recapify_theme', isLight ? 'light' : 'dark');
    elements.themeToggleIcon.setAttribute('data-lucide', isLight ? 'moon' : 'sun');
    showToast(isLight ? '라이트 모드로 전환되었습니다.' : '다크 모드로 전환되었습니다.');
    if (window.lucide) window.lucide.createIcons();
  });
}



function setupApiKey() {
  function setApiKeyReveal(isRevealed) {
    elements.apiKeyInput.type = isRevealed ? 'text' : 'password';
    elements.btnToggleApiKey.setAttribute('title', isRevealed ? 'API Key 숨기기' : 'API Key 보이기');
    elements.btnToggleApiKey.setAttribute('aria-label', isRevealed ? 'API Key 숨기기' : 'API Key 보이기');
    elements.btnToggleApiKey.innerHTML = '<i data-lucide="' + (isRevealed ? 'eye-off' : 'eye') + '"></i>';
  }

  function setApiKeyCollapsed(isCollapsed) {
    elements.apiKeyWrapper.classList.toggle('collapsed', isCollapsed);
    elements.btnCollapseApiKey.setAttribute('title', isCollapsed ? 'API Key 펼치기' : 'API Key 접기');
    elements.btnCollapseApiKey.setAttribute('aria-label', isCollapsed ? 'API Key 펼치기' : 'API Key 접기');
    elements.btnCollapseApiKey.innerHTML = '<i data-lucide="' + (isCollapsed ? 'plus' : 'minus') + '"></i>';
    if (isCollapsed) setApiKeyReveal(false);
    if (window.lucide) window.lucide.createIcons();
  }

  var savedKey = localStorage.getItem('recapify_api_key');
  if (savedKey) {
    state.apiKey = savedKey;
    elements.apiKeyInput.value = savedKey;
    elements.apiKeyWrapper.classList.add('secure');
  }
  setApiKeyCollapsed(!!savedKey);

  elements.apiKeyInput.addEventListener('input', function (e) {
    var key = e.target.value.trim();
    state.apiKey = key;
    if (key) {
      localStorage.setItem('recapify_api_key', key);
      elements.apiKeyWrapper.classList.add('secure');
    } else {
      localStorage.removeItem('recapify_api_key');
      elements.apiKeyWrapper.classList.remove('secure');
    }
  });

  elements.btnToggleApiKey.addEventListener('click', function () {
    if (elements.apiKeyWrapper.classList.contains('collapsed')) setApiKeyCollapsed(false);
    setApiKeyReveal(elements.apiKeyInput.type === 'password');
    if (window.lucide) window.lucide.createIcons();
  });

  elements.btnCollapseApiKey.addEventListener('click', function () {
    var isCollapsed = elements.apiKeyWrapper.classList.contains('collapsed');
    setApiKeyCollapsed(!isCollapsed);
    if (isCollapsed) {
      elements.apiKeyInput.focus();
      elements.apiKeyInput.select();
    }
  });
}



function setupSettingsListeners() {
  state.model = elements.selectModel.value;
  state.transcribeModel = elements.selectTranscribeModel.value;
  state.language = elements.selectLang.value;
  state.summaryPrompt = elements.inputSummaryPrompt.value;
  elements.selectModel.addEventListener('change', function (e) { state.model = e.target.value; });
  elements.selectTranscribeModel.addEventListener('change', function (e) { state.transcribeModel = e.target.value; });
  elements.selectLang.addEventListener('change', function (e) { state.language = e.target.value; });
  elements.inputSummaryPrompt.addEventListener('input', function (e) {
    state.summaryPrompt = e.target.value;
    state.summaryPromptDirty = true;
  });
  elements.inputSummaryPrompt.addEventListener('blur', function () {
    if (state.summaryPromptDirty) clearSummaryCache();
  });
  elements.btnResetSummaryPrompt.addEventListener('click', function () {
    elements.inputSummaryPrompt.value = '';
    state.summaryPrompt = '';
    clearSummaryCache();
    showToast('AI 정리 프롬프트를 초기화했습니다.');
  });
}



function resetWorkspaceData() {
  state.transcriptText = '';
  state.transcriptParagraphs = [];
  state.transcriptSourceName = state.currentFile ? state.currentFile.name : 'transcript';
  state.chaptersMarkdown = '';
  state.summaries = { summary: '', notes: '' };
  state.summaryRequests = {};
  state.chatHistory = [];
  state.lastPlaybackSegmentId = null;

  elements.transcriptContainer.innerHTML = '<div class="empty-state"><i data-lucide="music-4" class="empty-icon"></i><h3>전사록 없음</h3><p>오디오가 준비되면 전사 결과가 표시됩니다.</p></div>';
  elements.summaryContent.innerHTML = '<div class="empty-state"><i data-lucide="sparkles" class="empty-icon text-accent"></i><h3>요약 없음</h3><p>전사 완료 후 선택한 형식의 리포트가 표시됩니다.</p></div>';
  elements.chatMessagesContainer.innerHTML = '<div class="chat-system-message"><div class="system-icon"><i data-lucide="bot"></i></div><div class="system-text"><strong>Recapify AI 오디오 어시스턴트</strong><p>전사록 범위 안에서 답변합니다.</p></div></div>';
  elements.chaptersContainer.innerHTML = '';
  elements.chaptersContainer.classList.add('hidden');

  stopTtsRead();
  elements.transcriptSearch.value = '';
  elements.transcriptSearch.disabled = true;
  if (elements.btnTtsRead) elements.btnTtsRead.disabled = true;
  elements.btnGenerateChapters.disabled = true;
  elements.btnCopyTranscript.disabled = true;
  elements.btnDownloadTranscript.disabled = true;
  elements.btnResetTranscript.disabled = true;
  elements.btnCopySummary.disabled = true;
  elements.btnDownloadSummary.disabled = true;
  elements.chatInput.disabled = true;
  elements.chatInput.value = '';
  elements.btnSendChat.disabled = true;

  if (window.lucide) window.lucide.createIcons();
}



function createSkeletonBlock(className) {
  var block = document.createElement('div');
  block.className = 'skeleton-block ' + className;
  return block;
}



function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}



function escapeHTML(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}



function downloadTextFile(filename, content) {
  var mimeType = filename.endsWith('.md') ? 'text/markdown;charset=utf-8;' : 'text/plain;charset=utf-8;';
  var blob = new Blob([content], { type: mimeType });
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  showToast('파일이 다운로드되었습니다.');
}



function copyTextToClipboard(text, successMessage) {
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    showToast('클립보드 복사를 지원하지 않는 환경입니다. HTTPS 또는 최신 브라우저에서 다시 시도해 주세요.');
    return;
  }
  navigator.clipboard.writeText(text)
    .then(function () { showToast(successMessage); })
    .catch(function () {
      showToast('클립보드 복사에 실패했습니다. 브라우저 권한 또는 HTTPS 환경을 확인해 주세요.');
    });
}



function showToast(text) {
  elements.toastText.textContent = text;
  elements.toast.classList.remove('hidden');
  setTimeout(function () { elements.toast.classList.add('hidden'); }, 2500);
}



function setupTabs() {
  var tabs = [
    { btn: elements.tabTranscript, pane: elements.paneTranscript },
    { btn: elements.tabSummary, pane: elements.paneSummary },
    { btn: elements.tabChat, pane: elements.paneChat }
  ];

  tabs.forEach(function (t) {
    t.btn.addEventListener('click', function () {
      tabs.forEach(function (item) {
        item.btn.classList.remove('active');
        item.btn.setAttribute('aria-selected', 'false');
        item.pane.classList.remove('active');
      });
      t.btn.classList.add('active');
      t.btn.setAttribute('aria-selected', 'true');
      t.pane.classList.add('active');
      if (t.pane === elements.paneSummary) markSummaryAttention(false);

      if (t.pane === elements.paneSummary && (!state.summaryPrompt || !state.summaryPrompt.trim())) {
        renderSummaryPromptRequiredState();
        showToast('AI 정리 프롬프트를 먼저 입력해 주세요.');
        elements.inputSummaryPrompt.focus();
        return;
      } else if (t.pane === elements.paneSummary && state.transcriptParagraphs.length > 0 && !state.summaries[state.activeSummaryFormat]) {
        renderSummaryReadyState();
      }

      if (t.pane === elements.paneTranscript && state.transcriptParagraphs.length > 0) {
        highlightTranscriptPlayback(elements.mainAudio.currentTime);
      }
    });
  });
}



function markSummaryAttention(isActive) {
  elements.tabSummary.classList.toggle('has-attention', isActive);
}
