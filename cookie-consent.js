(function () {
  var KEY = 'pufahl_consent';

  function get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function set(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  function remove() { try { localStorage.removeItem(KEY); } catch (e) {} }

  function loadMaps() {
    document.querySelectorAll('iframe[data-maps-src]').forEach(function (f) {
      f.src = f.getAttribute('data-maps-src');
      f.removeAttribute('data-maps-src');
    });
    document.querySelectorAll('.pf-map-block').forEach(function (b) { b.remove(); });
  }

  function showMapBlock() {
    document.querySelectorAll('iframe[data-maps-src]').forEach(function (f) {
      var w = f.parentElement;
      if (!w || w.querySelector('.pf-map-block')) return;
      if (getComputedStyle(w).position === 'static') w.style.position = 'relative';
      var d = document.createElement('div');
      d.className = 'pf-map-block';
      d.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.75rem;background:#12151D;color:#9b988f;font-size:.82rem;text-align:center;padding:1.25rem;font-family:Manrope,sans-serif';
      d.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" style="width:28px;height:28px;opacity:.35" aria-hidden="true"><path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>'
        + '<span>Google Maps wurde nicht geladen.<br>Bitte passen Sie die Cookie-Einstellungen an.</span>'
        + '<button onclick="window.pfConsent.revoke()" style="padding:.35rem 1rem;border:1px solid rgba(236,239,241,.2);border-radius:6px;background:transparent;color:#D4AF5A;cursor:pointer;font-size:.78rem">Einstellungen ändern</button>';
      w.appendChild(d);
    });
  }

  function removeBanner() {
    var b = document.getElementById('pf-cookie-banner');
    if (b) b.remove();
  }

  function accept() { set('accepted'); removeBanner(); loadMaps(); }
  function decline() { set('declined'); removeBanner(); showMapBlock(); }
  function revoke() { remove(); location.reload(); }

  window.pfConsent = { accept: accept, decline: decline, revoke: revoke };

  var saved = get();
  if (saved === 'accepted') { document.addEventListener('DOMContentLoaded', loadMaps); return; }
  if (saved === 'declined') { document.addEventListener('DOMContentLoaded', showMapBlock); return; }

  function injectBanner() {
    var banner = document.createElement('div');
    banner.id = 'pf-cookie-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Cookie-Einstellungen');
    banner.style.cssText = [
      'position:fixed;bottom:0;left:0;right:0;z-index:99999',
      'background:#16191F;border-top:1px solid rgba(236,239,241,.12)',
      'padding:1rem 1.5rem;display:flex;align-items:center',
      'gap:1.5rem;flex-wrap:wrap;justify-content:space-between',
      'box-shadow:0 -4px 24px rgba(0,0,0,.5)',
      'font-family:Manrope,sans-serif;color:#ECF0F1'
    ].join(';');
    banner.innerHTML = [
      '<div style="max-width:620px">',
        '<p style="margin:0 0 .4rem;font-weight:700;font-size:.93rem">Cookies &amp; Datenschutz</p>',
        '<p style="margin:0;font-size:.81rem;line-height:1.6;color:rgba(236,239,241,.65)">',
          'Wir nutzen technisch notwendige Cookies. Mit Ihrer Zustimmung laden wir außerdem ',
          'Google Maps auf der Kontaktseite. Weitere Infos in unserer ',
          '<a href="datenschutz.html" style="color:#D4AF5A;text-decoration:none">Datenschutzerklärung</a>.',
        '</p>',
      '</div>',
      '<div style="display:flex;gap:.5rem;flex-shrink:0;flex-wrap:wrap">',
        '<button onclick="window.pfConsent.accept()" style="padding:.55rem 1.4rem;border-radius:8px;border:none;background:#D4AF5A;color:#0A0A0C;font-weight:700;font-size:.8rem;cursor:pointer;letter-spacing:.04em;white-space:nowrap">Alle akzeptieren</button>',
        '<button onclick="window.pfConsent.decline()" style="padding:.55rem 1.2rem;border-radius:8px;border:1px solid rgba(236,239,241,.2);background:transparent;color:rgba(236,239,241,.75);font-size:.8rem;cursor:pointer;white-space:nowrap">Nur notwendige</button>',
      '</div>'
    ].join('');
    document.body.appendChild(banner);
  }

  if (document.body) { injectBanner(); }
  else { document.addEventListener('DOMContentLoaded', injectBanner); }
})();
