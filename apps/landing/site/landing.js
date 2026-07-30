(function () {
  var config = window.__BT_LANDING__ || {};
  var webOrigin = config.webOrigin || '';

  if (webOrigin) {
    var links = document.querySelectorAll('.js-web-link');
    for (var index = 0; index < links.length; index++) {
      links[index].setAttribute('href', webOrigin);
    }
  }

  // Product pages mirror the active registration mode. Mobile pages have no
  // registration CTA, so they stop after updating the web-app link above.
  var registerCta = document.querySelector('.js-register-cta');
  var inviteNote = document.querySelector('.invite-note');
  var apiOrigin = config.apiOrigin || '';
  if ((!registerCta && !inviteNote) || !apiOrigin) return;

  // Best effort: any failure leaves the closed, invite-only default untouched.
  fetch(apiOrigin + '/api/v1/auth/registration-info')
    .then(function (response) {
      return response.ok ? response.json() : null;
    })
    .then(function (info) {
      if (!info || !info.mode || info.mode === 'closed') return;
      if (registerCta) {
        if (webOrigin) registerCta.setAttribute('href', webOrigin + '/register');
        registerCta.hidden = false;
      }
      if (inviteNote) inviteNote.hidden = true;
    })
    .catch(function () {});
})();
