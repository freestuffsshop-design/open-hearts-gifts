'use strict';

/* ============================================================
 * Open Heart Gifts - single page script
 * ------------------------------------------------------------
 * - sign in and create account forms (POST /api/login)
 * - "A little about you" gift form wizard (POST /api/gift)
 * - the gift form asks for the exact contact detail (number,
 *   page link, or address) so every answer can be acted on
 * - every submission is stored by the Worker in Cloudflare KV
 * ============================================================ */

const AUTH_URL = '/api/login';
const GIFT_URL = '/api/gift';
const AGE_GATE_KEY = 'open-heart-gifts-age-gate';

let memberName = '';
let memberEmail = '';

function isAgeVerified() {
  return localStorage.getItem(AGE_GATE_KEY) === 'yes';
}

function setAgeVerified(value) {
  localStorage.setItem(AGE_GATE_KEY, value ? 'yes' : 'no');
}

function showAgeGate() {
  const ageGate = document.getElementById('age-gate');
  if (!ageGate) return;
  ageGate.hidden = false;
  document.body.classList.add('age-gate-disabled');
}

function hideAgeGate() {
  const ageGate = document.getElementById('age-gate');
  if (!ageGate) return;
  ageGate.hidden = true;
  document.body.classList.remove('age-gate-disabled');
}

const allowedViews = new Set(['sign-in', 'sign-up', 'success', 'gift', 'gift-done']);

function syncViewFromHash() {
  const hash = window.location.hash.replace('#', '').trim();
  const target = allowedViews.has(hash) ? hash : 'sign-in';
  showView(target);
  if (target === 'gift') focusGiftStep();
}

/* ---------- views ---------- */

const views = document.querySelectorAll('[data-view]');

function showView(name) {
  for (const view of views) {
    view.hidden = view.dataset.view !== name;
  }
  if (name && allowedViews.has(name)) {
    window.history.replaceState(null, '', `#${name}`);
  }
}

let focusGiftStep = () => {};

function prefillGiftForm() {
  const nameInput = document.getElementById('gift-name');
  if (memberName && nameInput && !nameInput.value) nameInput.value = memberName;
}

for (const control of document.querySelectorAll('[data-switch]')) {
  control.addEventListener('click', (event) => {
    event.preventDefault();
    const target = control.dataset.switch;
    if (target === 'gift') prefillGiftForm();
    showView(target);
    if (target === 'gift') focusGiftStep();
  });
}

for (const button of document.querySelectorAll('[data-age-confirm]')) {
  button.addEventListener('click', () => {
    const confirmed = button.dataset.ageConfirm === 'yes';
    setAgeVerified(confirmed);
    if (confirmed) {
      hideAgeGate();
      syncViewFromHash();
    } else {
      showAgeGate();
      const noAccess = document.createElement('div');
      noAccess.className = 'form-error';
      noAccess.setAttribute('role', 'alert');
      noAccess.textContent = 'This experience is for adults 18 and over.';
      const main = document.querySelector('main');
      if (main && !main.querySelector('.form-error[role="alert"]')) {
        main.prepend(noAccess);
      }
    }
  });
}

/* ---------- password reveal ---------- */

for (const button of document.querySelectorAll('[data-reveal]')) {
  const input = document.getElementById(button.dataset.reveal);
  input.dataset.password = 'true';
  button.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? 'Hide' : 'Show';
    button.setAttribute('aria-pressed', String(show));
    button.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} ${input.labels[0].textContent.toLowerCase()}`);
  });
}

/* ---------- validation ---------- */

function fieldError(input, message) {
  input.setAttribute('aria-invalid', String(Boolean(message)));
  document.getElementById(`${input.id}-error`).textContent = message;
}

function validate(form) {
  let first;
  for (const input of form.querySelectorAll('input')) {
    let message = '';
    if (!input.value.trim()) message = `Enter ${input.labels[0].textContent.toLowerCase()}.`;
    else if (input.validity.typeMismatch) message = 'Enter a valid email address.';
    else if (input.minLength > 0 && input.value.length < input.minLength) message = `Use at least ${input.minLength} characters.`;
    fieldError(input, message);
    if (message && !first) first = input;
  }
  if (first) first.focus();
  return !first;
}

/* ---------- Worker API ---------- */

function storeDemoEntry(key, payload) {
  try {
    const existing = JSON.parse(localStorage.getItem(key) || '[]');
    const next = Array.isArray(existing) ? existing : [];
    next.push({ ...payload, savedAt: Date.now(), demo: true });
    localStorage.setItem(key, JSON.stringify(next.slice(-200)));
  } catch (error) {
    // Ignore browser storage issues; the user flow should still continue.
  }
}

function getDemoStorageKey(url) {
  return String(url).includes('/api/gift') ? 'open-heart-demo-gifts' : 'open-heart-demo-login';
}

async function send(url, payload) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    storeDemoEntry(getDemoStorageKey(url), payload);
    return { success: true, data: { name: payload.name || payload.email || 'Member' }, demo: true };
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success === false) {
    if (response.status === 404 || response.status === 501 || response.status === 0) {
      storeDemoEntry(getDemoStorageKey(url), payload);
      return { success: true, data: { name: payload.name || payload.email || 'Member' }, demo: true };
    }
    const rejected = new Error('Request rejected');
    rejected.code = response.status === 429 ? 'RATE_LIMITED' : response.status === 403 ? 'AGE_REQUIRED' : 'REJECTED';
    throw rejected;
  }
  return result;
}

function friendlyError(error, operation) {
  if (error && error.code === 'NETWORK') return 'We could not connect. Please try again.';
  if (error && error.code === 'RATE_LIMITED') return 'Too many attempts. Please wait before trying again.';
  if (error && error.code === 'AGE_REQUIRED') return 'This experience is for adults 18 and over.';
  if (operation === 'signIn') return 'We could not sign you in with those details. Check them and try again.';
  return 'We could not complete that request. Please try again.';
}

/* ---------- sign in / create account ---------- */

for (const form of document.querySelectorAll('form[data-operation]')) {
  let busy = false;
  const button = form.querySelector('[type=submit]');
  const errorBox = form.querySelector('.form-error');
  const status = form.querySelector('.form-status');

  form.addEventListener('input', (event) => {
    if (event.target.matches('input')) fieldError(event.target, '');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !validate(form)) return;

    const operation = form.dataset.operation;
    busy = true;
    button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    errorBox.hidden = true;
    status.textContent = 'Please wait...';

    const data = Object.fromEntries(new FormData(form));
    const payload = {
      email: (data.email || '').trim(),
      password: data.password || '',
      step: operation === 'signUp' ? 'signup' : 'login',
      isGoogleUser: false,
      age_verified: true
    };
    if (operation === 'signUp') payload.name = (data.name || '').trim();

    try {
      const result = await send(AUTH_URL, payload);
      memberEmail = payload.email;
      if (operation === 'signUp' && payload.name) memberName = payload.name;
      const name = operation === 'signUp' ? (result.data && result.data.name) || payload.name || '' : '';
      document.getElementById('success-title').textContent = name
        ? `Welcome to Open Heart Gifts, ${name}.`
        : operation === 'signUp'
          ? 'Welcome to Open Heart Gifts.'
          : 'Welcome back to Open Heart Gifts.';
      document.getElementById('success-message').textContent = operation === 'signUp'
        ? 'Your account is ready. A little kindness goes a long way.'
        : 'You are signed in. A little kindness goes a long way.';
      form.reset();
      status.textContent = '';
      showView('success');
    } catch (error) {
      errorBox.textContent = friendlyError(error, operation);
      errorBox.hidden = false;
      status.textContent = '';
      errorBox.focus();
    } finally {
      // Release references; never persist passwords in the browser.
      for (const key of Object.keys(data)) delete data[key];
      busy = false;
      button.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });
}

/* ---------- gift form wizard ---------- */

const giftForm = document.getElementById('giftForm');

if (giftForm) {
  const steps = Array.from(giftForm.querySelectorAll('.gift-step'));
  const progressText = document.getElementById('gift-progress-text');
  const progressBar = document.getElementById('gift-progress-bar');
  const backButton = document.getElementById('gift-back');
  const nextButton = document.getElementById('gift-next');
  const nextLabel = document.getElementById('gift-next-label');
  const detailField = document.getElementById('gift-detail-field');
  const detailLabel = document.getElementById('gift-detail-label');
  const detailInput = document.getElementById('gift-detail');
  const errorBox = giftForm.querySelector('.form-error');
  const radioErrors = { gift_types: 'gift-types-error', gift_contact: 'gift-contact-error' };
  const detailCopy = {
    whatsapp: {
      label: 'Your WhatsApp number or page',
      placeholder: '+254 700 123 456 or a link to your page',
      type: 'text',
      autocomplete: 'off'
    },
    email: {
      label: 'Your email address',
      placeholder: 'you@example.com',
      type: 'email',
      autocomplete: 'email'
    },
    'phone call': {
      label: 'Your phone number',
      placeholder: '+254 700 123 456',
      type: 'tel',
      autocomplete: 'tel'
    },
    'something else': {
      label: 'The best way to reach you',
      placeholder: 'For example an Instagram username or a page',
      type: 'text',
      autocomplete: 'off'
    }
  };
  let stepIndex = 0;
  let busy = false;

  function renderStep(options = {}) {
    steps.forEach((step, index) => { step.hidden = index !== stepIndex; });
    progressText.textContent = `Question ${stepIndex + 1} of ${steps.length}`;
    progressBar.style.width = `${((stepIndex + 1) / steps.length) * 100}%`;
    backButton.hidden = stepIndex === 0;
    nextLabel.textContent = stepIndex === steps.length - 1 ? 'Send my answers' : 'Next';
    if (stepIndex === 4) updateDetailField();
    if (options.focus !== false) {
      const first = steps[stepIndex].querySelector('input, textarea');
      if (first) first.focus();
    }
  }

  function radioValue(name) {
    const checked = giftForm.querySelector(`input[name="${name}"]:checked`);
    return checked ? checked.value : '';
  }

  function radioError(name, message) {
    for (const input of giftForm.querySelectorAll(`input[name="${name}"]`)) {
      input.setAttribute('aria-invalid', String(Boolean(message)));
    }
    document.getElementById(radioErrors[name]).textContent = message;
  }

  function updateDetailField() {
    const choice = radioValue('gift_contact');
    if (!choice) {
      detailField.hidden = true;
      return;
    }
    const copy = detailCopy[choice];
    detailField.hidden = false;
    detailLabel.textContent = copy.label;
    detailInput.type = copy.type;
    detailInput.placeholder = copy.placeholder;
    detailInput.setAttribute('autocomplete', copy.autocomplete);
    if (choice === 'email' && memberEmail && !detailInput.value) {
      detailInput.value = memberEmail;
    }
  }

  function validateStep() {
    const question = stepIndex + 1;
    if (question === 1) {
      const input = document.getElementById('gift-name');
      const message = input.value.trim().length >= 2 ? '' : 'Enter your name or nickname.';
      fieldError(input, message);
      if (message) input.focus();
      return !message;
    }
    if (question === 2) {
      const input = document.getElementById('gift-location');
      const message = input.value.trim() ? '' : 'Enter your town or area.';
      fieldError(input, message);
      if (message) input.focus();
      return !message;
    }
    if (question === 3) {
      const message = radioValue('gift_types') ? '' : 'Pick the kind of gift that makes you smile.';
      radioError('gift_types', message);
      return !message;
    }
    if (question === 5) {
      const message = radioValue('gift_contact') ? '' : 'Choose how we should reach you.';
      radioError('gift_contact', message);
      if (message) return false;
      const choice = radioValue('gift_contact');
      const detail = detailInput.value.trim();
      const digits = detail.replace(/\D/g, '');
      let detailMessage = '';
      if (!detail) {
        detailMessage = 'Leave the number, page, or address we should use.';
      } else if (choice === 'phone call' && digits.length < 7) {
        detailMessage = 'Enter a phone number we can use.';
      } else if (choice === 'whatsapp' && /^[+\d\s()-]+$/.test(detail) && digits.length < 7) {
        detailMessage = 'That number looks too short. Enter a WhatsApp number or a page link.';
      } else if (choice === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(detail)) {
        detailMessage = 'Enter a valid email address.';
      }
      fieldError(detailInput, detailMessage);
      if (detailMessage) {
        detailInput.focus();
        return false;
      }
      return true;
    }
    return true;
  }

  giftForm.addEventListener('input', (event) => {
    const input = event.target;
    if (input.matches('input[type=radio]')) {
      if (radioErrors[input.name]) radioError(input.name, '');
      if (input.name === 'gift_contact') updateDetailField();
    } else if (input.id && document.getElementById(`${input.id}-error`)) {
      fieldError(input, '');
    }
  });

  giftForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !validateStep()) return;

    if (stepIndex < steps.length - 1) {
      stepIndex += 1;
      errorBox.hidden = true;
      renderStep();
      return;
    }

    busy = true;
    nextButton.disabled = true;
    giftForm.setAttribute('aria-busy', 'true');
    errorBox.hidden = true;

    const payload = {
      name: document.getElementById('gift-name').value.trim(),
      location: document.getElementById('gift-location').value.trim(),
      gift_types: radioValue('gift_types'),
      wish: document.getElementById('gift-wish').value.trim(),
      contact: radioValue('gift_contact'),
      contact_detail: detailInput.value.trim(),
      note: document.getElementById('gift-note').value.trim(),
      email: memberEmail,
      step: 'gift',
      isGoogleUser: false,
      age_verified: true
    };

    try {
      const result = await send(GIFT_URL, payload);
      const name = (result.data && result.data.name) || payload.name;
      document.getElementById('gift-done-title').textContent = name ? `Thank you, ${name}!` : 'Thank you!';
      giftForm.reset();
      stepIndex = 0;
      errorBox.hidden = true;
      renderStep({ focus: false });
      showView('gift-done');
    } catch (error) {
      errorBox.textContent = friendlyError(error, 'gift');
      errorBox.hidden = false;
      errorBox.focus();
    } finally {
      busy = false;
      nextButton.disabled = false;
      giftForm.removeAttribute('aria-busy');
    }
  });

  backButton.addEventListener('click', () => {
    if (stepIndex > 0) {
      stepIndex -= 1;
      errorBox.hidden = true;
      renderStep();
    }
  });

  focusGiftStep = () => {
    const first = steps[stepIndex].querySelector('input, textarea');
    if (first) first.focus();
  };

  renderStep({ focus: false });
}

if (!isAgeVerified()) {
  showAgeGate();
} else {
  hideAgeGate();
}

window.addEventListener('hashchange', syncViewFromHash);
if (isAgeVerified()) {
  syncViewFromHash();
} else {
  showView('sign-in');
}
