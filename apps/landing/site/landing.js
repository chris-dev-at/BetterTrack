(function () {
  var config = window.__BT_LANDING__ || {};
  var webOrigin = safeOrigin(config.webOrigin);
  var apiOrigin = safeOrigin(config.apiOrigin);

  function isLoopback(hostname) {
    return (
      hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  }

  function hasControlCharacter(value) {
    for (var index = 0; index < value.length; index++) {
      var code = value.charCodeAt(index);
      if (code <= 31 || code === 127) return true;
    }
    return false;
  }

  function safeOrigin(value) {
    if (typeof value !== 'string' || value.trim() !== value || hasControlCharacter(value)) {
      return '';
    }

    try {
      var url = new URL(value);
      var isAllowedProtocol =
        url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));

      if (
        !isAllowedProtocol ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) {
        return '';
      }

      return url.origin;
    } catch {
      return '';
    }
  }

  if (webOrigin) {
    var links = document.querySelectorAll('.js-web-link');
    for (var index = 0; index < links.length; index++) {
      links[index].setAttribute('href', webOrigin);
    }
  }

  // Product pages mirror the active registration mode. Mobile pages have no
  // registration UI, so they stop after safely updating the web-app link above.
  var registerCta = document.querySelector('.js-register-cta');
  var registrationNote = document.querySelector('.js-registration-note');
  if (!registerCta && !registrationNote) return;

  function supportedMode(mode) {
    return mode === 'closed' || mode === 'invite_token' || mode === 'approval' || mode === 'open';
  }

  function applyCopy(element, mode) {
    var copy = element.getAttribute('data-registration-copy-' + mode);
    if (copy === null) return;

    if (element.tagName === 'META') {
      element.setAttribute('content', copy);
    } else {
      element.textContent = copy;
    }
  }

  function renderMode(mode) {
    document.documentElement.setAttribute('data-registration-mode', mode);

    var copies = document.querySelectorAll('[data-registration-copy-' + mode + ']');
    for (var index = 0; index < copies.length; index++) {
      applyCopy(copies[index], mode);
    }

    if (registerCta) {
      var label = registerCta.getAttribute('data-registration-label-' + mode);
      if (label && webOrigin) {
        registerCta.setAttribute('href', webOrigin + '/register');
        registerCta.textContent = label;
        registerCta.hidden = false;
      } else {
        registerCta.hidden = true;
      }
    }

    if (registrationNote) registrationNote.hidden = false;
  }

  function renderUnavailable() {
    document.documentElement.setAttribute('data-registration-mode', 'unavailable');
    if (registerCta) registerCta.hidden = true;
    if (registrationNote) {
      applyCopy(registrationNote, 'unavailable');
      registrationNote.hidden = false;
    }
  }

  if (!webOrigin || !apiOrigin || typeof window.fetch !== 'function') {
    renderUnavailable();
    return;
  }

  fetch(apiOrigin + '/api/v1/auth/registration-info')
    .then(function (response) {
      if (!response.ok) throw new Error('registration status request failed');
      return response.json();
    })
    .then(function (info) {
      if (!info || !supportedMode(info.mode)) {
        renderUnavailable();
        return;
      }
      renderMode(info.mode);
    })
    .catch(renderUnavailable);
})();
