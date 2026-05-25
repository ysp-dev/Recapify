/* ==========================================================================
   Chat Q&A Workspace
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


