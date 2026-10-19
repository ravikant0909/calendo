// Calendo AI Chat Widget
// Embeddable chat component for booking pages

export function initChatWidget(containerEl, bookingPageSlug) {
  let sessionId = localStorage.getItem(`calendo_chat_${bookingPageSlug}`) || null;
  let isOpen = false;
  let messages = [];

  // Create widget HTML
  const widget = document.createElement('div');
  widget.innerHTML = `
    <div class="calendo-chat-toggle" id="chatToggle">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <span>Chat with AI</span>
    </div>
    <div class="calendo-chat-panel" id="chatPanel" style="display:none">
      <div class="calendo-chat-header">
        <div>
          <strong>Calendo AI</strong>
          <span class="calendo-chat-subtitle">Scheduling assistant</span>
        </div>
        <button class="calendo-chat-close" id="chatClose">&times;</button>
      </div>
      <div class="calendo-chat-messages" id="chatMessages">
        <div class="calendo-chat-msg assistant">
          <p>Hi! I can help you find the perfect time to meet. What are you looking for?</p>
        </div>
      </div>
      <div class="calendo-chat-input-wrap">
        <input type="text" id="chatInput" placeholder="e.g. &quot;I need a 30 min call next week&quot;" autocomplete="off">
        <button id="chatSend" class="calendo-chat-send">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    </div>
  `;
  containerEl.appendChild(widget);

  // Add styles
  const style = document.createElement('style');
  style.textContent = `
    .calendo-chat-toggle {
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      background: #2563eb; color: #fff; border: none; border-radius: 50px;
      padding: 12px 20px; cursor: pointer; display: flex; align-items: center; gap: 8px;
      font-size: 14px; font-weight: 600; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      box-shadow: 0 4px 12px rgba(37,99,235,0.4); transition: transform 0.15s, box-shadow 0.15s;
    }
    .calendo-chat-toggle:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(37,99,235,0.5); }
    .calendo-chat-panel {
      position: fixed; bottom: 80px; right: 24px; z-index: 9999;
      width: 380px; max-height: 520px; background: #fff; border-radius: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.15); display: flex; flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      overflow: hidden; animation: calendo-slide-up 0.2s ease-out;
    }
    @keyframes calendo-slide-up { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .calendo-chat-header {
      padding: 16px 20px; border-bottom: 1px solid #e2e8f0;
      display: flex; align-items: center; justify-content: space-between;
    }
    .calendo-chat-header strong { display: block; font-size: 15px; }
    .calendo-chat-subtitle { font-size: 12px; color: #64748b; }
    .calendo-chat-close { background: none; border: none; font-size: 22px; cursor: pointer; color: #94a3b8; padding: 0 4px; }
    .calendo-chat-messages {
      flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px;
      min-height: 300px; max-height: 360px;
    }
    .calendo-chat-msg { max-width: 85%; }
    .calendo-chat-msg p {
      padding: 10px 14px; border-radius: 16px; font-size: 14px; line-height: 1.5; margin: 0;
      white-space: pre-wrap; word-wrap: break-word;
    }
    .calendo-chat-msg.assistant { align-self: flex-start; }
    .calendo-chat-msg.assistant p { background: #f1f5f9; color: #1e293b; border-bottom-left-radius: 4px; }
    .calendo-chat-msg.user { align-self: flex-end; }
    .calendo-chat-msg.user p { background: #2563eb; color: #fff; border-bottom-right-radius: 4px; }
    .calendo-chat-msg.typing p { color: #94a3b8; font-style: italic; }
    .calendo-chat-input-wrap {
      padding: 12px 16px; border-top: 1px solid #e2e8f0; display: flex; gap: 8px;
    }
    .calendo-chat-input-wrap input {
      flex: 1; padding: 10px 14px; border: 1px solid #d1d5db; border-radius: 24px;
      font-size: 14px; outline: none; font-family: inherit;
    }
    .calendo-chat-input-wrap input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
    .calendo-chat-send {
      width: 38px; height: 38px; border-radius: 50%; background: #2563eb; color: #fff;
      border: none; cursor: pointer; display: flex; align-items: center; justify-content: center;
    }
    .calendo-chat-send:hover { background: #1d4ed8; }
    .calendo-chat-send:disabled { opacity: 0.5; cursor: not-allowed; }
    @media (max-width: 480px) {
      .calendo-chat-panel { width: calc(100vw - 32px); right: 16px; bottom: 72px; }
      .calendo-chat-toggle { bottom: 16px; right: 16px; }
    }
  `;
  document.head.appendChild(style);

  // Event handlers
  const toggle = document.getElementById('chatToggle');
  const panel = document.getElementById('chatPanel');
  const closeBtn = document.getElementById('chatClose');
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('chatSend');
  const messagesEl = document.getElementById('chatMessages');

  toggle.addEventListener('click', () => {
    isOpen = !isOpen;
    panel.style.display = isOpen ? 'flex' : 'none';
    toggle.style.display = isOpen ? 'none' : 'flex';
    if (isOpen) input.focus();
  });

  closeBtn.addEventListener('click', () => {
    isOpen = false;
    panel.style.display = 'none';
    toggle.style.display = 'flex';
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    sendBtn.disabled = true;

    // Add user message to UI
    addMessage('user', text);

    // Show typing indicator
    const typingEl = addMessage('assistant typing', '...');

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          booking_page_slug: bookingPageSlug,
          session_id: sessionId,
          message: text,
        }),
      });

      const data = await res.json();
      sessionId = data.session_id;
      localStorage.setItem(`calendo_chat_${bookingPageSlug}`, sessionId);

      // Remove typing indicator
      typingEl.remove();

      // Add AI response
      addMessage('assistant', data.message);

      // Handle actions
      if (data.action) {
        handleAction(data.action, data.event_types);
      }
    } catch (err) {
      typingEl.remove();
      addMessage('assistant', 'Sorry, something went wrong. Please try again or use the booking form above.');
    } finally {
      sendBtn.disabled = false;
    }
  }

  function addMessage(type, text) {
    const msg = document.createElement('div');
    msg.className = `calendo-chat-msg ${type}`;
    msg.innerHTML = `<p>${escapeHtml(text)}</p>`;
    messagesEl.appendChild(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return msg;
  }

  function handleAction(action, eventTypes) {
    if (action.type === 'show_event_types' && eventTypes) {
      const html = eventTypes.map(et =>
        `<button class="calendo-chat-et-btn" data-slug="${et.slug}" style="border-left:3px solid ${et.color}">${et.name} (${et.duration_minutes} min)</button>`
      ).join('');
      const container = document.createElement('div');
      container.className = 'calendo-chat-msg assistant';
      container.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px">${html}</div>`;
      container.querySelectorAll('.calendo-chat-et-btn').forEach(btn => {
        btn.style.cssText = 'background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px;cursor:pointer;text-align:left;font-size:13px;font-family:inherit;';
        btn.addEventListener('click', () => {
          input.value = `I'd like to book a "${btn.textContent.split('(')[0].trim()}"`;
          sendMessage();
        });
      });
      messagesEl.appendChild(container);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
