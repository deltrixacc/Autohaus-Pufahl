/* ==========================================================================
   AUTOHAUS PUFAHL — interactions (shared across pages, all guarded)
   ========================================================================== */
(function () {
  'use strict';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- footer year ---- */
  document.querySelectorAll('[data-year]').forEach(el => { el.textContent = new Date().getFullYear(); });

  /* ---- nav: scrolled state ---- */
  const nav = document.querySelector('.nav');
  if (nav) {
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ---- mobile menu ---- */
  const toggle = document.querySelector('.nav-toggle');
  const menu = document.querySelector('.mobile-menu');
  if (toggle && menu) {
    const setOpen = (open) => {
      toggle.classList.toggle('open', open);
      menu.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
      document.body.style.overflow = open ? 'hidden' : '';
    };
    toggle.addEventListener('click', () => setOpen(!menu.classList.contains('open')));
    menu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => setOpen(false)));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
  }

  /* ---- reveal on scroll ---- */
  const revealEls = document.querySelectorAll('.reveal, .reveal-group');
  if (revealEls.length) {
    if (reduceMotion || !('IntersectionObserver' in window)) {
      revealEls.forEach(el => el.classList.add('is-visible'));
    } else {
      const io = new IntersectionObserver((entries) => {
        entries.forEach(en => {
          if (en.isIntersecting) { en.target.classList.add('is-visible'); io.unobserve(en.target); }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
      revealEls.forEach(el => io.observe(el));
    }
  }

  /* ---- animated counters ---- */
  const counters = document.querySelectorAll('[data-count]');
  if (counters.length) {
    const animate = (el) => {
      const target = parseFloat(el.dataset.count);
      const decimals = (el.dataset.count.split('.')[1] || '').length;
      const suffix = el.dataset.suffix || '';
      const prefix = el.dataset.prefix || '';
      const useGroup = el.dataset.group === 'true';
      if (reduceMotion) {
        el.textContent = prefix + format(target, decimals, useGroup) + suffix; return;
      }
      const dur = 1500, t0 = performance.now();
      const tick = (now) => {
        const p = Math.min((now - t0) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = prefix + format(target * eased, decimals, useGroup) + suffix;
        if (p < 1) requestAnimationFrame(tick);
        else el.textContent = prefix + format(target, decimals, useGroup) + suffix;
      };
      requestAnimationFrame(tick);
    };
    const format = (n, d, group) => {
      const v = n.toFixed(d);
      return group ? Number(v).toLocaleString('de-DE') : v.replace('.', ',');
    };
    if (!('IntersectionObserver' in window)) {
      counters.forEach(animate);
    } else {
      const io = new IntersectionObserver((entries) => {
        entries.forEach(en => { if (en.isIntersecting) { animate(en.target); io.unobserve(en.target); } });
      }, { threshold: 0.5 });
      counters.forEach(c => io.observe(c));
    }
  }

  /* ---- vehicle filtering + sorting (Fahrzeuge page) ---- */
  const grid = document.querySelector('[data-vehicle-grid]');
  if (grid) {
    const cards = Array.from(grid.querySelectorAll('[data-type]'));
    const chips = document.querySelectorAll('.chip-btn[data-filter]');
    const sortSel = document.querySelector('[data-sort]');
    const countEl = document.querySelector('[data-result-count]');
    const noRes = document.querySelector('[data-no-results]');
    let activeFilter = 'alle';

    const apply = () => {
      let shown = 0;
      cards.forEach(c => {
        const match = activeFilter === 'alle' || c.dataset.type === activeFilter;
        c.style.display = match ? '' : 'none';
        if (match) shown++;
      });
      // sort visible
      if (sortSel) {
        const visible = cards.filter(c => c.style.display !== 'none');
        const mode = sortSel.value;
        visible.sort((a, b) => {
          if (mode === 'preis-auf') return +a.dataset.price - +b.dataset.price;
          if (mode === 'preis-ab') return +b.dataset.price - +a.dataset.price;
          if (mode === 'km-auf') return +a.dataset.km - +b.dataset.km;
          if (mode === 'jahr-ab') return +b.dataset.jahr - +a.dataset.jahr;
          return 0;
        });
        visible.forEach(c => grid.appendChild(c));
      }
      if (countEl) countEl.textContent = shown;
      if (noRes) noRes.style.display = shown === 0 ? '' : 'none';
    };

    chips.forEach(chip => chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter;
      apply();
    }));
    if (sortSel) sortSel.addEventListener('change', apply);
    apply();
  }

  /* ---- contact form ---- */
  const form = document.querySelector('[data-contact-form]');
  if (form) {
    const success = form.querySelector('.form-success');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }
      const btn = form.querySelector('button[type="submit"]');
      const name = (form.querySelector('#name')?.value || '').trim().split(' ')[0];
      if (btn) { btn.disabled = true; btn.textContent = 'Wird gesendet …'; }
      setTimeout(() => {
        if (success) {
          success.querySelector('[data-success-text]').textContent =
            (name ? `Danke, ${name}! ` : 'Danke! ') + 'Ihre Anfrage ist eingegangen — wir melden uns innerhalb eines Werktags.';
          success.classList.add('show');
        }
        form.reset();
        if (btn) { btn.disabled = false; btn.textContent = 'Anfrage senden'; }
      }, 700);
    });
  }
})();
