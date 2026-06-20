/* ==========================================================================
   Recapify - Shared Configuration
   OpenAI GPT-4o-transcribe + Claude Sonnet | file:// compatible (no ES modules)
   ========================================================================== */

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_DIRECT_UPLOAD_BYTES = 24 * 1024 * 1024;
const MAX_DIRECT_TRANSCRIBE_DURATION_SEC = 1350; // 모델 1400초 제한에 여유를 둔 직접 전송 한도
const CHUNK_DURATION_SEC = 600;                  // 10분 단위 청크 (16kHz mono WAV 기준 ~18MB)
const WHISPER_SAMPLE_RATE = 16000;               // 다운샘플 목표 (25MB 제한 내 최대 청크 확보)
const MAX_OPENAI_REQUEST_RETRIES = 3;
const RESPONSE_API_MODEL_PATTERN = /^gpt-5(\.|-|$)/;
const CLAUDE_MODEL_PATTERN = /^claude-/;
const TRANSCRIPT_CACHE_KEY = 'recapify_transcript_cache_v1';
const SUMMARY_PROMPT_HISTORY_KEY = 'recapify_summary_prompt_history_v1';
const MAX_SUMMARY_PROMPT_HISTORY = 5;

const SUMMARY_MAX_TOKENS = {
  summary: 2000,
  notes: 2200
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

## 상세 메모`
};

/* ==========================================================================
   Application State
   ========================================================================== */

var state = {
  apiKey: '',
  anthropicApiKey: '',
  model: 'claude-sonnet-4-6',
  transcribeModel: 'gpt-4o-transcribe',
  language: 'ko',
  summaryPrompt: '',
  summaryPromptDirty: false,
  currentFile: null,
  fileQueue: [],
  batchRunning: false,
  batchIndex: 0,
  batchResults: [],
  audioObjectUrl: null,
  transcribeAbortController: null,
  transcriptSourceName: 'transcript',
  transcriptText: '',
  transcriptParagraphs: [],
  chaptersMarkdown: '',
  summaries: { summary: '', notes: '' },
  summaryRequests: {},
  activeSummaryFormat: 'summary',
  summaryPromptHistory: [],
  chatHistory: [],
  lastPlaybackSegmentId: null
};

// Web Audio
var audioCtx = null;
var analyserNode = null;
var sourceNode = null;

// TTS (Web Speech API read-aloud)
var tts = {
  speaking: false,
  segmentIndex: 0,
  utterance: null
};

// Text generation requests are queued to avoid concurrent rate-limit spikes.
var openAITextRequestQueue = Promise.resolve();

// DOM Elements
var elements = {
  apiKeyInput: document.getElementById('api-key'),
  apiKeyWrapper: document.getElementById('api-key-wrapper'),
  btnToggleApiKey: document.getElementById('btn-toggle-api-key'),
  btnCollapseApiKey: document.getElementById('btn-collapse-api-key'),
  anthropicApiKeyInput: document.getElementById('anthropic-api-key'),
  anthropicApiKeyWrapper: document.getElementById('anthropic-api-key-wrapper'),
  btnToggleAnthropicApiKey: document.getElementById('btn-toggle-anthropic-api-key'),
  btnCollapseAnthropicApiKey: document.getElementById('btn-collapse-anthropic-api-key'),

  btnThemeToggle: document.getElementById('btn-theme-toggle'),
  themeToggleIcon: document.getElementById('theme-toggle-icon'),

  selectModel: document.getElementById('select-model'),
  selectTranscribeModel: document.getElementById('select-transcribe-model'),
  selectLang: document.getElementById('select-lang'),
  inputSummaryPrompt: document.getElementById('input-summary-prompt'),
  btnRunSummary: document.getElementById('btn-run-summary'),
  btnResetSummaryPrompt: document.getElementById('btn-reset-summary-prompt'),
  summaryPromptHistory: document.getElementById('summary-prompt-history'),

  uploadZone: document.getElementById('upload-zone'),
  fileInput: document.getElementById('file-input'),
  batchQueue: document.getElementById('batch-queue'),

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

  btnSkipBack: document.getElementById('btn-skip-back'),
  btnPlayPause: document.getElementById('btn-play-pause'),
  btnSkipForward: document.getElementById('btn-skip-forward'),
  btnMute: document.getElementById('btn-mute'),
  btnSpeed: document.getElementById('btn-speed'),
  speedPopup: document.getElementById('speed-popup'),
  speedLabel: document.getElementById('speed-label'),
  speedOptions: document.querySelectorAll('.speed-option[data-speed]'),

  btnTranscribe: document.getElementById('btn-transcribe'),
  btnCancelTranscribe: document.getElementById('btn-cancel-transcribe'),
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
  btnTtsRead: document.getElementById('btn-tts-read'),
  btnImportTranscript: document.getElementById('btn-import-transcript'),
  transcriptFileInput: document.getElementById('transcript-file-input'),
  btnGenerateChapters: document.getElementById('btn-generate-chapters'),
  btnCopyTranscript: document.getElementById('btn-copy-transcript'),
  btnDownloadTranscript: document.getElementById('btn-download-transcript'),
  btnResetTranscript: document.getElementById('btn-reset-transcript'),
  chaptersContainer: document.getElementById('chapters-container'),
  transcriptContainer: document.getElementById('transcript-container'),

  summaryFormatButtons: document.querySelectorAll('.summary-format-btn'),
  summaryBadge: document.getElementById('summary-badge'),
  summaryContent: document.getElementById('summary-content'),
  btnCopySummary: document.getElementById('btn-copy-summary'),
  btnDownloadSummary: document.getElementById('btn-download-summary'),

  chatMessagesContainer: document.getElementById('chat-messages-container'),
  chatInput: document.getElementById('chat-input'),
  btnSendChat: document.getElementById('btn-send-chat'),

  toast: document.getElementById('toast'),
  toastText: document.getElementById('toast-text')
};
