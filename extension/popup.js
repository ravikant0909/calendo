document.addEventListener('DOMContentLoaded', () => {
  const linkInput = document.getElementById('booking-link');
  const saveBtn = document.getElementById('save-btn');
  const copyBtn = document.getElementById('copy-btn');
  const status = document.getElementById('status');
  const currentLink = document.getElementById('current-link');
  const savedUrl = document.getElementById('saved-url');

  // Load saved link on popup open
  chrome.storage.sync.get(['calendoBookingLink'], (result) => {
    if (result.calendoBookingLink) {
      linkInput.value = result.calendoBookingLink;
      showSavedLink(result.calendoBookingLink);
    }
  });

  // Save link
  saveBtn.addEventListener('click', () => {
    const link = linkInput.value.trim();
    if (!link) {
      showStatus('Please enter a booking link', true);
      return;
    }
    if (!isValidCalendoLink(link)) {
      showStatus('Please enter a valid Calendo booking URL', true);
      return;
    }
    chrome.storage.sync.set({ calendoBookingLink: link }, () => {
      showStatus('Link saved!');
      showSavedLink(link);
    });
  });

  // Copy link to clipboard
  copyBtn.addEventListener('click', () => {
    const link = linkInput.value.trim();
    if (!link) {
      showStatus('No link to copy', true);
      return;
    }
    navigator.clipboard.writeText(link).then(() => {
      showStatus('Copied to clipboard!');
    }).catch(() => {
      showStatus('Failed to copy', true);
    });
  });

  function isValidCalendoLink(link) {
    try {
      const url = new URL(link);
      return url.hostname === 'calendo.dev' && url.pathname.startsWith('/booking/');
    } catch {
      return false;
    }
  }

  function showStatus(message, isError) {
    status.textContent = message;
    status.style.color = isError ? '#dc2626' : '#16a34a';
    setTimeout(() => {
      status.textContent = '';
    }, 3000);
  }

  function showSavedLink(link) {
    savedUrl.textContent = link;
    currentLink.style.display = 'block';
  }
});
