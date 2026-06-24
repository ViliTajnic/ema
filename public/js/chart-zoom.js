'use strict';

// Mobile-only chart zoom. Tapping the expand button makes the chart's own card
// go fullscreen and switches the chart to fill-height mode, so the existing
// Chart.js instance (with all its colours, tooltips and interactions) simply
// grows to fill the screen. Rotating the phone gives a wide landscape view.
// The trigger buttons are hidden on desktop via CSS, so this is a no-op there.
(function () {
  let active = null; // { card, chart, prevMaintain, closeBtn }

  function open(canvas) {
    if (active) return;
    const card = canvas.closest('.chart-card');
    if (!card) return;
    const chart = (window.Chart && Chart.getChart) ? Chart.getChart(canvas) : null;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'chart-zoom-close';
    closeBtn.setAttribute('aria-label', 'Zapri');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', close);
    card.appendChild(closeBtn);

    active = {
      card, chart, closeBtn,
      // Default to true (Chart.js' default) so closing restores the original ratio.
      prevMaintain: chart ? (chart.config.options.maintainAspectRatio ?? true) : undefined,
    };
    card.classList.add('chart-fullscreen');
    document.body.classList.add('chart-zoom-lock');
    if (chart) {
      // Set on both the live and source config so a re-resolve keeps it.
      chart.options.maintainAspectRatio = false;
      chart.config.options.maintainAspectRatio = false;
      // Resize after the fullscreen layout applies; the second pass guards
      // against Chart.js' own resize observer racing the first one.
      requestAnimationFrame(() => chart.resize());
      setTimeout(() => { if (active && active.chart === chart) chart.resize(); }, 150);
    }
  }

  function close() {
    if (!active) return;
    const { card, chart, prevMaintain, closeBtn } = active;
    card.classList.remove('chart-fullscreen');
    document.body.classList.remove('chart-zoom-lock');
    closeBtn.remove();
    if (chart) {
      chart.options.maintainAspectRatio = prevMaintain;
      chart.config.options.maintainAspectRatio = prevMaintain;
      requestAnimationFrame(() => chart.resize());
    }
    active = null;
  }

  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  const refit = () => { if (active && active.chart) active.chart.resize(); };
  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', () => setTimeout(refit, 250));

  document.querySelectorAll('[data-zoom-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const canvas = document.getElementById(btn.getAttribute('data-zoom-target'));
      if (canvas) open(canvas);
    });
  });
})();
