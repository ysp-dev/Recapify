/* ==========================================================================
   AetherScribe - Main Application Script
   OpenAI GPT-4o-transcribe + GPT-4.1 | file:// compatible (no ES modules)
   ========================================================================== */

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const MAX_DIRECT_UPLOAD_BYTES = 24 * 1024 * 1024;
const MAX_DIRECT_TRANSCRIBE_DURATION_SEC = 1350; // 모델 1400초 제한에 여유를 둔 직접 전송 한도
const CHUNK_DURATION_SEC = 600;                  // 10분 단위 청크 (16kHz mono WAV 기준 ~18MB)
const WHISPER_SAMPLE_RATE = 16000;               // 다운샘플 목표 (25MB 제한 내 최대 청크 확보)
const MAX_OPENAI_REQUEST_RETRIES = 3;

const SUMMARY_MAX_TOKENS = {
  summary: 2000,
  minutes: 2200,
  notes: 2200,
  qa: 1800,
  email: 1600
};

const SUMMARY_SYSTEM_PROMPTS = {
  summary: `당신은 전문 AI 요약 분석가입니다. 주어진 오디오 전사록을 심층 분석하여 마크다운 형식으로 정리하세요.

반드시 다음 구조를 사용하세요:
## 핵심 요약
- 3~5개의 핵심 내용을 불릿 포인트로

## 주요 논점
각 논점을 소제목으로 구분하여 설명

## 중요 인사이트
> 블록인용 형식으로 1~2개의 핵심 인사이트

## 결론
간결한 결론 1~2문장`,

  minutes: `당신은 전문 회의록 작성 전문가입니다. 주어진 전사록을 공식 회의록 형식으로 정리하세요.

반드시 다음 구조를 사용하세요:
## 회의 개요
표 형식으로 (참석자, 주요 안건 등)

## 안건별 논의 내용
각 안건을 ### 소제목으로 구분

## Action Items
| 담당자 | Action Item | 마감일 | 상태 |
표 형식으로

## 다음 회의 사항`,

  notes: `당신은 체계적인 노트 작성 전문가입니다. 주어진 전사록을 구조화된 학습 노트 형식으로 정리하세요.

반드시 다음 구조를 사용하세요:
## 핵심 개념 정리
주요 개념을 소제목으로

## 주제별 구조화 (마인드맵)
\`\`\`
계층적 트리 구조로 표현
\`\`\`

## 핵심 키워드 & 연관 개념
키워드 → 설명 형식

## 상세 메모`,

  qa: `당신은 전문 콘텐츠 분석가입니다. 주어진 전사록에서 핵심 Q&A를 추출하거나 생성하세요.

반드시 다음 구조를 사용하세요:
## 주요 Q&A (5~8개)
각 Q&A를 ---로 구분, **Q1.** 질문, > 답변 형식

## 핵심 FAQ 표
| 질문 | 답변 |
표 형식

## 핵심 논쟁점 또는 미결 사항`,

  email: `당신은 전문 비즈니스 커뮤니케이션 전문가입니다. 전사록 내용을 바탕으로 이메일 보고서 초안을 작성하세요.

반드시 다음 구조를 사용하세요:
**Subject**: [제목]
**To**: [수신인]

인사말

## 회의/대화 요약
핵심 내용 불릿 포인트

## 주요 결정 사항
번호 목록

## 요청 사항 / 다음 단계
번호 목록

맺음말 및 서명`
};

/* ==========================================================================
   OpenAI API Functions
   ========================================================================== */

async function transcribeAudio(audioFile, language, promptHint, apiKey, transcribeModel) {
  var model = transcribeModel || 'gpt-4o-transcribe';
  var isLegacy = (model === 'whisper-1');

  var formData = new FormData();
  formData.append('file', audioFile, audioFile.name);
  formData.append('model', model);
  // whisper-1만 verbose_json + segment timestamps 지원
  formData.append('response_format', isLegacy ? 'verbose_json' : 'json');
  if (isLegacy) {
    formData.append('timestamp_granularities[]', 'segment');
  } else {
    formData.append('chunking_strategy', 'auto');
  }

  if (language && language !== 'auto') {
    formData.append('language', language);
  }
  if (promptHint && promptHint.trim()) {
    formData.append('prompt', promptHint.trim());
  }

  var response = await fetch(OPENAI_API_BASE + '/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey },
    body: formData
  });

  if (!response.ok) {
    var err = await response.json().catch(function () { return {}; });
    throw new Error(err.error ? err.error.message : ('전사 API 오류: ' + response.status));
  }

  var data = await response.json();

  if (isLegacy) {
    return data; // { text, segments: [{start, end, text}] }
  }

  // gpt-4o-transcribe: json 응답에는 segments 없음 → 문장 단위로 분할
  var text = data.text || '';
  var parts = text.match(/[^.!?。\n]+[.!?。\n]*/g) || (text ? [text] : []);
  return {
    text: text,
    segments: parts.map(function (p) {
      return { start: null, text: p.trim() };
    }).filter(function (s) { return s.text.length > 0; })
  };
}

async function transcribeAudioWithChunking(audioFile, language, promptHint, apiKey, transcribeModel) {
  var knownDuration = getLoadedAudioDurationSec();
  var fitsDirectSize = audioFile.size <= MAX_DIRECT_UPLOAD_BYTES;
  var supportsServerChunking = transcribeModelSupportsServerChunking(transcribeModel);
  var serverChunkingDurationFallback = false;

  if (fitsDirectSize && supportsServerChunking) {
    try {
      return await transcribeAudio(audioFile, language, promptHint, apiKey, transcribeModel);
    } catch (err) {
      if (!isTranscriptionDurationLimitError(err)) throw err;
      serverChunkingDurationFallback = true;
      showToast('서버 청크 처리 한도를 넘어 클라이언트 청크로 재시도합니다.');
    }
  }

  // 파일 크기와 재생 시간이 모두 안전할 때만 직접 전송한다.
  if (!serverChunkingDurationFallback && fitsDirectSize && (knownDuration === null || knownDuration <= MAX_DIRECT_TRANSCRIBE_DURATION_SEC)) {
    return transcribeAudio(audioFile, language, promptHint, apiKey, transcribeModel);
  }

  if (!fitsDirectSize) {
    showToast('파일이 커서 청크 분할 모드로 처리합니다.');
  } else if (knownDuration !== null && knownDuration > MAX_DIRECT_TRANSCRIBE_DURATION_SEC) {
    showToast('오디오가 길어서 청크 분할 모드로 처리합니다.');
  } else {
    showToast('오디오 길이를 확인합니다.');
  }

  // 1. ArrayBuffer로 읽기
  setPlayerBadgeState('transcribing', '오디오 길이 확인 중...');
  showTranscribeProgress('오디오 길이 확인 중...', null);
  var arrayBuffer = await audioFile.arrayBuffer();

  // 2. AudioContext로 디코딩
  var tempCtx = new (window.AudioContext || window.webkitAudioContext)();
  var audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
  await tempCtx.close();

  if (fitsDirectSize && audioBuffer.duration <= MAX_DIRECT_TRANSCRIBE_DURATION_SEC) {
    showTranscribeProgress('전사 중...', null);
    return transcribeAudio(audioFile, language, promptHint, apiKey, transcribeModel);
  }

  // 3. OfflineAudioContext로 16kHz mono 리샘플링
  setPlayerBadgeState('transcribing', '오디오 처리 중...');
  showTranscribeProgress('오디오 청크 준비 중...', null);
  var resampledBuffer = await resampleToMono16k(audioBuffer);

  // 4. 청크 수 계산 및 순차 전사
  var totalDuration = resampledBuffer.duration;
  var totalChunks = Math.ceil(totalDuration / CHUNK_DURATION_SEC);
  var allSegments = [];
  var contextPrompt = promptHint || '';

  for (var i = 0; i < totalChunks; i++) {
    var startSec = i * CHUNK_DURATION_SEC;
    var endSec = Math.min((i + 1) * CHUNK_DURATION_SEC, totalDuration);
    var offsetSec = startSec;

    var chunkPct = Math.round((i / totalChunks) * 100);
    setPlayerBadgeState('transcribing', '청크 ' + (i + 1) + '/' + totalChunks + ' 전사 중...');
    showTranscribeProgress('청크 ' + (i + 1) + ' / ' + totalChunks + ' 전사 중...', chunkPct);

    var wavBlob = extractChunkAsWav(resampledBuffer, startSec, endSec);
    var wavFile = new File([wavBlob], 'chunk_' + i + '.wav', { type: 'audio/wav' });

    var result = await transcribeAudio(wavFile, language, contextPrompt, apiKey, transcribeModel);

    // 타임스탬프에 청크 오프셋 적용
    var segments = (result.segments || []).map(function (seg) {
      return Object.assign({}, seg, {
        start: (seg.start || 0) + offsetSec,
        end: (seg.end || seg.start || 0) + offsetSec
      });
    });
    allSegments = allSegments.concat(segments);

    // 다음 청크의 프롬프트로 직전 전사 마지막 부분 사용 (문맥 연속성)
    if (result.text) {
      var words = result.text.trim().split(' ');
      contextPrompt = words.slice(-30).join(' ');
    }
  }

  return { segments: allSegments };
}

async function resampleToMono16k(audioBuffer) {
  var targetLength = Math.ceil(audioBuffer.duration * WHISPER_SAMPLE_RATE);
  var offlineCtx = new OfflineAudioContext(1, targetLength, WHISPER_SAMPLE_RATE);
  var source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);
  return await offlineCtx.startRendering();
}

function extractChunkAsWav(audioBuffer, startSec, endSec) {
  var sampleRate = audioBuffer.sampleRate;
  var startSample = Math.floor(startSec * sampleRate);
  var endSample = Math.min(Math.floor(endSec * sampleRate), audioBuffer.length);
  var samples = audioBuffer.getChannelData(0).subarray(startSample, endSample);
  return float32ToWav(samples, sampleRate);
}

function float32ToWav(samples, sampleRate) {
  var numSamples = samples.length;
  var dataSize = numSamples * 2; // 16-bit PCM
  var buffer = new ArrayBuffer(44 + dataSize);
  var view = new DataView(buffer);

  // RIFF/WAVE 헤더
  wavWriteString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  wavWriteString(view, 8, 'WAVE');
  wavWriteString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  wavWriteString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // PCM 샘플 변환 (float32 → int16)
  var offset = 44;
  for (var i = 0; i < numSamples; i++) {
    var s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function wavWriteString(view, offset, str) {
  for (var i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

async function generateSummary(transcriptText, format, apiKey, model) {
  var systemPrompt = SUMMARY_SYSTEM_PROMPTS[format] || SUMMARY_SYSTEM_PROMPTS.summary;
  return enqueueOpenAITextRequest(async function () {
    var data = await fetchOpenAIJsonWithRetry(OPENAI_API_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '다음 오디오 전사록을 분석하여 요청한 형식으로 정리해 주세요:\n\n---\n' + transcriptText + '\n---' }
        ],
        temperature: 0.7,
        max_tokens: SUMMARY_MAX_TOKENS[format] || 2000
      })
    }, '요약 생성');

    return (data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  });
}

async function askChatAboutTranscript(transcriptText, userQuery, chatHistory, apiKey, model) {
  var messages = [{
    role: 'system',
    content: '당신은 전문 오디오 콘텐츠 어시스턴트입니다. 아래 오디오 전사록을 완전히 이해하고 있으며, 사용자의 질문에 전사록 내용을 기반으로 정확하고 친절하게 답변합니다. 전사록에 없는 내용은 추측하지 마세요.\n\n[오디오 전사록]\n---\n' + transcriptText + '\n---'
  }];

  for (var i = 0; i < chatHistory.length; i++) {
    var msg = chatHistory[i];
    messages.push({ role: msg.role === 'model' ? 'assistant' : 'user', content: msg.text });
  }
  messages.push({ role: 'user', content: userQuery });

  return enqueueOpenAITextRequest(async function () {
    var data = await fetchOpenAIJsonWithRetry(OPENAI_API_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model, messages: messages, temperature: 0.7, max_tokens: 1200 })
    }, 'Q&A 답변');

    return (data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  });
}

async function fetchOpenAIJsonWithRetry(url, options, label) {
  var requestLabel = label || 'OpenAI 요청';

  for (var attempt = 0; attempt <= MAX_OPENAI_REQUEST_RETRIES; attempt++) {
    var response = await fetch(url, options);
    var data = await response.json().catch(function () { return {}; });

    if (response.ok) {
      return data;
    }

    var message = data.error ? data.error.message : (requestLabel + ' 오류: ' + response.status);
    if (!shouldRetryOpenAIResponse(response.status, message) || attempt === MAX_OPENAI_REQUEST_RETRIES) {
      throw new Error(message);
    }

    var waitMs = getOpenAIRetryDelayMs(response, message, attempt);
    var waitSec = Math.ceil(waitMs / 1000);
    showToast(requestLabel + ' 한도 대기 중... ' + waitSec + '초 후 자동 재시도합니다.');
    await sleep(waitMs);
  }

  throw new Error(requestLabel + ' 재시도 횟수를 초과했습니다.');
}

function shouldRetryOpenAIResponse(status, message) {
  if (status === 429 || status === 500 || status === 503) return true;
  return /rate limit|try again|overloaded|slow down/i.test(message || '');
}

function getOpenAIRetryDelayMs(response, message, attempt) {
  var retryAfter = response.headers ? response.headers.get('retry-after') : null;
  var headerDelayMs = parseRetryAfterHeaderMs(retryAfter);
  if (headerDelayMs !== null) return clampRetryDelayMs(headerDelayMs + 1000);

  var msgMatch = (message || '').match(/try again in\s+([\d.]+)s/i);
  if (msgMatch) return clampRetryDelayMs((parseFloat(msgMatch[1]) * 1000) + 1000);

  return clampRetryDelayMs((Math.pow(2, attempt) * 3000) + 1000);
}

function parseRetryAfterHeaderMs(value) {
  if (!value) return null;
  var seconds = parseFloat(value);
  if (!isNaN(seconds)) return seconds * 1000;
  var dateMs = Date.parse(value);
  if (!isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function clampRetryDelayMs(ms) {
  return Math.min(Math.max(ms, 1000), 65000);
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function enqueueOpenAITextRequest(task) {
  var run = openAITextRequestQueue.then(task, task);
  openAITextRequestQueue = run.catch(function () {});
  return run;
}

/* ==========================================================================
   Application State
   ========================================================================== */

var state = {
  apiKey: '',
  model: 'gpt-4.1',
  transcribeModel: 'gpt-4o-transcribe',
  language: 'ko',
  promptHint: '',
  currentFile: null,
  transcriptText: '',
  transcriptParagraphs: [],
  summaries: { summary: '', minutes: '', notes: '', qa: '', email: '' },
  summaryRequests: {},
  activeSummaryFormat: 'summary',
  chatHistory: []
};

// Web Audio
var audioCtx = null;
var analyserNode = null;
var sourceNode = null;

// GPT summary/chat requests are queued to avoid concurrent TPM spikes.
var openAITextRequestQueue = Promise.resolve();

// DOM Elements
var elements = {
  apiKeyInput: document.getElementById('api-key'),
  apiKeyWrapper: document.getElementById('api-key-wrapper'),

  btnThemeToggle: document.getElementById('btn-theme-toggle'),
  themeToggleIcon: document.getElementById('theme-toggle-icon'),

  selectModel: document.getElementById('select-model'),
  selectTranscribeModel: document.getElementById('select-transcribe-model'),
  selectLang: document.getElementById('select-lang'),
  inputPromptHint: document.getElementById('input-prompt-hint'),

  uploadZone: document.getElementById('upload-zone'),
  fileInput: document.getElementById('file-input'),

  audioPlayerCard: document.getElementById('audio-player-card'),
  fileName: document.getElementById('file-name'),
  fileSize: document.getElementById('file-size'),
  btnRemoveFile: document.getElementById('btn-remove-file'),

  visualizer: document.getElementById('visualizer-canvas'),
  statusBadge: document.getElementById('status-badge'),
  statusText: document.getElementById('status-text'),

  mainAudio: document.getElementById('main-audio'),
  progressBar: document.getElementById('progress-bar'),
  timeElapsed: document.getElementById('time-elapsed'),
  timeTotal: document.getElementById('time-total'),

  speedSelect: document.getElementById('speed-select'),
  btnSkipBack: document.getElementById('btn-skip-back'),
  btnPlayPause: document.getElementById('btn-play-pause'),
  btnSkipForward: document.getElementById('btn-skip-forward'),
  btnMute: document.getElementById('btn-mute'),
  volumeSlider: document.getElementById('volume-slider'),

  btnTranscribe: document.getElementById('btn-transcribe'),
  transcribeProgress: document.getElementById('transcribe-progress'),
  tpLabel: document.getElementById('tp-label'),
  tpPct: document.getElementById('tp-pct'),
  tpFill: document.getElementById('tp-fill'),

  tabTranscript: document.getElementById('tab-transcript'),
  tabSummary: document.getElementById('tab-summary'),
  tabChat: document.getElementById('tab-chat'),

  paneTranscript: document.getElementById('pane-transcript'),
  paneSummary: document.getElementById('pane-summary'),
  paneChat: document.getElementById('pane-chat'),

  transcriptSearch: document.getElementById('transcript-search'),
  btnCopyTranscript: document.getElementById('btn-copy-transcript'),
  btnDownloadTranscript: document.getElementById('btn-download-transcript'),
  transcriptContainer: document.getElementById('transcript-container'),

  summaryFormatButtons: document.querySelectorAll('.summary-format-btn'),
  summaryContent: document.getElementById('summary-content'),
  btnCopySummary: document.getElementById('btn-copy-summary'),
  btnDownloadSummary: document.getElementById('btn-download-summary'),

  chatMessagesContainer: document.getElementById('chat-messages-container'),
  chatInput: document.getElementById('chat-input'),
  btnSendChat: document.getElementById('btn-send-chat'),

  toast: document.getElementById('toast'),
  toastText: document.getElementById('toast-text')
};

document.addEventListener('DOMContentLoaded', function () {
  setupApiKey();
  setupTheme();
  setupSettingsListeners();
  setupUploadZone();
  setupAudioPlayer();
  setupTabs();
  setupTranscriptActions();
  setupSummaryActions();
  setupChatActions();
  setupPromptPresets();
  startVisualizer();
  if (window.lucide) window.lucide.createIcons();
});

/* ==========================================================================
   Theme & Presets
   ========================================================================== */

function setupTheme() {
  var savedTheme = localStorage.getItem('aetherscribe_theme');
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
    localStorage.setItem('aetherscribe_theme', isLight ? 'light' : 'dark');
    elements.themeToggleIcon.setAttribute('data-lucide', isLight ? 'moon' : 'sun');
    showToast(isLight ? '라이트 모드로 전환되었습니다.' : '다크 모드로 전환되었습니다.');
    if (window.lucide) window.lucide.createIcons();
  });
}

function setupPromptPresets() {
  var presets = document.querySelectorAll('.preset-badge');
  presets.forEach(function (badge) {
    badge.addEventListener('click', function () {
      presets.forEach(function (b) { b.classList.remove('selected'); });
      badge.classList.add('selected');
      elements.inputPromptHint.value = badge.getAttribute('data-preset');
      state.promptHint = elements.inputPromptHint.value;
      showToast('전사 프롬프트가 설정되었습니다.');
    });
  });
}

/* ==========================================================================
   API Key
   ========================================================================== */

function setupApiKey() {
  var savedKey = localStorage.getItem('aetherscribe_api_key');
  if (savedKey) {
    state.apiKey = savedKey;
    elements.apiKeyInput.value = savedKey;
    elements.apiKeyWrapper.classList.add('secure');
  }

  elements.apiKeyInput.addEventListener('input', function (e) {
    var key = e.target.value.trim();
    state.apiKey = key;
    if (key) {
      localStorage.setItem('aetherscribe_api_key', key);
      elements.apiKeyWrapper.classList.add('secure');
    } else {
      localStorage.removeItem('aetherscribe_api_key');
      elements.apiKeyWrapper.classList.remove('secure');
    }
  });
}

function setupSettingsListeners() {
  state.model = elements.selectModel.value;
  state.transcribeModel = elements.selectTranscribeModel.value;
  state.language = elements.selectLang.value;
  state.promptHint = elements.inputPromptHint.value;
  elements.selectModel.addEventListener('change', function (e) { state.model = e.target.value; });
  elements.selectTranscribeModel.addEventListener('change', function (e) { state.transcribeModel = e.target.value; });
  elements.selectLang.addEventListener('change', function (e) { state.language = e.target.value; });
  elements.inputPromptHint.addEventListener('input', function (e) { state.promptHint = e.target.value; });
}

/* ==========================================================================
   Audio Upload
   ========================================================================== */

function setupUploadZone() {
  elements.uploadZone.addEventListener('click', function () {
    elements.fileInput.click();
  });

  elements.fileInput.addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (file) handleAudioImport(file);
  });

  ['dragenter', 'dragover'].forEach(function (name) {
    elements.uploadZone.addEventListener(name, function (e) {
      e.preventDefault();
      elements.uploadZone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(function (name) {
    elements.uploadZone.addEventListener(name, function (e) {
      e.preventDefault();
      elements.uploadZone.classList.remove('dragover');
    });
  });

  elements.uploadZone.addEventListener('drop', function (e) {
    var file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('audio/')) {
      handleAudioImport(file);
    } else if (file) {
      alert('오디오 파일만 업로드할 수 있습니다.');
    }
  });

  elements.btnRemoveFile.addEventListener('click', function (e) {
    e.stopPropagation();
    resetAudioWorkspace();
  });

  elements.btnTranscribe.addEventListener('click', function () {
    triggerTranscribeAI();
  });
}

function handleAudioImport(file) {
  state.currentFile = file;
  elements.fileName.textContent = file.name;
  elements.fileSize.textContent = formatBytes(file.size);

  elements.uploadZone.classList.add('hidden');
  elements.audioPlayerCard.classList.remove('hidden');
  elements.btnTranscribe.disabled = false;

  elements.mainAudio.src = URL.createObjectURL(file);
  elements.mainAudio.load();

  resetWorkspaceData();
  initWebAudio();

  if (file.size > MAX_DIRECT_UPLOAD_BYTES) {
    showToast('25MB 초과 파일입니다. 청크 분할 모드로 전사합니다.');
  }
}

function resetAudioWorkspace() {
  stopAudioPlayback();
  state.currentFile = null;
  elements.fileInput.value = '';
  elements.mainAudio.src = '';
  elements.audioPlayerCard.classList.add('hidden');
  elements.uploadZone.classList.remove('hidden');
  elements.btnTranscribe.disabled = true;
  resetWorkspaceData();
}

function resetWorkspaceData() {
  state.transcriptText = '';
  state.transcriptParagraphs = [];
  state.summaries = { summary: '', minutes: '', notes: '', qa: '', email: '' };
  state.summaryRequests = {};
  state.chatHistory = [];

  elements.transcriptContainer.innerHTML = '<div class="empty-state"><i data-lucide="music-4" class="empty-icon"></i><h3>전사록 없음</h3><p>오디오가 준비되면 전사 결과가 표시됩니다.</p></div>';
  elements.summaryContent.innerHTML = '<div class="empty-state"><i data-lucide="sparkles" class="empty-icon text-accent"></i><h3>요약 없음</h3><p>전사 완료 후 선택한 형식의 리포트가 표시됩니다.</p></div>';
  elements.chatMessagesContainer.innerHTML = '<div class="chat-system-message"><div class="system-icon"><i data-lucide="bot"></i></div><div class="system-text"><strong>AetherScribe AI 오디오 어시스턴트</strong><p>전사록 범위 안에서 답변합니다.</p></div></div>';

  elements.transcriptSearch.value = '';
  elements.transcriptSearch.disabled = true;
  elements.btnCopyTranscript.disabled = true;
  elements.btnDownloadTranscript.disabled = true;
  elements.btnCopySummary.disabled = true;
  elements.btnDownloadSummary.disabled = true;
  elements.chatInput.disabled = true;
  elements.chatInput.value = '';
  elements.btnSendChat.disabled = true;

  if (window.lucide) window.lucide.createIcons();
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  var k = 1024;
  var sizes = ['Bytes', 'KB', 'MB'];
  var i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getLoadedAudioDurationSec() {
  var duration = elements.mainAudio ? elements.mainAudio.duration : NaN;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function transcribeModelSupportsServerChunking(model) {
  return (model || 'gpt-4o-transcribe') !== 'whisper-1';
}

function isTranscriptionDurationLimitError(err) {
  var msg = (err && err.message ? err.message : '').toLowerCase();
  return msg.includes('duration') && (msg.includes('longer than') || msg.includes('maximum'));
}

/* ==========================================================================
   Web Audio & Visualizer
   ========================================================================== */

function initWebAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;
    sourceNode = audioCtx.createMediaElementSource(elements.mainAudio);
    sourceNode.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);
  } catch (e) {
    console.warn('Web Audio init failed:', e);
  }
}

function startVisualizer() {
  var canvas = elements.visualizer;
  var ctx = canvas.getContext('2d');

  function resizeCanvas() {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight || 80;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  var phase = 0;

  function draw() {
    requestAnimationFrame(draw);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    var amplitude = 0.08;
    var frequency = 0.02;
    var isPlaying = !elements.mainAudio.paused;

    if (isPlaying && analyserNode) {
      var bufferLength = analyserNode.frequencyBinCount;
      var dataArray = new Uint8Array(bufferLength);
      analyserNode.getByteFrequencyData(dataArray);
      var sum = 0;
      for (var i = 0; i < bufferLength; i++) sum += dataArray[i];
      var avg = sum / bufferLength;
      amplitude = 0.08 + (avg / 255) * 1.5;
      frequency = 0.015 + (avg / 255) * 0.025;
    }

    phase += isPlaying ? 0.08 : 0.02;

    var waveColors = [
      'rgba(91, 124, 250, 0.42)',
      'rgba(45, 185, 132, 0.32)',
      'rgba(201, 130, 56, 0.18)'
    ];

    for (var w = 0; w < 3; w++) {
      ctx.beginPath();
      ctx.lineWidth = w === 0 ? 2.5 : 1.5;
      ctx.strokeStyle = waveColors[w];
      var centerY = canvas.height / 2;
      var wavePhase = phase + (w * Math.PI / 3);
      var waveAmplitude = (canvas.height / 2.8) * amplitude * (1 - w * 0.2);
      for (var x = 0; x < canvas.width; x++) {
        var y = centerY + Math.sin(x * frequency + wavePhase) * waveAmplitude * Math.sin(Math.PI * x / canvas.width);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  draw();
}

/* ==========================================================================
   Audio Player
   ========================================================================== */

function setupAudioPlayer() {
  elements.mainAudio.addEventListener('durationchange', function () {
    updatePlaybackUI(0, elements.mainAudio.duration);
  });

  elements.mainAudio.addEventListener('timeupdate', function () {
    updatePlaybackUI(elements.mainAudio.currentTime, elements.mainAudio.duration || 0);
    highlightTranscriptPlayback(elements.mainAudio.currentTime);
  });

  elements.mainAudio.addEventListener('ended', function () {
    stopAudioPlayback();
  });

  elements.btnPlayPause.addEventListener('click', function () {
    if (elements.mainAudio.paused) startAudioPlayback();
    else pauseAudioPlayback();
  });

  elements.btnSkipBack.addEventListener('click', function () { seekAudioRelative(-10); });
  elements.btnSkipForward.addEventListener('click', function () { seekAudioRelative(10); });

  elements.progressBar.addEventListener('input', function (e) {
    var total = elements.mainAudio.duration || 0;
    elements.mainAudio.currentTime = (parseFloat(e.target.value) / 100) * total;
  });

  elements.speedSelect.addEventListener('change', function (e) {
    elements.mainAudio.playbackRate = parseFloat(e.target.value);
  });

  elements.volumeSlider.addEventListener('input', function (e) {
    var vol = parseFloat(e.target.value);
    elements.mainAudio.volume = vol;
    updateMuteIcon(vol);
  });

  elements.btnMute.addEventListener('click', function () {
    if (elements.mainAudio.volume > 0) {
      elements.mainAudio.volume = 0;
      elements.volumeSlider.value = 0;
      updateMuteIcon(0);
    } else {
      elements.mainAudio.volume = 0.8;
      elements.volumeSlider.value = 0.8;
      updateMuteIcon(0.8);
    }
  });
}

function startAudioPlayback() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  elements.mainAudio.play();
  setPlayerBadgeState('playing', '재생 중');
  elements.btnPlayPause.classList.add('playing');
  elements.btnPlayPause.innerHTML = '<i data-lucide="pause"></i>';
  if (window.lucide) window.lucide.createIcons();
}

function pauseAudioPlayback() {
  elements.mainAudio.pause();
  setPlayerBadgeState('paused', '일시 정지');
  elements.btnPlayPause.classList.remove('playing');
  elements.btnPlayPause.innerHTML = '<i data-lucide="play"></i>';
  if (window.lucide) window.lucide.createIcons();
}

function stopAudioPlayback() {
  elements.mainAudio.pause();
  elements.mainAudio.currentTime = 0;
  setPlayerBadgeState('idle', '대기 중');
  elements.btnPlayPause.classList.remove('playing');
  elements.btnPlayPause.innerHTML = '<i data-lucide="play"></i>';
  if (window.lucide) window.lucide.createIcons();
}

function seekAudioRelative(seconds) {
  elements.mainAudio.currentTime = Math.max(0, Math.min(elements.mainAudio.duration || 0, elements.mainAudio.currentTime + seconds));
}

function updatePlaybackUI(elapsed, total) {
  elements.progressBar.value = total > 0 ? (elapsed / total) * 100 : 0;
  elements.timeElapsed.textContent = formatTime(elapsed);
  elements.timeTotal.textContent = formatTime(total);
}

function formatTime(secs) {
  if (isNaN(secs)) return '0:00';
  var m = Math.floor(secs / 60);
  var s = Math.floor(secs % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function updateMuteIcon(vol) {
  var iconName = vol === 0 ? 'volume-x' : vol < 0.4 ? 'volume-1' : 'volume-2';
  elements.btnMute.innerHTML = '<i data-lucide="' + iconName + '" id="mute-icon"></i>';
  if (window.lucide) window.lucide.createIcons();
}

function setPlayerBadgeState(cls, text) {
  elements.statusBadge.className = 'status-badge ' + cls;
  elements.statusText.textContent = text;
}

function showTranscribeProgress(label, pct) {
  elements.transcribeProgress.classList.remove('hidden');
  elements.tpLabel.textContent = label;
  if (pct === null) {
    elements.tpFill.classList.add('indeterminate');
    elements.tpPct.textContent = '';
  } else {
    elements.tpFill.classList.remove('indeterminate');
    elements.tpFill.style.width = pct + '%';
    elements.tpPct.textContent = pct + '%';
  }
}

function hideTranscribeProgress() {
  elements.transcribeProgress.classList.add('hidden');
  elements.tpFill.style.width = '0%';
  elements.tpFill.classList.remove('indeterminate');
}

/* ==========================================================================
   AI Transcription
   ========================================================================== */

async function triggerTranscribeAI() {
  if (!state.promptHint || !state.promptHint.trim()) {
    elements.transcriptContainer.innerHTML = '<div class="empty-state"><i data-lucide="alert-triangle" class="empty-icon" style="color:#f59e0b;"></i><h3>전사 프롬프트를 입력해 주세요</h3><p>왼쪽 패널의 <strong>전사 프롬프트</strong> 항목에 전문 용어, 화자 이름 또는 전사 지침을 입력한 후 다시 시도해 주세요.</p></div>';
    if (window.lucide) window.lucide.createIcons();
    showToast('전사 프롬프트를 먼저 입력해 주세요.');
    return;
  }

  stopAudioPlayback();
  elements.btnTranscribe.disabled = true;
  setPlayerBadgeState('transcribing', 'AI 분석 중');
  showTranscribeProgress('전사 중...', null);

  var shimmerCard = '<div class="transcript-card" style="cursor:default;pointer-events:none;border-color:rgba(255,255,255,0.02);background:rgba(255,255,255,0.01);"><div style="display:flex;gap:10px;align-items:center;"><div style="width:50px;height:18px;border-radius:4px;background:linear-gradient(90deg,rgba(255,255,255,0.02) 25%,rgba(255,255,255,0.05) 50%,rgba(255,255,255,0.02) 75%);background-size:200% 100%;animation:shimmer-load 1.5s infinite;"></div><div style="width:80px;height:16px;border-radius:4px;background:linear-gradient(90deg,rgba(255,255,255,0.02) 25%,rgba(255,255,255,0.05) 50%,rgba(255,255,255,0.02) 75%);background-size:200% 100%;animation:shimmer-load 1.5s infinite;"></div></div><div style="width:100%;height:14px;border-radius:4px;margin-top:8px;background:linear-gradient(90deg,rgba(255,255,255,0.02) 25%,rgba(255,255,255,0.05) 50%,rgba(255,255,255,0.02) 75%);background-size:200% 100%;animation:shimmer-load 1.5s infinite;"></div><div style="width:60%;height:14px;border-radius:4px;margin-top:6px;background:linear-gradient(90deg,rgba(255,255,255,0.02) 25%,rgba(255,255,255,0.05) 50%,rgba(255,255,255,0.02) 75%);background-size:200% 100%;animation:shimmer-load 1.5s infinite;"></div></div>';
  elements.transcriptContainer.innerHTML = '<div style="padding:10px 0;"><div style="display:flex;flex-direction:column;gap:16px;">' + shimmerCard.repeat(4) + '</div></div>';

  try {
    if (!state.currentFile || !(state.currentFile instanceof File)) {
      throw new Error('오디오 파일 로드에 실패했습니다. 파일을 다시 선택해주세요.');
    }
    if (!state.apiKey) {
      throw new Error('OpenAI API Key를 입력해주세요.');
    }

    var whisperData = await transcribeAudioWithChunking(
      state.currentFile, state.language, state.promptHint, state.apiKey, state.transcribeModel
    );
    state.transcriptParagraphs = parseWhisperSegments(whisperData.segments || []);
    state.transcriptText = buildTranscriptText(state.transcriptParagraphs);

    renderTranscriptTimeline();

    elements.transcriptSearch.disabled = false;
    elements.btnCopyTranscript.disabled = false;
    elements.btnDownloadTranscript.disabled = false;
    elements.chatInput.disabled = false;
    elements.btnSendChat.disabled = false;

    triggerSummaryFormatLoad('summary');
    setPlayerBadgeState('idle', '대기 중');
    elements.btnTranscribe.disabled = false;
    hideTranscribeProgress();
    showToast('AI 전사 및 핵심 분석이 완료되었습니다.');
  } catch (err) {
    console.error('Transcription failed:', err);
    setPlayerBadgeState('idle', '대기 중');
    elements.btnTranscribe.disabled = false;
    hideTranscribeProgress();
    resetWorkspaceData();
    alert('AI 전사 오류: ' + err.message);
  }
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
      speaker: '화자',
      text: (seg.text || '').trim()
    };
  }).filter(function (p) { return p.text.length > 0; });
}

function buildTranscriptText(paragraphs) {
  return paragraphs.map(function (p) { return '[' + p.time + '] ' + p.speaker + ': ' + p.text; }).join('\n');
}

function renderTranscriptTimeline(filterWord) {
  filterWord = filterWord || '';
  elements.transcriptContainer.innerHTML = '';
  var query = filterWord.toLowerCase().trim();
  var filtered = state.transcriptParagraphs.filter(function (p) {
    return p.text.toLowerCase().includes(query) || p.speaker.toLowerCase().includes(query);
  });

  if (filtered.length === 0) {
    elements.transcriptContainer.innerHTML = '<div class="empty-state"><i data-lucide="alert-circle" class="empty-icon"></i><h3>검색 결과가 없습니다</h3><p>"' + filterWord + '" 단어를 포함하는 발언 단락을 찾을 수 없습니다.</p></div>';
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  filtered.forEach(function (p) {
    var card = document.createElement('div');
    card.className = 'transcript-card';
    card.id = 'transcript-card-' + p.id;
    card.setAttribute('data-seconds', p.seconds);

    var textHTML = p.text;
    var speakerHTML = p.speaker;
    if (query) {
      var regex = new RegExp('(' + escapeRegExp(filterWord) + ')', 'gi');
      textHTML = p.text.replace(regex, '<span class="search-highlight">$1</span>');
      speakerHTML = p.speaker.replace(regex, '<span class="search-highlight">$1</span>');
    }

    var timeHtml = p.time ? '<span class="timestamp-badge">' + p.time + '</span>' : '';
    card.innerHTML = '<div class="card-metadata">' + timeHtml + '<span class="speaker-label">' + speakerHTML + '</span></div><div class="speech-text">' + textHTML + '</div>';
    card.addEventListener('click', function () { seekAudioToSeconds(p.seconds); });
    elements.transcriptContainer.appendChild(card);
  });
}

function seekAudioToSeconds(seconds) {
  if (seconds < 0) return;
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
  document.querySelectorAll('.transcript-card').forEach(function (el) { el.classList.remove('active-playback'); });
  var activeCard = document.getElementById('transcript-card-' + activeSegment.id);
  if (activeCard) {
    activeCard.classList.add('active-playback');
    activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ==========================================================================
   Summary Hub
   ========================================================================== */

function setupSummaryActions() {
  elements.summaryFormatButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      elements.summaryFormatButtons.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      triggerSummaryFormatLoad(btn.getAttribute('data-format'));
    });
  });
}

async function triggerSummaryFormatLoad(format) {
  state.activeSummaryFormat = format;
  if (state.transcriptParagraphs.length === 0) return;

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
        elements.summaryContent.innerHTML = '<p style="color:#ef4444;text-align:center;padding:40px 0;">요약 생성 실패: ' + err.message + '</p>';
      }
    }
    return;
  }

  elements.summaryContent.innerHTML = '<div style="padding:10px 0;display:flex;flex-direction:column;gap:16px;"><div style="width:40%;height:24px;border-radius:6px;background:linear-gradient(90deg,rgba(255,255,255,0.02) 25%,rgba(255,255,255,0.05) 50%,rgba(255,255,255,0.02) 75%);background-size:200% 100%;animation:shimmer-load 1.5s infinite;"></div><div style="width:90%;height:14px;border-radius:4px;background:linear-gradient(90deg,rgba(255,255,255,0.02) 25%,rgba(255,255,255,0.05) 50%,rgba(255,255,255,0.02) 75%);background-size:200% 100%;animation:shimmer-load 1.5s infinite;"></div><div style="width:100%;height:14px;border-radius:4px;background:linear-gradient(90deg,rgba(255,255,255,0.02) 25%,rgba(255,255,255,0.05) 50%,rgba(255,255,255,0.02) 75%);background-size:200% 100%;animation:shimmer-load 1.5s infinite;"></div></div>';
  elements.btnCopySummary.disabled = true;
  elements.btnDownloadSummary.disabled = true;

  try {
    state.summaryRequests[format] = generateSummary(state.transcriptText, format, state.apiKey, state.model);
    var summaryText = await state.summaryRequests[format];
    state.summaries[format] = summaryText;
    if (state.activeSummaryFormat === format) renderSummaryMarkdown(summaryText);
  } catch (err) {
    console.error('Summary generation failed:', err);
    if (state.activeSummaryFormat === format) {
      elements.summaryContent.innerHTML = '<p style="color:#ef4444;text-align:center;padding:40px 0;">요약 생성 실패: ' + err.message + '</p>';
    }
  } finally {
    delete state.summaryRequests[format];
  }
}

function renderSummaryMarkdown(markdown) {
  elements.summaryContent.innerHTML = window.marked ? window.marked.parse(markdown) : markdown;
  elements.btnCopySummary.disabled = false;
  elements.btnDownloadSummary.disabled = false;
}

/* ==========================================================================
   Chat Q&A
   ========================================================================== */

function setupChatActions() {
  elements.btnSendChat.addEventListener('click', function () { triggerSubmitChat(); });
  elements.chatInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') triggerSubmitChat();
  });
}

async function triggerSubmitChat() {
  var query = elements.chatInput.value.trim();
  if (!query || state.transcriptParagraphs.length === 0) return;

  elements.chatInput.value = '';
  elements.chatInput.disabled = true;
  elements.btnSendChat.disabled = true;

  appendChatMessage('user', 'U', query);
  var typingId = appendChatTypingIndicator();

  try {
    var aiResponse = await askChatAboutTranscript(
      state.transcriptText, query, state.chatHistory, state.apiKey, state.model
    );
    state.chatHistory.push({ role: 'user', text: query });
    state.chatHistory.push({ role: 'model', text: aiResponse });
    removeChatBubble(typingId);
    appendChatMessage('bot', 'AI', aiResponse);
  } catch (err) {
    console.error('Chat Q&A failed:', err);
    removeChatBubble(typingId);
    appendChatMessage('bot', 'AI', '답변 처리 중 오류가 발생했습니다: ' + err.message);
  } finally {
    elements.chatInput.disabled = false;
    elements.btnSendChat.disabled = false;
    elements.chatInput.focus();
  }
}

function appendChatMessage(role, avatarText, text) {
  var bubble = document.createElement('div');
  bubble.className = 'chat-bubble ' + role;
  var id = 'bubble-' + Math.random().toString(36).substring(2, 9);
  bubble.id = id;
  bubble.innerHTML = '<div class="chat-avatar">' + avatarText + '</div><div class="chat-text-panel">' + text.replace(/\n/g, '<br>') + '</div>';
  elements.chatMessagesContainer.appendChild(bubble);
  elements.chatMessagesContainer.scrollTop = elements.chatMessagesContainer.scrollHeight;
  return id;
}

function appendChatTypingIndicator() {
  var bubble = document.createElement('div');
  bubble.className = 'chat-bubble bot';
  bubble.id = 'bubble-typing';
  bubble.innerHTML = '<div class="chat-avatar">AI</div><div class="chat-text-panel" style="padding:12px 18px;"><div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>';
  elements.chatMessagesContainer.appendChild(bubble);
  elements.chatMessagesContainer.scrollTop = elements.chatMessagesContainer.scrollHeight;
  return 'bubble-typing';
}

function removeChatBubble(id) {
  var el = document.getElementById(id);
  if (el) el.remove();
}

/* ==========================================================================
   Transcript Actions
   ========================================================================== */

function setupTranscriptActions() {
  elements.transcriptSearch.addEventListener('input', function (e) {
    renderTranscriptTimeline(e.target.value);
  });

  elements.btnCopyTranscript.addEventListener('click', function () {
    navigator.clipboard.writeText(state.transcriptText);
    showToast('전사록이 클립보드에 복사되었습니다.');
  });

  elements.btnDownloadTranscript.addEventListener('click', function () {
    downloadTextFile(state.currentFile.name + '_transcript.txt', state.transcriptText);
  });

  elements.btnCopySummary.addEventListener('click', function () {
    navigator.clipboard.writeText(state.summaries[state.activeSummaryFormat]);
    showToast('요약 리포트가 클립보드에 복사되었습니다.');
  });

  elements.btnDownloadSummary.addEventListener('click', function () {
    downloadTextFile(state.currentFile.name + '_summary_' + state.activeSummaryFormat + '.md', state.summaries[state.activeSummaryFormat]);
  });
}

function downloadTextFile(filename, content) {
  var blob = new Blob([content], { type: 'text/markdown;charset=utf-8;' });
  var link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('파일이 다운로드되었습니다.');
}

function showToast(text) {
  elements.toastText.textContent = text;
  elements.toast.classList.remove('hidden');
  setTimeout(function () { elements.toast.classList.add('hidden'); }, 2500);
}

/* ==========================================================================
   Tabs
   ========================================================================== */

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
        item.pane.classList.remove('active');
      });
      t.btn.classList.add('active');
      t.pane.classList.add('active');

      if (t.pane === elements.paneTranscript && state.transcriptParagraphs.length > 0) {
        highlightTranscriptPlayback(elements.mainAudio.currentTime);
      }
    });
  });
}
