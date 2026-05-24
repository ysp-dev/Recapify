/* ==========================================================================
   Recapify - Main Application Script
   OpenAI GPT-4o-transcribe + GPT-5.5 | file:// compatible (no ES modules)
   ========================================================================== */

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const MAX_DIRECT_UPLOAD_BYTES = 24 * 1024 * 1024;
const MAX_DIRECT_TRANSCRIBE_DURATION_SEC = 1350; // 모델 1400초 제한에 여유를 둔 직접 전송 한도
const CHUNK_DURATION_SEC = 600;                  // 10분 단위 청크 (16kHz mono WAV 기준 ~18MB)
const WHISPER_SAMPLE_RATE = 16000;               // 다운샘플 목표 (25MB 제한 내 최대 청크 확보)
const MAX_OPENAI_REQUEST_RETRIES = 3;
const RESPONSE_API_MODELS = ['gpt-5.5'];
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
   OpenAI API Functions
   ========================================================================== */

async function transcribeAudio(audioFile, language, promptHint, apiKey, transcribeModel, signal) {
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
    body: formData,
    signal: signal
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

async function transcribeAudioWithChunking(audioFile, language, promptHint, apiKey, transcribeModel, signal, onChunkSegments) {
  var knownDuration = getLoadedAudioDurationSec();
  var fitsDirectSize = audioFile.size <= MAX_DIRECT_UPLOAD_BYTES;
  var supportsServerChunking = transcribeModelSupportsServerChunking(transcribeModel);
  var serverChunkingDurationFallback = false;

  if (fitsDirectSize && supportsServerChunking) {
    try {
      return await transcribeAudio(audioFile, language, promptHint, apiKey, transcribeModel, signal);
    } catch (err) {
      if (!isTranscriptionDurationLimitError(err)) throw err;
      serverChunkingDurationFallback = true;
      showToast('서버 청크 처리 한도를 넘어 클라이언트 청크로 재시도합니다.');
    }
  }

  // 파일 크기와 재생 시간이 모두 안전할 때만 직접 전송한다.
  if (!serverChunkingDurationFallback && fitsDirectSize && (knownDuration === null || knownDuration <= MAX_DIRECT_TRANSCRIBE_DURATION_SEC)) {
    return transcribeAudio(audioFile, language, promptHint, apiKey, transcribeModel, signal);
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
  if (signal && signal.aborted) throw new DOMException('전사가 취소되었습니다.', 'AbortError');
  var arrayBuffer = await audioFile.arrayBuffer();
  if (signal && signal.aborted) throw new DOMException('전사가 취소되었습니다.', 'AbortError');

  // 2. AudioContext로 디코딩
  var tempCtx = new (window.AudioContext || window.webkitAudioContext)();
  var audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
  await tempCtx.close();
  if (signal && signal.aborted) throw new DOMException('전사가 취소되었습니다.', 'AbortError');

  if (fitsDirectSize && audioBuffer.duration <= MAX_DIRECT_TRANSCRIBE_DURATION_SEC) {
    showTranscribeProgress('전사 중...', null);
    return transcribeAudio(audioFile, language, promptHint, apiKey, transcribeModel, signal);
  }

  // 3. OfflineAudioContext로 16kHz mono 리샘플링
  setPlayerBadgeState('transcribing', '오디오 처리 중...');
  showTranscribeProgress('오디오 청크 준비 중...', null);
  var resampledBuffer = await resampleToMono16k(audioBuffer);
  if (signal && signal.aborted) throw new DOMException('전사가 취소되었습니다.', 'AbortError');

  // 4. 청크 수 계산 및 순차 전사
  var totalDuration = resampledBuffer.duration;
  var totalChunks = Math.ceil(totalDuration / CHUNK_DURATION_SEC);
  var allSegments = [];
  var contextPrompt = promptHint || '';

  for (var i = 0; i < totalChunks; i++) {
    if (signal && signal.aborted) throw new DOMException('전사가 취소되었습니다.', 'AbortError');
    var startSec = i * CHUNK_DURATION_SEC;
    var endSec = Math.min((i + 1) * CHUNK_DURATION_SEC, totalDuration);
    var offsetSec = startSec;

    var chunkPct = Math.round((i / totalChunks) * 100);
    setPlayerBadgeState('transcribing', '청크 ' + (i + 1) + '/' + totalChunks + ' 전사 중...');
    showTranscribeProgress('청크 ' + (i + 1) + ' / ' + totalChunks + ' 전사 중...', chunkPct);

    var wavBlob = extractChunkAsWav(resampledBuffer, startSec, endSec);
    var wavFile = new File([wavBlob], 'chunk_' + i + '.wav', { type: 'audio/wav' });

    var result = await transcribeAudio(wavFile, language, contextPrompt, apiKey, transcribeModel, signal);

    // 타임스탬프에 청크 오프셋 적용
    var segments = (result.segments || []).map(function (seg) {
      return Object.assign({}, seg, {
        start: (seg.start || 0) + offsetSec,
        end: (seg.end || seg.start || 0) + offsetSec
      });
    });
    allSegments = allSegments.concat(segments);
    if (typeof onChunkSegments === 'function') {
      onChunkSegments(allSegments.slice(), i + 1, totalChunks);
    }

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

async function generateSummary(transcriptText, format, apiKey, model, customPrompt, onDelta) {
  var systemPrompt = SUMMARY_SYSTEM_PROMPTS[format] || SUMMARY_SYSTEM_PROMPTS.summary;
  if (customPrompt && customPrompt.trim()) {
    systemPrompt += '\n\n추가 사용자 지침:\n' + customPrompt.trim();
  }

  return enqueueOpenAITextRequest(async function () {
    if (isResponsesModel(model)) {
      var responsesBody = {
        model: model,
        instructions: systemPrompt,
        input: '다음 오디오 전사록을 분석하여 요청한 형식으로 정리해 주세요:\n\n---\n' + transcriptText + '\n---',
        reasoning: { effort: 'low' },
        text: { verbosity: 'low' },
        max_output_tokens: SUMMARY_MAX_TOKENS[format] || 2000,
        store: false
      };

      if (typeof onDelta === 'function') {
        responsesBody.stream = true;
        return streamOpenAITextResponse(OPENAI_API_BASE + '/responses', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(responsesBody)
        }, onDelta, '요약 생성');
      }

      var responseData = await fetchOpenAIJsonWithRetry(OPENAI_API_BASE + '/responses', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(responsesBody)
      }, '요약 생성');

      return extractOpenAIResponseText(responseData);
    }

    var chatBody = {
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '다음 오디오 전사록을 분석하여 요청한 형식으로 정리해 주세요:\n\n---\n' + transcriptText + '\n---' }
      ],
      temperature: 0.7,
      max_tokens: SUMMARY_MAX_TOKENS[format] || 2000
    };

    if (typeof onDelta === 'function') {
      chatBody.stream = true;
      return streamOpenAITextResponse(OPENAI_API_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(chatBody)
      }, onDelta, '요약 생성');
    }

    var data = await fetchOpenAIJsonWithRetry(OPENAI_API_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody)
    }, '요약 생성');

    return (data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  });
}

async function generateChapters(transcriptText, apiKey, model) {
  var systemPrompt = '전사록을 시간대별 주요 토픽 챕터로 나누는 편집자입니다. 반드시 마크다운 목록으로만 답하고, 각 항목은 [MM:SS] 형식 시간과 6~12단어 제목, 한 문장 설명을 포함하세요.';
  return enqueueOpenAITextRequest(async function () {
    if (isResponsesModel(model)) {
      var responseData = await fetchOpenAIJsonWithRetry(OPENAI_API_BASE + '/responses', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          instructions: systemPrompt,
          input: '다음 전사록의 시간대를 참고해 챕터를 생성하세요:\n\n---\n' + transcriptText + '\n---',
          reasoning: { effort: 'low' },
          text: { verbosity: 'low' },
          max_output_tokens: 900,
          store: false
        })
      }, '챕터 생성');
      return extractOpenAIResponseText(responseData);
    }

    var data = await fetchOpenAIJsonWithRetry(OPENAI_API_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '다음 전사록의 시간대를 참고해 챕터를 생성하세요:\n\n---\n' + transcriptText + '\n---' }
        ],
        temperature: 0.4,
        max_tokens: 900
      })
    }, '챕터 생성');
    return (data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  });
}

async function askChatAboutTranscript(transcriptText, userQuery, chatHistory, apiKey, model) {
  var instructions = '당신은 전문 오디오 콘텐츠 어시스턴트입니다. 아래 오디오 전사록을 완전히 이해하고 있으며, 사용자의 질문에 전사록 내용을 기반으로 정확하고 친절하게 답변합니다. 전사록에 없는 내용은 추측하지 마세요.\n\n[오디오 전사록]\n---\n' + transcriptText + '\n---';
  var messages = [{ role: 'system', content: instructions }];
  var responseInput = [];

  for (var i = 0; i < chatHistory.length; i++) {
    var msg = chatHistory[i];
    messages.push({ role: msg.role === 'model' ? 'assistant' : 'user', content: msg.text });
    responseInput.push({ role: msg.role === 'model' ? 'assistant' : 'user', content: msg.text });
  }
  messages.push({ role: 'user', content: userQuery });
  responseInput.push({ role: 'user', content: userQuery });

  return enqueueOpenAITextRequest(async function () {
    if (isResponsesModel(model)) {
      var responseData = await fetchOpenAIJsonWithRetry(OPENAI_API_BASE + '/responses', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          instructions: instructions,
          input: responseInput,
          reasoning: { effort: 'low' },
          text: { verbosity: 'low' },
          max_output_tokens: 1200,
          store: false
        })
      }, 'Q&A 답변');

      return extractOpenAIResponseText(responseData);
    }

    var data = await fetchOpenAIJsonWithRetry(OPENAI_API_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model, messages: messages, temperature: 0.7, max_tokens: 1200 })
    }, 'Q&A 답변');

    return (data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  });
}

function isResponsesModel(model) {
  return RESPONSE_API_MODELS.indexOf(model) !== -1;
}

function extractOpenAIResponseText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string') return data.output_text;

  var parts = [];
  if (Array.isArray(data.output)) {
    data.output.forEach(function (item) {
      if (typeof item.text === 'string') {
        parts.push(item.text);
      }
      if (Array.isArray(item.content)) {
        item.content.forEach(function (contentPart) {
          if (typeof contentPart.text === 'string') {
            parts.push(contentPart.text);
          } else if (typeof contentPart.content === 'string') {
            parts.push(contentPart.content);
          }
        });
      }
    });
  }

  return parts.join('').trim();
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

async function streamOpenAITextResponse(url, options, onDelta, label) {
  var requestLabel = label || 'OpenAI 요청';
  var response = await fetch(url, options);
  if (!response.ok) {
    var data = await response.json().catch(function () { return {}; });
    throw new Error(data.error ? data.error.message : (requestLabel + ' 오류: ' + response.status));
  }

  if (!response.body) {
    throw new Error(requestLabel + ' 스트림을 읽을 수 없습니다.');
  }

  var reader = response.body.getReader();
  var decoder = new TextDecoder('utf-8');
  var buffer = '';
  var fullText = '';

  while (true) {
    var read = await reader.read();
    if (read.done) break;

    buffer += decoder.decode(read.value, { stream: true });
    var blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';

    for (var i = 0; i < blocks.length; i++) {
      var delta = extractDeltaFromSSEBlock(blocks[i]);
      if (delta === null) continue;
      fullText += delta;
      onDelta(delta, fullText);
    }
  }

  if (buffer.trim()) {
    var finalDelta = extractDeltaFromSSEBlock(buffer);
    if (finalDelta !== null) {
      fullText += finalDelta;
      onDelta(finalDelta, fullText);
    }
  }

  return fullText;
}

function extractDeltaFromSSEBlock(block) {
  var lines = block.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line.startsWith('data:')) continue;

    var payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return null;

    try {
      var event = JSON.parse(payload);
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') return event.delta;
      if (event.choices && event.choices[0] && event.choices[0].delta && typeof event.choices[0].delta.content === 'string') {
        return event.choices[0].delta.content;
      }
    } catch (err) {
      console.warn('Streaming event parse failed:', err);
    }
  }
  return null;
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
  model: 'gpt-4.1-mini',
  transcribeModel: 'gpt-4o-transcribe',
  language: 'ko',
  promptHint: '',
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
  chatHistory: []
};

// Web Audio
var audioCtx = null;
var analyserNode = null;
var sourceNode = null;

// GPT summary/chat requests are queued to avoid concurrent TPM spikes.
var openAITextRequestQueue = Promise.resolve();
var summaryPromptCacheTimer = null;

// DOM Elements
var elements = {
  apiKeyInput: document.getElementById('api-key'),
  apiKeyWrapper: document.getElementById('api-key-wrapper'),
  btnToggleApiKey: document.getElementById('btn-toggle-api-key'),

  btnThemeToggle: document.getElementById('btn-theme-toggle'),
  themeToggleIcon: document.getElementById('theme-toggle-icon'),

  selectModel: document.getElementById('select-model'),
  selectTranscribeModel: document.getElementById('select-transcribe-model'),
  selectLang: document.getElementById('select-lang'),
  inputPromptHint: document.getElementById('input-prompt-hint'),
  btnResetPromptHint: document.getElementById('btn-reset-prompt-hint'),
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

  speedSelect: document.getElementById('speed-select'),
  btnSkipBack: document.getElementById('btn-skip-back'),
  btnPlayPause: document.getElementById('btn-play-pause'),
  btnSkipForward: document.getElementById('btn-skip-forward'),
  btnMute: document.getElementById('btn-mute'),
  volumeSlider: document.getElementById('volume-slider'),

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
  btnImportTranscript: document.getElementById('btn-import-transcript'),
  transcriptFileInput: document.getElementById('transcript-file-input'),
  btnGenerateChapters: document.getElementById('btn-generate-chapters'),
  btnCopyTranscript: document.getElementById('btn-copy-transcript'),
  btnDownloadTranscript: document.getElementById('btn-download-transcript'),
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
  setupPromptHistory();
  restoreCachedTranscript();
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
      elements.inputPromptHint.value = badge.getAttribute('data-preset');
      state.promptHint = elements.inputPromptHint.value;
      if (state.promptHint) {
        badge.classList.add('selected');
        showToast('전사 힌트가 설정되었습니다.');
      } else {
        showToast('전사 힌트를 초기화했습니다.');
      }
    });
  });
}

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

  elements.btnToggleApiKey.addEventListener('click', function () {
    var isHidden = elements.apiKeyInput.type === 'password';
    elements.apiKeyInput.type = isHidden ? 'text' : 'password';
    elements.btnToggleApiKey.setAttribute('title', isHidden ? 'API Key 숨기기' : 'API Key 보이기');
    elements.btnToggleApiKey.setAttribute('aria-label', isHidden ? 'API Key 숨기기' : 'API Key 보이기');
    elements.btnToggleApiKey.innerHTML = '<i data-lucide="' + (isHidden ? 'eye-off' : 'eye') + '"></i>';
    if (window.lucide) window.lucide.createIcons();
  });
}

function setupSettingsListeners() {
  state.model = elements.selectModel.value;
  state.transcribeModel = elements.selectTranscribeModel.value;
  state.language = elements.selectLang.value;
  state.promptHint = elements.inputPromptHint.value;
  state.summaryPrompt = elements.inputSummaryPrompt.value;
  elements.selectModel.addEventListener('change', function (e) { state.model = e.target.value; });
  elements.selectTranscribeModel.addEventListener('change', function (e) { state.transcribeModel = e.target.value; });
  elements.selectLang.addEventListener('change', function (e) { state.language = e.target.value; });
  elements.inputPromptHint.addEventListener('input', function (e) { state.promptHint = e.target.value; });
  elements.btnResetPromptHint.addEventListener('click', function () {
    document.querySelectorAll('.preset-badge').forEach(function (b) { b.classList.remove('selected'); });
    elements.inputPromptHint.value = '';
    state.promptHint = '';
    showToast('전사 힌트를 초기화했습니다.');
  });
  elements.inputSummaryPrompt.addEventListener('input', function (e) {
    state.summaryPrompt = e.target.value;
    state.summaryPromptDirty = true;
    clearTimeout(summaryPromptCacheTimer);
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

function clearSummaryCache() {
  state.summaries = { summary: '', notes: '' };
  state.summaryRequests = {};
  state.summaryPromptDirty = false;
}

/* ==========================================================================
   Audio Upload
   ========================================================================== */

function setupUploadZone() {
  elements.uploadZone.addEventListener('click', function () {
    elements.fileInput.click();
  });

  elements.fileInput.addEventListener('change', function (e) {
    enqueueAudioFiles(e.target.files);
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
    enqueueAudioFiles(e.dataTransfer.files);
  });

  elements.btnRemoveFile.addEventListener('click', function (e) {
    e.stopPropagation();
    resetAudioWorkspace();
  });

  elements.btnTranscribe.addEventListener('click', function () {
    triggerTranscribeAI();
  });

  elements.btnCancelTranscribe.addEventListener('click', function () {
    state.batchRunning = false;
    abortCurrentTranscription();
  });
}

function enqueueAudioFiles(fileList) {
  var files = Array.prototype.slice.call(fileList || []).filter(function (file) {
    return file && file.type.startsWith('audio/');
  });

  if (!files.length) {
    if (fileList && fileList.length) showToast('오디오 파일만 업로드할 수 있습니다.');
    return;
  }

  state.fileQueue = files.map(function (file, idx) {
    return { file: file, status: idx === 0 ? 'ready' : 'queued' };
  });
  state.batchRunning = false;
  state.batchIndex = 0;
  state.batchResults = [];
  renderBatchQueue();
  handleAudioImport(files[0], { preserveQueue: true });

  if (files.length > 1) {
    showToast(files.length + '개 파일을 배치 큐에 추가했습니다.');
  }
}

function handleAudioImport(file, options) {
  var preserveQueue = options && options.preserveQueue;
  abortCurrentTranscription();
  releaseAudioObjectUrl();
  if (!preserveQueue) {
    state.fileQueue = [];
    state.batchRunning = false;
    state.batchIndex = 0;
    state.batchResults = [];
    renderBatchQueue();
  }
  state.currentFile = file;
  state.transcriptSourceName = file.name;
  elements.fileName.textContent = file.name;
  elements.fileSize.textContent = formatBytes(file.size);

  elements.uploadZone.classList.add('hidden');
  elements.audioPlayerCard.classList.remove('hidden');
  elements.btnTranscribe.disabled = false;

  state.audioObjectUrl = URL.createObjectURL(file);
  elements.mainAudio.src = state.audioObjectUrl;
  elements.mainAudio.load();

  resetWorkspaceData();
  initWebAudio();

  if (file.size > MAX_DIRECT_UPLOAD_BYTES) {
    showToast('25MB 초과 파일입니다. 청크 분할 모드로 전사합니다.');
  }
}

function resetAudioWorkspace() {
  abortCurrentTranscription();
  clearTranscriptCache();
  state.fileQueue = [];
  state.batchRunning = false;
  state.batchIndex = 0;
  state.batchResults = [];
  stopAudioPlayback();
  state.currentFile = null;
  state.transcriptSourceName = 'transcript';
  elements.fileInput.value = '';
  elements.mainAudio.src = '';
  releaseAudioObjectUrl();
  elements.audioPlayerCard.classList.add('hidden');
  elements.uploadZone.classList.remove('hidden');
  elements.btnTranscribe.disabled = true;
  renderBatchQueue();
  resetWorkspaceData();
}

function releaseAudioObjectUrl() {
  if (state.audioObjectUrl) {
    URL.revokeObjectURL(state.audioObjectUrl);
    state.audioObjectUrl = null;
  }
}

function abortCurrentTranscription() {
  if (state.transcribeAbortController) {
    state.transcribeAbortController.abort();
    state.transcribeAbortController = null;
  }
}

function renderBatchQueue() {
  elements.batchQueue.innerHTML = '';
  if (!state.fileQueue.length || state.fileQueue.length === 1) {
    elements.batchQueue.classList.add('hidden');
    updateTranscribeButtonLabel();
    return;
  }

  elements.batchQueue.classList.remove('hidden');
  var title = document.createElement('div');
  title.className = 'batch-queue-title';
  title.textContent = '파일 큐';
  elements.batchQueue.appendChild(title);

  state.fileQueue.forEach(function (item, idx) {
    var row = document.createElement('div');
    row.className = 'batch-queue-item ' + item.status;

    var name = document.createElement('span');
    name.textContent = (idx + 1) + '. ' + item.file.name;

    var status = document.createElement('span');
    status.className = 'batch-queue-status';
    status.textContent = getBatchStatusLabel(item.status);

    row.appendChild(name);
    row.appendChild(status);
    elements.batchQueue.appendChild(row);
  });
  updateTranscribeButtonLabel();
}

function getBatchStatusLabel(status) {
  if (status === 'running') return '진행 중';
  if (status === 'done') return '완료';
  if (status === 'failed') return '실패';
  if (status === 'ready') return '대기';
  return '큐';
}

function updateTranscribeButtonLabel() {
  var label = state.fileQueue.length > 1 ? '배치 전사 시작 (' + state.fileQueue.length + ')' : 'AI 전사 및 요약 시작';
  elements.btnTranscribe.innerHTML = '<i data-lucide="wand-2"></i> ' + label;
  if (window.lucide) window.lucide.createIcons();
}

function resetWorkspaceData() {
  state.transcriptText = '';
  state.transcriptParagraphs = [];
  state.transcriptSourceName = state.currentFile ? state.currentFile.name : 'transcript';
  state.chaptersMarkdown = '';
  state.summaries = { summary: '', notes: '' };
  state.summaryRequests = {};
  state.chatHistory = [];

  elements.transcriptContainer.innerHTML = '<div class="empty-state"><i data-lucide="music-4" class="empty-icon"></i><h3>전사록 없음</h3><p>오디오가 준비되면 전사 결과가 표시됩니다.</p></div>';
  elements.summaryContent.innerHTML = '<div class="empty-state"><i data-lucide="sparkles" class="empty-icon text-accent"></i><h3>요약 없음</h3><p>전사 완료 후 선택한 형식의 리포트가 표시됩니다.</p></div>';
  elements.chatMessagesContainer.innerHTML = '<div class="chat-system-message"><div class="system-icon"><i data-lucide="bot"></i></div><div class="system-text"><strong>Recapify AI 오디오 어시스턴트</strong><p>전사록 범위 안에서 답변합니다.</p></div></div>';
  elements.chaptersContainer.innerHTML = '';
  elements.chaptersContainer.classList.add('hidden');

  elements.transcriptSearch.value = '';
  elements.transcriptSearch.disabled = true;
  elements.btnGenerateChapters.disabled = true;
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
  elements.btnPlayPause.setAttribute('aria-label', '일시정지');
  if (window.lucide) window.lucide.createIcons();
}

function pauseAudioPlayback() {
  elements.mainAudio.pause();
  setPlayerBadgeState('paused', '일시 정지');
  elements.btnPlayPause.classList.remove('playing');
  elements.btnPlayPause.innerHTML = '<i data-lucide="play"></i>';
  elements.btnPlayPause.setAttribute('aria-label', '재생');
  if (window.lucide) window.lucide.createIcons();
}

function stopAudioPlayback() {
  elements.mainAudio.pause();
  elements.mainAudio.currentTime = 0;
  setPlayerBadgeState('idle', '대기 중');
  elements.btnPlayPause.classList.remove('playing');
  elements.btnPlayPause.innerHTML = '<i data-lucide="play"></i>';
  elements.btnPlayPause.setAttribute('aria-label', '재생');
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
  elements.btnMute.setAttribute('aria-label', vol === 0 ? '음소거 해제' : '음소거');
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

async function triggerTranscribeAI(options) {
  options = options || {};
  abortCurrentTranscription();
  var transcribeController = new AbortController();
  state.transcribeAbortController = transcribeController;
  var isBatchRun = state.fileQueue.length > 1;
  if (isBatchRun && !options.fromBatch) {
    state.batchRunning = true;
    state.batchIndex = Math.max(0, state.batchIndex || 0);
  }
  if (isBatchRun && state.fileQueue[state.batchIndex]) {
    state.fileQueue[state.batchIndex].status = 'running';
    renderBatchQueue();
  }

  stopAudioPlayback();
  elements.btnTranscribe.disabled = true;
  elements.btnCancelTranscribe.classList.remove('hidden');
  setPlayerBadgeState('transcribing', 'AI 분석 중');
  showTranscribeProgress('전사 중...', null);
  renderTranscriptLoadingState();

  try {
    if (!state.currentFile || !(state.currentFile instanceof File)) {
      throw new Error('오디오 파일 로드에 실패했습니다. 파일을 다시 선택해주세요.');
    }
    if (!state.apiKey) {
      throw new Error('OpenAI API Key를 입력해주세요.');
    }

    var whisperData = await transcribeAudioWithChunking(
      state.currentFile,
      state.language,
      state.promptHint,
      state.apiKey,
      state.transcribeModel,
      transcribeController.signal,
      function (segments, chunkIndex, totalChunks) {
        state.transcriptParagraphs = parseWhisperSegments(segments);
        state.transcriptText = buildTranscriptText(state.transcriptParagraphs);
        renderTranscriptTimeline();
        enableTranscriptWorkspace();
        showTranscribeProgress('청크 ' + chunkIndex + ' / ' + totalChunks + ' 완료', Math.round((chunkIndex / totalChunks) * 100));
      }
    );
    state.transcriptParagraphs = parseWhisperSegments(whisperData.segments || []);
    state.transcriptText = buildTranscriptText(state.transcriptParagraphs);
    state.transcriptSourceName = state.currentFile.name;

    renderTranscriptTimeline();
    enableTranscriptWorkspace();
    saveTranscriptCache();

    renderSummaryReadyState();
    setPlayerBadgeState('idle', '대기 중');
    elements.btnTranscribe.disabled = false;
    elements.btnCancelTranscribe.classList.add('hidden');
    hideTranscribeProgress();
    if (state.transcribeAbortController === transcribeController) {
      state.transcribeAbortController = null;
    }
    markSummaryAttention(!elements.paneSummary.classList.contains('active'));
    showToast('전사 완료! AI 정리 탭에서 확인하세요.');

    if (isBatchRun && state.batchRunning) {
      state.fileQueue[state.batchIndex].status = 'done';
      state.batchResults.push({
        name: state.currentFile.name,
        text: state.transcriptText,
        paragraphs: state.transcriptParagraphs
      });
      renderBatchQueue();
      if (state.batchIndex < state.fileQueue.length - 1) {
        state.batchIndex += 1;
        handleAudioImport(state.fileQueue[state.batchIndex].file, { preserveQueue: true });
        await triggerTranscribeAI({ fromBatch: true });
        return;
      }
      state.batchRunning = false;
      elements.btnTranscribe.disabled = false;
      elements.btnCancelTranscribe.classList.add('hidden');
      renderBatchQueue();
      showToast('배치 전사가 완료되었습니다.');
    }
  } catch (err) {
    console.error('Transcription failed:', err);
    if (state.transcribeAbortController === transcribeController) {
      state.transcribeAbortController = null;
    }
    setPlayerBadgeState('idle', '대기 중');
    elements.btnTranscribe.disabled = false;
    elements.btnCancelTranscribe.classList.add('hidden');
    hideTranscribeProgress();
    if (err && err.name === 'AbortError') {
      if (isBatchRun && state.fileQueue[state.batchIndex]) {
        state.fileQueue[state.batchIndex].status = 'ready';
        state.batchRunning = false;
        renderBatchQueue();
      }
      resetWorkspaceData();
      showToast('전사를 취소했습니다.');
      return;
    }
    if (isBatchRun && state.fileQueue[state.batchIndex]) {
      state.fileQueue[state.batchIndex].status = 'failed';
      state.batchRunning = false;
      renderBatchQueue();
    }
    resetWorkspaceData();
    showToast('AI 전사 오류: ' + err.message);
  }
}

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

function createSkeletonBlock(className) {
  var block = document.createElement('div');
  block.className = 'skeleton-block ' + className;
  return block;
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

  filtered.forEach(function (p) {
    var card = document.createElement('div');
    card.className = 'transcript-card';
    card.id = 'transcript-card-' + p.id;
    card.setAttribute('data-seconds', p.seconds);
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', p.time ? p.time + ' 전사 위치로 이동' : '전사 단락');

    var actions = document.createElement('div');
    actions.className = 'transcript-card-actions';
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
    elements.transcriptContainer.appendChild(card);
  });
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

function escapeHTML(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ==========================================================================
   Summary Hub
   ========================================================================== */

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
  if (!state.apiKey) {
    showToast('OpenAI API Key를 입력해주세요.');
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

  renderSummaryLoadingState();
  elements.btnCopySummary.disabled = true;
  elements.btnDownloadSummary.disabled = true;
  setSummaryBadgeRunning(true);

  try {
    var streamedText = '';
    state.summaryRequests[format] = generateSummary(state.transcriptText, format, state.apiKey, state.model, state.summaryPrompt, function (delta, fullText) {
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
  elements.summaryBadge.textContent = isRunning ? 'OpenAI GPT 분석 중...' : 'OpenAI GPT 분석';
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

  var avatar = document.createElement('div');
  avatar.className = 'chat-avatar';
  avatar.textContent = avatarText;

  var textPanel = document.createElement('div');
  textPanel.className = 'chat-text-panel';
  appendTextWithLineBreaks(textPanel, text);

  bubble.appendChild(avatar);
  bubble.appendChild(textPanel);
  elements.chatMessagesContainer.appendChild(bubble);
  elements.chatMessagesContainer.scrollTop = elements.chatMessagesContainer.scrollHeight;
  return id;
}

function appendTextWithLineBreaks(container, text) {
  String(text || '').split('\n').forEach(function (line, idx) {
    if (idx > 0) container.appendChild(document.createElement('br'));
    container.appendChild(document.createTextNode(line));
  });
}

function appendChatTypingIndicator() {
  var bubble = document.createElement('div');
  bubble.className = 'chat-bubble bot';
  bubble.id = 'bubble-typing';

  var avatar = document.createElement('div');
  avatar.className = 'chat-avatar';
  avatar.textContent = 'AI';

  var textPanel = document.createElement('div');
  textPanel.className = 'chat-text-panel chat-typing-panel';

  var indicator = document.createElement('div');
  indicator.className = 'typing-indicator';
  for (var i = 0; i < 3; i++) {
    var dot = document.createElement('div');
    dot.className = 'typing-dot';
    indicator.appendChild(dot);
  }

  textPanel.appendChild(indicator);
  bubble.appendChild(avatar);
  bubble.appendChild(textPanel);
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
  elements.btnImportTranscript.addEventListener('click', function () {
    elements.transcriptFileInput.click();
  });

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
  elements.btnGenerateChapters.disabled = false;
  elements.btnCopyTranscript.disabled = false;
  elements.btnDownloadTranscript.disabled = false;
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
