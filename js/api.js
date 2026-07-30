/* ==========================================================================
   API Functions
   ========================================================================== */

async function transcribeAudio(audioFile, language, apiKey, transcribeModel, signal, chunkContext) {
  var model = transcribeModel || 'gpt-4o-transcribe';
  var isLegacy = (model === 'whisper-1');

  var formData = new FormData();
  formData.append('file', audioFile, audioFile.name);
  formData.append('model', model);
  // whisper-1만 verbose_json + segment timestamps 지원
  formData.append('response_format', isLegacy ? 'verbose_json' : 'json');
  if (isLegacy) {
    formData.append('timestamp_granularities[]', 'segment');
    // 청크 간 문맥 연속성 (사용자 힌트 아님 — 이전 청크 마지막 30단어)
    if (chunkContext && chunkContext.trim()) {
      formData.append('prompt', chunkContext.trim());
    }
  } else {
    formData.append('chunking_strategy', 'auto');
  }

  if (language && language !== 'auto') {
    formData.append('language', language);
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



async function generateSummary(transcriptText, format, apiKey, model, customPrompt, onDelta) {
  var systemPrompt = SUMMARY_SYSTEM_PROMPTS[format] || SUMMARY_SYSTEM_PROMPTS.summary;
  if (customPrompt && customPrompt.trim()) {
    systemPrompt += '\n\n추가 사용자 지침:\n' + customPrompt.trim();
  }

  return enqueueOpenAITextRequest(async function () {
    if (isClaudeModel(model)) {
      var userContent = '다음 오디오 전사록을 분석하여 요청한 형식으로 정리해 주세요:\n\n---\n' + transcriptText + '\n---';
      var claudeBody = {
        model: model,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
        max_tokens: (SUMMARY_MAX_TOKENS[format] || 2000) * 2,
        output_config: { effort: 'low' }
      };

      if (typeof onDelta === 'function') {
        claudeBody.stream = true;
        return streamOpenAITextResponse(ANTHROPIC_API_BASE + '/messages', {
          method: 'POST',
          headers: anthropicHeaders(apiKey),
          body: JSON.stringify(claudeBody)
        }, onDelta, '요약 생성');
      }

      var claudeData = await fetchOpenAIJsonWithRetry(ANTHROPIC_API_BASE + '/messages', {
        method: 'POST',
        headers: anthropicHeaders(apiKey),
        body: JSON.stringify(claudeBody)
      }, '요약 생성');

      return extractAnthropicResponseText(claudeData);
    }

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
    if (isClaudeModel(model)) {
      var claudeData = await fetchOpenAIJsonWithRetry(ANTHROPIC_API_BASE + '/messages', {
        method: 'POST',
        headers: anthropicHeaders(apiKey),
        body: JSON.stringify({
          model: model,
          system: systemPrompt,
          messages: [{ role: 'user', content: '다음 전사록의 시간대를 참고해 챕터를 생성하세요:\n\n---\n' + transcriptText + '\n---' }],
          max_tokens: 2400,
          output_config: { effort: 'low' }
        })
      }, '챕터 생성');
      return extractAnthropicResponseText(claudeData);
    }

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
  var claudeMessages = [];

  for (var i = 0; i < chatHistory.length; i++) {
    var msg = chatHistory[i];
    messages.push({ role: msg.role === 'model' ? 'assistant' : 'user', content: msg.text });
    responseInput.push({ role: msg.role === 'model' ? 'assistant' : 'user', content: msg.text });
    claudeMessages.push({ role: msg.role === 'model' ? 'assistant' : 'user', content: msg.text });
  }
  messages.push({ role: 'user', content: userQuery });
  responseInput.push({ role: 'user', content: userQuery });
  claudeMessages.push({ role: 'user', content: userQuery });

  return enqueueOpenAITextRequest(async function () {
    if (isClaudeModel(model)) {
      var claudeData = await fetchOpenAIJsonWithRetry(ANTHROPIC_API_BASE + '/messages', {
        method: 'POST',
        headers: anthropicHeaders(apiKey),
        body: JSON.stringify({
          model: model,
          system: instructions,
          messages: claudeMessages,
          max_tokens: 3000,
          output_config: { effort: 'low' }
        })
      }, 'Q&A 답변');

      return extractAnthropicResponseText(claudeData);
    }

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
  return RESPONSE_API_MODEL_PATTERN.test(model || '');
}



function isClaudeModel(model) {
  return CLAUDE_MODEL_PATTERN.test(model || '');
}



function selectedTextApiKey() {
  return isClaudeModel(state.model) ? state.anthropicApiKey : state.apiKey;
}



function selectedTextProviderName() {
  return isClaudeModel(state.model) ? 'Anthropic API Key' : 'OpenAI API Key';
}



function anthropicHeaders(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    'Content-Type': 'application/json'
  };
}



function extractAnthropicResponseText(data) {
  if (!data || !Array.isArray(data.content)) return '';
  return data.content.map(function (part) {
    return typeof part.text === 'string' ? part.text : '';
  }).join('').trim();
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
      if (event.type === 'content_block_delta' && event.delta && typeof event.delta.text === 'string') return event.delta.text;
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

