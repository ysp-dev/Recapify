/* ==========================================================================
   Summary Workspace
   ========================================================================== */

function setupPromptHistory() {
  try {
    state.summaryPromptHistory = JSON.parse(localStorage.getItem(SUMMARY_PROMPT_HISTORY_KEY) || '[]');
  } catch (err) {
    state.summaryPromptHistory = [];
  }
  renderSummaryPromptHistory();

  elements.summaryPromptHistory.addEventListener('change', function (e) {
    if (!e.target.value) return;
    elements.inputSummaryPrompt.value = e.target.value;
    state.summaryPrompt = e.target.value;
    clearSummaryCache();
    showToast('최근 프롬프트를 불러왔습니다.');
  });
}



function rememberSummaryPrompt(prompt) {
  var clean = (prompt || '').trim();
  if (!clean) return;

  state.summaryPromptHistory = [clean].concat(state.summaryPromptHistory.filter(function (item) {
    return item !== clean;
  })).slice(0, MAX_SUMMARY_PROMPT_HISTORY);

  localStorage.setItem(SUMMARY_PROMPT_HISTORY_KEY, JSON.stringify(state.summaryPromptHistory));
  renderSummaryPromptHistory();
}



function renderSummaryPromptHistory() {
  elements.summaryPromptHistory.innerHTML = '';
  var placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '최근 프롬프트';
  elements.summaryPromptHistory.appendChild(placeholder);

  state.summaryPromptHistory.forEach(function (prompt) {
    var option = document.createElement('option');
    option.value = prompt;
    option.textContent = prompt.length > 28 ? prompt.slice(0, 28) + '...' : prompt;
    elements.summaryPromptHistory.appendChild(option);
  });
}



function clearSummaryCache() {
  state.summaries = { summary: '', notes: '' };
  state.summaryRequests = {};
  state.summaryPromptDirty = false;
}



function setupSummaryActions() {
  elements.summaryFormatButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      elements.summaryFormatButtons.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.activeSummaryFormat = btn.getAttribute('data-format');
      if (state.summaries[state.activeSummaryFormat]) {
        renderSummaryMarkdown(state.summaries[state.activeSummaryFormat]);
      } else if (!state.summaryPrompt || !state.summaryPrompt.trim()) {
        renderSummaryPromptRequiredState();
      } else {
        renderSummaryReadyState();
      }
    });
  });

  elements.btnRunSummary.addEventListener('click', function () {
    runActiveSummary();
  });
}



function runActiveSummary() {
  if (state.transcriptParagraphs.length === 0) {
    showToast('먼저 전사록을 준비해 주세요.');
    return;
  }
  if (!state.summaryPrompt || !state.summaryPrompt.trim()) {
    renderSummaryPromptRequiredState();
    showToast('AI 정리 프롬프트를 먼저 입력해 주세요.');
    elements.inputSummaryPrompt.focus();
    return;
  }
  var apiKey = selectedTextApiKey();
  if (!apiKey) {
    showToast(selectedTextProviderName() + '를 입력해주세요.');
    return;
  }
  if (state.summaryPromptDirty) {
    clearTimeout(summaryPromptCacheTimer);
    clearSummaryCache();
  }
  rememberSummaryPrompt(state.summaryPrompt);
  triggerSummaryFormatLoad(state.activeSummaryFormat || 'summary');
}



async function triggerSummaryFormatLoad(format) {
  state.activeSummaryFormat = format;
  if (state.transcriptParagraphs.length === 0) return;
  if (!state.summaryPrompt || !state.summaryPrompt.trim()) {
    renderSummaryPromptRequiredState();
    return;
  }

  if (state.summaries[format]) {
    renderSummaryMarkdown(state.summaries[format]);
    return;
  }

  if (state.summaryRequests[format]) {
    elements.summaryContent.innerHTML = '<div style="padding:32px 0;text-align:center;color:var(--text-muted);">이미 생성 중입니다. 잠시만 기다려 주세요...</div>';
    try {
      var pendingSummary = await state.summaryRequests[format];
      if (state.activeSummaryFormat === format) renderSummaryMarkdown(pendingSummary);
    } catch (err) {
      if (state.activeSummaryFormat === format) {
        renderSummaryError(err.message);
      }
    }
    return;
  }

  var apiKey = selectedTextApiKey();
  if (!apiKey) {
    showToast(selectedTextProviderName() + '를 입력해주세요.');
    return;
  }

  renderSummaryLoadingState();
  elements.btnCopySummary.disabled = true;
  elements.btnDownloadSummary.disabled = true;
  setSummaryBadgeRunning(true);

  try {
    var streamedText = '';
    state.summaryRequests[format] = generateSummary(state.transcriptText, format, apiKey, state.model, state.summaryPrompt, function (delta, fullText) {
      streamedText = fullText || (streamedText + delta);
      if (state.activeSummaryFormat === format) {
        renderSummaryMarkdown(streamedText, { streaming: true });
      }
    });
    var summaryText = await state.summaryRequests[format];
    state.summaries[format] = summaryText;
    if (state.activeSummaryFormat === format) renderSummaryMarkdown(summaryText);
  } catch (err) {
    console.error('Summary generation failed:', err);
    if (state.activeSummaryFormat === format) {
      renderSummaryError(err.message);
    }
  } finally {
    delete state.summaryRequests[format];
    setSummaryBadgeRunning(false);
  }
}



function renderSummaryMarkdown(markdown, options) {
  if (window.marked) {
    elements.summaryContent.innerHTML = window.marked.parse(escapeHTML(markdown));
  } else {
    elements.summaryContent.textContent = markdown;
  }
  var isStreaming = options && options.streaming;
  elements.btnCopySummary.disabled = !!isStreaming;
  elements.btnDownloadSummary.disabled = !!isStreaming;
}



function renderSummaryLoadingState() {
  elements.summaryContent.innerHTML = '';
  var wrapper = document.createElement('div');
  wrapper.className = 'loading-stack summary-loading-stack';
  wrapper.appendChild(createSkeletonBlock('skeleton-heading'));
  wrapper.appendChild(createSkeletonBlock('skeleton-line wide'));
  wrapper.appendChild(createSkeletonBlock('skeleton-line full'));
  elements.summaryContent.appendChild(wrapper);
}



function renderSummaryError(message) {
  elements.summaryContent.innerHTML = '';
  var errorText = document.createElement('p');
  errorText.className = 'summary-error-message';
  errorText.textContent = '요약 생성 실패: ' + message;
  elements.summaryContent.appendChild(errorText);
}



function renderSummaryPromptRequiredState() {
  elements.summaryContent.innerHTML = '<div class="empty-state"><i data-lucide="message-square-warning" class="empty-icon text-accent"></i><h3>AI 정리 프롬프트가 필요합니다</h3><p>위 입력칸에 정리 방식이나 강조할 관점을 입력한 뒤 다시 실행해 주세요.</p></div>';
  elements.btnCopySummary.disabled = true;
  elements.btnDownloadSummary.disabled = true;
  if (window.lucide) window.lucide.createIcons();
}



function renderSummaryReadyState() {
  elements.summaryContent.innerHTML = '<div class="empty-state"><i data-lucide="play-circle" class="empty-icon text-accent"></i><h3>AI 정리 대기 중</h3><p>프롬프트와 정리 형식을 확인한 뒤 실행을 눌러 주세요.</p></div>';
  elements.btnCopySummary.disabled = true;
  elements.btnDownloadSummary.disabled = true;
  if (window.lucide) window.lucide.createIcons();
}



function setSummaryBadgeRunning(isRunning) {
  elements.summaryBadge.classList.toggle('running', isRunning);
  elements.summaryBadge.textContent = isRunning ? 'AI 분석 중...' : 'AI 분석';
}
