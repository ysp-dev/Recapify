/**
 * ==========================================================================
 * OpenAI API Integration Module
 * - Transcription: GPT-4o Transcribe, GPT-4o mini Transcribe, Whisper fallback
 * - Summary & Chat: GPT-5.5 via Responses API, GPT-4.1 fallback via Chat Completions
 * ==========================================================================
 */

const OPENAI_API_BASE = 'https://api.openai.com/v1';

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

/**
 * Transcribe audio file using OpenAI speech-to-text models
 * @param {File} audioFile - The audio File object
 * @param {string} language - Language code (e.g., 'ko', 'en') or 'auto'
 * @param {string} promptHint - Optional transcription hint/vocabulary
 * @param {string} apiKey - OpenAI API key
 * @param {string} transcribeModel - Speech-to-text model ID
 * @returns {Promise<{text: string, segments: Array}>}
 */
export async function transcribeAudio(audioFile, language, promptHint, apiKey, transcribeModel = 'gpt-4o-transcribe') {
  const isLegacy = transcribeModel === 'whisper-1';
  const formData = new FormData();
  formData.append('file', audioFile, audioFile.name);
  formData.append('model', transcribeModel);
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

  const response = await fetch(`${OPENAI_API_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`
    },
    body: formData
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `전사 API 오류: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (isLegacy) return data;

  const text = data.text || '';
  const parts = text.match(/[^.!?。\n]+[.!?。\n]*/g) || (text ? [text] : []);
  return {
    text,
    segments: parts.map((part) => ({ start: null, text: part.trim() })).filter((part) => part.text.length > 0)
  };
}

/**
 * Generate structured summary using OpenAI text generation models
 * @param {string} transcriptText - Full transcript text
 * @param {string} format - Summary format key (summary/minutes/notes/qa/email)
 * @param {string} apiKey - OpenAI API key
 * @param {string} model - GPT model ID (e.g., 'gpt-5.5')
 * @returns {Promise<string>} Markdown-formatted summary
 */
export async function generateSummary(transcriptText, format, apiKey, model = 'gpt-5.5') {
  const systemPrompt = SUMMARY_SYSTEM_PROMPTS[format] || SUMMARY_SYSTEM_PROMPTS.summary;

  if (isResponsesModel(model)) {
    const response = await fetch(`${OPENAI_API_BASE}/responses`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        instructions: systemPrompt,
        input: `다음 오디오 전사록을 분석하여 요청한 형식으로 정리해 주세요:\n\n---\n${transcriptText}\n---`,
        reasoning: { effort: 'low' },
        text: { verbosity: 'low' },
        max_output_tokens: 2500,
        store: false
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `GPT API 오류: ${response.status}`);
    }

    const data = await response.json();
    return extractOpenAIResponseText(data);
  }

  const response = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `다음 오디오 전사록을 분석하여 요청한 형식으로 정리해 주세요:\n\n---\n${transcriptText}\n---`
        }
      ],
      temperature: 0.7,
      max_tokens: 2500
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `GPT API 오류: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

/**
 * Answer questions about the transcript using OpenAI text generation models
 * @param {string} transcriptText - Full transcript text
 * @param {string} userQuery - User's question
 * @param {Array} chatHistory - Chat history [{role, text}]
 * @param {string} apiKey - OpenAI API key
 * @param {string} model - GPT model ID
 * @returns {Promise<string>} AI response
 */
export async function askChatAboutTranscript(transcriptText, userQuery, chatHistory, apiKey, model = 'gpt-5.5') {
  const instructions = `당신은 전문 오디오 콘텐츠 어시스턴트입니다. 아래 오디오 전사록을 완전히 이해하고 있으며, 사용자의 질문에 전사록 내용을 기반으로 정확하고 친절하게 답변합니다. 전사록에 없는 내용은 추측하지 마세요.

[오디오 전사록]
---
${transcriptText}
---`;

  const messages = [
    {
      role: 'system',
      content: instructions
    }
  ];
  const responseInput = [];

  for (const msg of chatHistory) {
    const message = {
      role: msg.role === 'model' ? 'assistant' : 'user',
      content: msg.text
    };
    messages.push(message);
    responseInput.push(message);
  }

  messages.push({ role: 'user', content: userQuery });
  responseInput.push({ role: 'user', content: userQuery });

  if (isResponsesModel(model)) {
    const response = await fetch(`${OPENAI_API_BASE}/responses`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        instructions,
        input: responseInput,
        reasoning: { effort: 'low' },
        text: { verbosity: 'low' },
        max_output_tokens: 1200,
        store: false
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `GPT API 오류: ${response.status}`);
    }

    const data = await response.json();
    return extractOpenAIResponseText(data);
  }

  const response = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: messages,
      temperature: 0.7,
      max_tokens: 1200
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `GPT API 오류: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

function isResponsesModel(model) {
  return /^gpt-5(\.|-|$)/.test(model || '');
}

function extractOpenAIResponseText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string') return data.output_text;

  const parts = [];
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (typeof item.text === 'string') parts.push(item.text);
      if (Array.isArray(item.content)) {
        for (const contentPart of item.content) {
          if (typeof contentPart.text === 'string') {
            parts.push(contentPart.text);
          } else if (typeof contentPart.content === 'string') {
            parts.push(contentPart.content);
          }
        }
      }
    }
  }

  return parts.join('').trim();
}
