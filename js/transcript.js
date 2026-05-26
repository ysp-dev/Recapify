/* ==========================================================================
   Transcript Workspace
   ========================================================================== */

function renderTranscriptLoadingState() {
  elements.transcriptContainer.innerHTML = '';
  var wrapper = document.createElement('div');
  wrapper.className = 'loading-stack transcript-loading-stack';

  for (var i = 0; i < 4; i++) {
    var card = document.createElement('div');
    card.className = 'transcript-card transcript-skeleton-card';

    var metaRow = document.createElement('div');
    metaRow.className = 'skeleton-row';
    metaRow.appendChild(createSkeletonBlock('skeleton-time'));
    metaRow.appendChild(createSkeletonBlock('skeleton-meta'));

    card.appendChild(metaRow);
    card.appendChild(createSkeletonBlock('skeleton-line full'));
    card.appendChild(createSkeletonBlock('skeleton-line short'));
    wrapper.appendChild(card);
  }

  elements.transcriptContainer.appendChild(wrapper);
}



function parseWhisperSegments(segments) {
  if (!segments || segments.length === 0) return [];
  return segments.map(function (seg, idx) {
    var hasTime = seg.start != null;
    var start = hasTime ? seg.start : 0;
    var m = Math.floor(start / 60);
    var s = Math.floor(start % 60);
    return {
      id: idx,
      time: hasTime ? String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') : null,
      seconds: hasTime ? Math.floor(start) : -1,
      text: (seg.text || '').trim()
    };
  }).filter(function (p) { return p.text.length > 0; });
}



function buildTranscriptText(paragraphs) {
  return paragraphs.map(function (p) {
    return (p.time ? '[' + p.time + '] ' : '') + p.text;
  }).join('\n');
}



function parseImportedTranscript(rawText) {
  var text = (rawText || '').trim();
  if (!text) return [];

  var jsonSegments = parseImportedTranscriptJson(text);
  if (jsonSegments) return jsonSegments;

  text = text
    .replace(/\r\n/g, '\n')
    .replace(/WEBVTT[^\n]*\n/gi, '')
    .replace(/^\s*\d+\s*$/gm, '')
    .replace(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3}).*/g, '[$1]');

  var lines = text.split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
  if (lines.length === 1) {
    lines = lines[0].match(/[^.!?。！？\n]+[.!?。！？\n]*/g) || lines;
  }

  return lines.map(function (line, idx) {
    var parsed = parseImportedTranscriptLine(line);
    return {
      id: idx,
      time: parsed.time,
      seconds: parsed.seconds,
      text: parsed.text
    };
  }).filter(function (p) { return p.text.length > 0; });
}



function parseImportedTranscriptJson(text) {
  try {
    var data = JSON.parse(text);
    if (Array.isArray(data)) {
      return parseWhisperSegments(data.map(function (item) {
        return { start: item.start || item.seconds || null, text: item.text || item.content || '' };
      }));
    }
    if (Array.isArray(data.segments)) return parseWhisperSegments(data.segments);
    if (typeof data.text === 'string') return parseImportedTranscript(data.text);
  } catch (err) {
    return null;
  }
  return null;
}



function parseImportedTranscriptLine(line) {
  var time = null;
  var seconds = -1;
  var text = line;
  var match = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[,.]\d{1,3})?)\]?\s*[-–—:]?\s*(.*)$/);
  if (match) {
    seconds = timestampToSeconds(match[1]);
    time = formatTimestamp(seconds);
    text = match[2].trim();
  }
  return { time: time, seconds: seconds, text: text };
}



function timestampToSeconds(value) {
  var clean = String(value).replace(',', '.');
  var parts = clean.split(':').map(function (part) { return parseFloat(part); });
  if (parts.length === 2) return Math.floor(parts[0] * 60 + parts[1]);
  if (parts.length === 3) return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  return -1;
}



function formatTimestamp(seconds) {
  if (seconds < 0) return null;
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  if (h > 0) {
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}



function createTranscriptCard(p, query) {
  var card = document.createElement('div');
  card.className = 'transcript-card';
  card.id = 'transcript-card-' + p.id;
  card.setAttribute('data-seconds', p.seconds);
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', p.time ? p.time + ' 전사 위치로 이동' : '전사 단락');

  var actions = document.createElement('div');
  actions.className = 'transcript-card-actions';

  var ttsButton = document.createElement('button');
  ttsButton.type = 'button';
  ttsButton.className = 'segment-copy-btn';
  ttsButton.setAttribute('aria-label', '이 세그먼트부터 읽기');
  ttsButton.innerHTML = '<i data-lucide="volume-2"></i>';
  (function (seg) {
    ttsButton.addEventListener('click', function (e) {
      e.stopPropagation();
      startTtsRead(state.transcriptParagraphs.indexOf(seg));
    });
  }(p));
  actions.appendChild(ttsButton);

  var copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'segment-copy-btn';
  copyButton.setAttribute('aria-label', '이 세그먼트 복사');
  copyButton.innerHTML = '<i data-lucide="copy"></i>';
  copyButton.addEventListener('click', function (e) {
    e.stopPropagation();
    copyTextToClipboard(formatTranscriptSegment(p), '세그먼트를 복사했습니다.');
  });
  actions.appendChild(copyButton);
  card.appendChild(actions);

  if (p.time) {
    var metadata = document.createElement('div');
    metadata.className = 'card-metadata';
    var timestamp = document.createElement('span');
    timestamp.className = 'timestamp-badge';
    timestamp.textContent = p.time;
    metadata.appendChild(timestamp);
    card.appendChild(metadata);
  }

  var speechText = document.createElement('div');
  speechText.className = 'speech-text';
  speechText.setAttribute('contenteditable', query ? 'false' : 'true');
  speechText.setAttribute('role', 'textbox');
  speechText.setAttribute('aria-label', '전사 텍스트 편집');
  speechText.setAttribute('spellcheck', 'true');
  appendHighlightedText(speechText, p.text, query);
  card.appendChild(speechText);

  speechText.addEventListener('click', function (e) { e.stopPropagation(); });
  speechText.addEventListener('keydown', function (e) { e.stopPropagation(); });
  speechText.addEventListener('blur', function () {
    if (query) return;
    updateTranscriptSegmentText(p.id, speechText.textContent);
  });

  card.addEventListener('click', function (e) {
    if (e.target.closest('.transcript-card-actions') || e.target.closest('.speech-text')) return;
    seekAudioToSeconds(p.seconds);
  });
  card.addEventListener('keydown', function (e) {
    if (e.target.closest('.speech-text')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      seekAudioToSeconds(p.seconds);
    }
  });

  return card;
}



function appendTranscriptCards(paragraphs) {
  if (!paragraphs.length) return;
  var frag = document.createDocumentFragment();
  paragraphs.forEach(function (p) {
    frag.appendChild(createTranscriptCard(p, ''));
  });
  elements.transcriptContainer.appendChild(frag);
  if (window.lucide) window.lucide.createIcons();
}



function renderTranscriptTimeline(filterWord) {
  filterWord = filterWord || '';
  elements.transcriptContainer.innerHTML = '';
  var query = filterWord.toLowerCase().trim();
  var filtered = state.transcriptParagraphs.filter(function (p) {
    return p.text.toLowerCase().includes(query);
  });

  if (filtered.length === 0) {
    renderTranscriptEmptySearchState(filterWord);
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  var frag = document.createDocumentFragment();
  filtered.forEach(function (p) {
    frag.appendChild(createTranscriptCard(p, query));
  });
  elements.transcriptContainer.appendChild(frag);
  if (window.lucide) window.lucide.createIcons();
}



function updateTranscriptSegmentText(id, text) {
  var cleanText = String(text || '').trim();
  var target = state.transcriptParagraphs.find(function (item) { return item.id === id; });
  if (!target || !cleanText || target.text === cleanText) return;

  target.text = cleanText;
  state.transcriptText = buildTranscriptText(state.transcriptParagraphs);
  state.chaptersMarkdown = '';
  elements.chaptersContainer.innerHTML = '';
  elements.chaptersContainer.classList.add('hidden');
  clearSummaryCache();
  saveTranscriptCache();
  showToast('전사 세그먼트를 수정했습니다.');
}



function formatTranscriptSegment(segment) {
  return (segment.time ? '[' + segment.time + '] ' : '') + segment.text;
}



function saveTranscriptCache() {
  if (!state.transcriptParagraphs.length) return;
  try {
    localStorage.setItem(TRANSCRIPT_CACHE_KEY, JSON.stringify({
      sourceName: state.transcriptSourceName || 'transcript',
      transcriptText: state.transcriptText,
      transcriptParagraphs: state.transcriptParagraphs,
      chaptersMarkdown: state.chaptersMarkdown || '',
      savedAt: new Date().toISOString()
    }));
  } catch (err) {
    console.warn('Transcript cache save failed:', err);
  }
}



function restoreCachedTranscript() {
  if (state.currentFile) return;
  try {
    var cached = JSON.parse(localStorage.getItem(TRANSCRIPT_CACHE_KEY) || 'null');
    if (!cached || !Array.isArray(cached.transcriptParagraphs) || !cached.transcriptParagraphs.length) return;

    state.transcriptSourceName = cached.sourceName || 'transcript';
    state.transcriptParagraphs = cached.transcriptParagraphs.map(function (p, idx) {
      return {
        id: idx,
        time: p.time || null,
        seconds: typeof p.seconds === 'number' ? p.seconds : -1,
        text: p.text || ''
      };
    }).filter(function (p) { return p.text.trim().length > 0; });
    state.transcriptText = cached.transcriptText || buildTranscriptText(state.transcriptParagraphs);
    state.chaptersMarkdown = cached.chaptersMarkdown || '';

    renderTranscriptTimeline();
    enableTranscriptWorkspace();
    renderSummaryReadyState();
    if (state.chaptersMarkdown) renderChapters(state.chaptersMarkdown);
    showToast('이전 전사록을 복원했습니다.');
  } catch (err) {
    console.warn('Transcript cache restore failed:', err);
  }
}



function clearTranscriptCache() {
  localStorage.removeItem(TRANSCRIPT_CACHE_KEY);
}



function renderTranscriptEmptySearchState(filterWord) {
  var empty = document.createElement('div');
  empty.className = 'empty-state';

  var icon = document.createElement('i');
  icon.setAttribute('data-lucide', 'alert-circle');
  icon.className = 'empty-icon';

  var title = document.createElement('h3');
  title.textContent = '검색 결과가 없습니다';

  var message = document.createElement('p');
  message.textContent = '"' + filterWord + '" 단어를 포함하는 발언 단락을 찾을 수 없습니다.';

  empty.appendChild(icon);
  empty.appendChild(title);
  empty.appendChild(message);
  elements.transcriptContainer.appendChild(empty);
}



function appendHighlightedText(container, text, query) {
  if (!query) {
    container.textContent = text;
    return;
  }

  var regex = new RegExp(escapeRegExp(query), 'gi');
  var lastIndex = 0;
  var match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    var highlight = document.createElement('span');
    highlight.className = 'search-highlight';
    highlight.textContent = match[0];
    container.appendChild(highlight);
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}



function seekAudioToSeconds(seconds) {
  if (seconds < 0) return;
  if (!elements.mainAudio.src) return;
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  elements.mainAudio.currentTime = seconds;
  if (elements.mainAudio.paused) startAudioPlayback();
}



function highlightTranscriptPlayback(elapsed) {
  if (state.transcriptParagraphs.length === 0) return;
  var activeSegment = state.transcriptParagraphs[0];
  for (var i = 0; i < state.transcriptParagraphs.length; i++) {
    if (state.transcriptParagraphs[i].seconds <= elapsed) activeSegment = state.transcriptParagraphs[i];
    else break;
  }

  // 세그먼트가 바뀌지 않으면 스킵 — timeupdate가 초당 여러 번 호출되므로 불필요한 스크롤 방지
  if (activeSegment.id === state.lastPlaybackSegmentId) return;
  state.lastPlaybackSegmentId = activeSegment.id;

  document.querySelectorAll('.transcript-card').forEach(function (el) { el.classList.remove('active-playback'); });
  var activeCard = document.getElementById('transcript-card-' + activeSegment.id);
  if (activeCard) {
    activeCard.classList.add('active-playback');
    // 'center'는 iOS에서 위/아래 방향 모두 안정적으로 스크롤됨 ('nearest'는 iOS에서 위쪽 스크롤 버그 있음)
    activeCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}



function ttsLangCode() {
  var lang = state.language || 'ko';
  if (lang === 'ko') return 'ko-KR';
  if (lang === 'en') return 'en-US';
  if (lang === 'ja') return 'ja-JP';
  return 'ko-KR';
}



function startTtsRead(fromIndex) {
  if (!window.speechSynthesis) {
    showToast('이 브라우저는 음성 읽기를 지원하지 않습니다.');
    return;
  }
  stopTtsRead();

  var segments = state.transcriptParagraphs;
  if (!segments.length) return;

  tts.speaking = true;
  tts.segmentIndex = (typeof fromIndex === 'number' && fromIndex >= 0) ? fromIndex : 0;
  updateTtsButton(true);
  ttsSpeak();
}



function ttsSpeak() {
  if (!tts.speaking) return;
  var segments = state.transcriptParagraphs;
  if (tts.segmentIndex >= segments.length) {
    stopTtsRead();
    return;
  }

  var seg = segments[tts.segmentIndex];
  highlightTtsSegment(seg.id);

  var utt = new SpeechSynthesisUtterance(seg.text);
  utt.lang = ttsLangCode();
  utt.rate = 1.0;
  tts.utterance = utt;

  utt.onend = function () {
    if (!tts.speaking) return;
    tts.segmentIndex++;
    ttsSpeak();
  };
  utt.onerror = function (e) {
    if (e.error === 'interrupted' || e.error === 'canceled') return;
    stopTtsRead();
    showToast('음성 읽기 오류: ' + e.error);
  };

  // iOS workaround: resume before each utterance to prevent silent cut-off
  if (window.speechSynthesis && window.speechSynthesis.paused) window.speechSynthesis.resume();
  window.speechSynthesis.speak(utt);
}



function stopTtsRead() {
  tts.speaking = false;
  tts.utterance = null;
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  clearTtsHighlight();
  updateTtsButton(false);
}



function highlightTtsSegment(segId) {
  document.querySelectorAll('.transcript-card.tts-reading').forEach(function (el) {
    el.classList.remove('tts-reading');
  });
  var card = document.getElementById('transcript-card-' + segId);
  if (card) {
    card.classList.add('tts-reading');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}



function clearTtsHighlight() {
  document.querySelectorAll('.transcript-card.tts-reading').forEach(function (el) {
    el.classList.remove('tts-reading');
  });
}



function updateTtsButton(isReading) {
  if (!elements.btnTtsRead) return;
  if (isReading) {
    elements.btnTtsRead.classList.add('tts-active');
    elements.btnTtsRead.innerHTML = '<i data-lucide="volume-x"></i> 중지';
    elements.btnTtsRead.setAttribute('aria-label', '읽기 중지');
  } else {
    elements.btnTtsRead.classList.remove('tts-active');
    elements.btnTtsRead.innerHTML = '<i data-lucide="volume-2"></i> 읽기';
    elements.btnTtsRead.setAttribute('aria-label', '전사록 읽어주기');
  }
  if (window.lucide) window.lucide.createIcons();
}



function setupTranscriptActions() {
  if (elements.btnTtsRead) {
    elements.btnTtsRead.addEventListener('click', function () {
      if (tts.speaking) stopTtsRead();
      else startTtsRead(0);
    });
  }

  elements.transcriptFileInput.addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (file) importTranscriptFile(file);
  });

  elements.btnGenerateChapters.addEventListener('click', function () {
    triggerGenerateChapters();
  });

  elements.transcriptSearch.addEventListener('input', function (e) {
    renderTranscriptTimeline(e.target.value);
  });

  elements.btnCopyTranscript.addEventListener('click', function () {
    copyTextToClipboard(state.transcriptText, '전사록이 클립보드에 복사되었습니다.');
  });

  elements.btnDownloadTranscript.addEventListener('click', function () {
    downloadTextFile(getTranscriptDownloadName(), state.transcriptText);
  });

  elements.btnResetTranscript.addEventListener('click', function () {
    if (!confirm('전사록과 요약 결과가 모두 삭제됩니다.\n계속하시겠습니까?')) return;
    resetWorkspaceData();
    clearTranscriptCache();
    showToast('전사록이 초기화되었습니다.');
  });

  elements.btnCopySummary.addEventListener('click', function () {
    copyTextToClipboard(state.summaries[state.activeSummaryFormat], '요약 리포트가 클립보드에 복사되었습니다.');
  });

  elements.btnDownloadSummary.addEventListener('click', function () {
    var sourceName = state.transcriptSourceName || (state.currentFile && state.currentFile.name) || 'transcript';
    downloadTextFile(sourceName.replace(/\.[^.]+$/, '') + '_summary_' + state.activeSummaryFormat + '.md', state.summaries[state.activeSummaryFormat]);
  });
}



function importTranscriptFile(file) {
  var reader = new FileReader();
  reader.onload = function () {
    try {
      var paragraphs = parseImportedTranscript(String(reader.result || ''));
      if (!paragraphs.length) {
        throw new Error('읽을 수 있는 전사 텍스트가 없습니다.');
      }

      resetWorkspaceData();
      state.transcriptSourceName = file.name;
      state.transcriptParagraphs = paragraphs.map(function (p, idx) {
        return {
          id: idx,
          time: p.time,
          seconds: typeof p.seconds === 'number' ? p.seconds : -1,
          text: p.text
        };
      });
      state.transcriptText = buildTranscriptText(state.transcriptParagraphs);

      renderTranscriptTimeline();
      enableTranscriptWorkspace();
      saveTranscriptCache();
      showToast('전사록을 가져왔습니다.');
    } catch (err) {
      showToast('전사록 가져오기 실패: ' + err.message);
    } finally {
      elements.transcriptFileInput.value = '';
    }
  };
  reader.onerror = function () {
    showToast('전사록 파일을 읽지 못했습니다.');
    elements.transcriptFileInput.value = '';
  };
  reader.readAsText(file);
}



function enableTranscriptWorkspace() {
  elements.transcriptSearch.disabled = false;
  if (elements.btnTtsRead) elements.btnTtsRead.disabled = false;
  elements.btnGenerateChapters.disabled = false;
  elements.btnCopyTranscript.disabled = false;
  elements.btnDownloadTranscript.disabled = false;
  elements.btnResetTranscript.disabled = false;
  elements.chatInput.disabled = false;
  elements.btnSendChat.disabled = false;
}



async function triggerGenerateChapters() {
  if (state.transcriptParagraphs.length === 0) {
    showToast('먼저 전사록을 준비해 주세요.');
    return;
  }
  if (!state.apiKey) {
    showToast('OpenAI API Key를 입력해주세요.');
    return;
  }

  elements.btnGenerateChapters.disabled = true;
  renderChaptersLoadingState();
  try {
    state.chaptersMarkdown = await generateChapters(state.transcriptText, state.apiKey, state.model);
    renderChapters(state.chaptersMarkdown);
    saveTranscriptCache();
  } catch (err) {
    console.error('Chapter generation failed:', err);
    renderChaptersError(err.message);
  } finally {
    elements.btnGenerateChapters.disabled = false;
  }
}



function renderChapters(markdown) {
  elements.chaptersContainer.innerHTML = '';
  elements.chaptersContainer.classList.remove('hidden');

  var title = document.createElement('div');
  title.className = 'chapters-title';
  title.textContent = '챕터';

  var body = document.createElement('div');
  body.className = 'chapters-body';
  if (window.marked) {
    body.innerHTML = window.marked.parse(escapeHTML(markdown));
  } else {
    body.textContent = markdown;
  }

  elements.chaptersContainer.appendChild(title);
  elements.chaptersContainer.appendChild(body);
}



function renderChaptersLoadingState() {
  elements.chaptersContainer.innerHTML = '';
  elements.chaptersContainer.classList.remove('hidden');
  var title = document.createElement('div');
  title.className = 'chapters-title';
  title.textContent = '챕터 생성 중...';
  var loader = document.createElement('div');
  loader.className = 'loading-stack chapters-loading-stack';
  loader.appendChild(createSkeletonBlock('skeleton-line wide'));
  loader.appendChild(createSkeletonBlock('skeleton-line full'));
  elements.chaptersContainer.appendChild(title);
  elements.chaptersContainer.appendChild(loader);
}



function renderChaptersError(message) {
  elements.chaptersContainer.innerHTML = '';
  elements.chaptersContainer.classList.remove('hidden');
  var error = document.createElement('div');
  error.className = 'chapters-error';
  error.textContent = '챕터 생성 실패: ' + message;
  elements.chaptersContainer.appendChild(error);
}



function getTranscriptDownloadName() {
  var sourceName = state.transcriptSourceName || (state.currentFile && state.currentFile.name) || 'transcript';
  return sourceName.replace(/\.[^.]+$/, '') + '_transcript.txt';
}


