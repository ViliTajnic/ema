'use strict';

let usagePoints = [];
let activePoint = null;
let chartInstance = null;

const envBadge = document.getElementById('envBadge');
const statusBar = document.getElementById('todayStatusBar');
const usagePointSelect = document.getElementById('todayUsagePoint');
const refreshBtn = document.getElementById('refreshTodayBtn');
const summaryEl = document.getElementById('todaySummary');
const tableBody = document.getElementById('todayTableBody');
const chartTitle = document.getElementById('todayChartTitle');

(async function init() {
  await loadAppConfig();
  await loadUsagePoints();
  await refreshTodayUsage();
  setInterval(() => {
    if (activePoint) void refreshTodayUsage({ silent: true });
  }, 5 * 60 * 1000);
})();

async function loadAppConfig() {
  try {
    const config = await apiFetch('/api/app-config');
    const env = (config.mojelektroEnv || 'test').toUpperCase();
    envBadge.textContent = env;
    envBadge.classList.toggle('prod', env === 'PRODUCTION');
  } catch (_) {
    envBadge.textContent = 'UNKNOWN';
  }
}

async function loadUsagePoints() {
  try {
    usagePoints = await apiFetch('/api/usage-points');
  } catch (err) {
    showStatus('Napaka pri nalaganju merilnih mest: ' + err.message, 'error');
    return;
  }
  const saved = getSavedUsagePoint();
  activePoint = usagePoints.find(item => item.IDENTIFIER === saved)?.IDENTIFIER || usagePoints[0]?.IDENTIFIER || null;

  usagePointSelect.innerHTML = '<option value="">— izberi —</option>';
  usagePoints.forEach(item => {
    const option = document.createElement('option');
    option.value = item.IDENTIFIER;
    option.textContent = item.LABEL ? `${item.LABEL} (${item.IDENTIFIER})` : item.IDENTIFIER;
    option.selected = item.IDENTIFIER === activePoint;
    usagePointSelect.appendChild(option);
  });
}

async function refreshTodayUsage({ silent = false } = {}) {
  const usagePoint = usagePointSelect.value || activePoint;
  if (!usagePoint) {
    renderEmptyState('Ni shranjenega merilnega mesta.');
    return;
  }

  activePoint = usagePoint;
  saveUsagePoint(usagePoint);

  if (!silent) {
    showStatus('Nalagam današnjo porabo…', 'info');
  }

  try {
    const data = await apiFetch('/api/today-usage?' + new URLSearchParams({ usagePoint }));
    renderSummary(data);
    renderChart(data);
    renderTable(data);
    showStatus(
      data.hasEstimate
        ? (data.estimateSourceDate === data.previousDate
          ? `Prikazana je ocena za danes po vcerajsnjem profilu dne ${data.previousDate}. ${data.finalDataNote}`
          : `Vceraj je bil ${data.previousDate}, vendar njegov 15-min profil se ni objavljen. Uporabljen je zadnji razpolozljivi profil dne ${data.estimateSourceDate}. ${data.finalDataNote}`)
        : (data.totals.intervalsCount
          ? `Današnja poraba osvežena. Zajetih intervalov: ${data.totals.intervalsCount} od ${data.totals.timelineCount}.`
          : 'Današnji podatki še niso objavljeni.'),
      'success'
    );
  } catch (err) {
    renderEmptyState('Današnji podatki niso na voljo.');
    showStatus('Napaka: ' + err.message, 'error');
  }
}

function renderSummary(data) {
  const current = data.currentUsage;
  const missingCount = Math.max(0, data.totals.timelineCount - data.totals.intervalsCount);
  const currentMeta = current
    ? (current.isEstimated
      ? (data.estimateSourceDate === data.previousDate
        ? `Ocenjeno po vcerajsnjem profilu dne ${data.previousDate}`
        : `Ocenjeno po zadnjem razpolozljivem profilu dne ${data.estimateSourceDate}`)
      : 'Iz zadnjega objavljenega 15-min intervala')
    : 'Današnji intervali še niso objavljeni';
  summaryEl.innerHTML = `
    <div class="summary-card summary-card-emphasis">
      <div class="summary-label">Trenutna poraba</div>
      <div class="summary-value">${current ? formatNum(current.estimatedKw) : '—'}</div>
      <div class="summary-meta">${currentMeta}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Zadnji interval</div>
      <div class="summary-value summary-value-small">${current ? `${sliceTime(current.intervalStart)} - ${sliceTime(current.intervalEnd)}` : '—'}</div>
      <div class="summary-meta">${current?.isEstimated ? `Ocena · tocni podatki po polnoci` : (current?.freshnessMinutes != null ? `Pred ${current.freshnessMinutes} min` : 'Ni objavljenega intervala')}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Skupaj danes</div>
      <div class="summary-value">${formatNum(data.totals.totalKwh)}</div>
      <div class="summary-meta">${data.hasEstimate ? 'Vkljucuje oceno za neobjavljene intervale' : 'kWh iz objavljenih intervalov'}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Strošek danes</div>
      <div class="summary-value">${formatEur(data.totals.totalCostInclVat)}</div>
      <div class="summary-meta">vključno z DDV · VT ${formatNum(data.pricing.vtPricePerKwh)} / NT ${formatNum(data.pricing.ntPricePerKwh)} EUR/kWh</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">VT / NT</div>
      <div class="summary-value summary-value-small">${formatNum(data.totals.vtKwh)} / ${formatNum(data.totals.ntKwh)}</div>
      <div class="summary-meta">${formatEur(data.totals.vtCostExVat)} / ${formatEur(data.totals.ntCostExVat)} brez DDV</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Objavljeni intervali</div>
      <div class="summary-value summary-value-small">${data.totals.intervalsCount} / ${data.totals.timelineCount}</div>
      <div class="summary-meta">${data.hasEstimate ? `Ocenjenih intervalov: ${data.totals.estimatedIntervalsCount}` : (missingCount ? `Manjka še ${missingCount} intervalov` : 'Objavljeni vsi dosedanji intervali')}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Aktivna tarifa</div>
      <div class="summary-value summary-value-small">${current ? current.tariffCode : '—'}</div>
      <div class="summary-meta">${current ? current.tariffLabel : '—'}${data.supplier ? ` · ${data.supplier}` : ''}</div>
    </div>
  `;
}

function renderChart(data) {
  const ctx = document.getElementById('todayChart').getContext('2d');
  const labels = data.intervals.map(item => item.timeLabel);
  const values = data.intervals.map(item => item.kwh);
  const colors = data.intervals.map(item => {
    if (item.isEstimated) {
      return item.tariffCode === 'VT' ? 'rgba(247, 193, 79, 0.42)' : 'rgba(79, 202, 142, 0.42)';
    }
    if (!item.isMeasured) return 'rgba(123, 128, 153, 0.28)';
    return item.tariffCode === 'VT' ? 'rgba(247, 193, 79, 0.92)' : 'rgba(79, 202, 142, 0.88)';
  });

  chartTitle.textContent = `Današnja poraba na 15 minut · ${data.date}`;

  if (chartInstance) {
    chartInstance.destroy();
  }

  chartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'kWh',
        data: values,
        backgroundColor: colors,
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor: '#2a2d3a',
          borderWidth: 1,
          titleColor: '#7b8099',
          bodyColor: '#e2e4ee',
          callbacks: {
            label: context => {
              const row = data.intervals[context.dataIndex];
              if (row.isEstimated) return `${context.parsed.y.toFixed(4)} kWh · ${row.tariffCode} · ocena`;
              if (!row.isMeasured) return `Interval še ni objavljen · ${row.tariffCode}`;
              return `${context.parsed.y.toFixed(4)} kWh · ${row.tariffCode}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#7b8099',
            maxTicksLimit: 16,
            font: { size: 11 },
          },
          grid: { color: 'rgba(42,45,58,.45)' },
        },
        y: {
          ticks: {
            color: '#7b8099',
            font: { size: 11 },
          },
          grid: { color: 'rgba(42,45,58,.45)' },
          title: {
            display: true,
            text: 'kWh',
            color: '#7b8099',
          },
        },
      },
    },
  });
}

function renderTable(data) {
  const rows = data.intervals.filter(row => row.isMeasured || row.isEstimated).slice(-12).reverse();
  tableBody.innerHTML = rows.map(row => `
    <tr>
      <td>${row.intervalStart || '—'}</td>
      <td>${row.intervalEnd || '—'}</td>
      <td>${formatNum(row.kwh)}</td>
      <td>${formatNum(row.estimatedKw)}</td>
      <td><span class="tariff-chip ${row.tariffCode === 'VT' ? 'tariff-chip-vt' : 'tariff-chip-nt'}">${row.isEstimated ? `${row.tariffCode}*` : row.tariffCode}</span></td>
    </tr>
  `).join('') || '<tr><td colspan="5">Današnji intervali še niso objavljeni.</td></tr>';
}

function renderEmptyState(message) {
  summaryEl.innerHTML = `
    <div class="summary-card">
      <div class="summary-label">Današnja poraba</div>
      <div class="summary-value summary-value-small">—</div>
      <div class="summary-meta">${message}</div>
    </div>
  `;

  tableBody.innerHTML = `<tr><td colspan="5">${message}</td></tr>`;

  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
}

function showStatus(message, type = 'info') {
  statusBar.textContent = message;
  statusBar.className = `status-bar ${type}`;
  if (type === 'success') {
    setTimeout(() => statusBar.classList.add('hidden'), 3000);
  }
}

function formatNum(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return Number(value).toFixed(4);
}

function formatEur(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${Number(value).toFixed(2)} EUR`;
}

function sliceTime(value) {
  return String(value || '').slice(11, 16) || '—';
}

function saveUsagePoint(identifier) {
  try {
    localStorage.setItem('ema.activePoint', identifier);
  } catch (_) {}
}

function getSavedUsagePoint() {
  try {
    return localStorage.getItem('ema.activePoint');
  } catch (_) {
    return null;
  }
}

usagePointSelect.addEventListener('change', () => {
  activePoint = usagePointSelect.value || null;
  void refreshTodayUsage();
});

refreshBtn.addEventListener('click', () => {
  void refreshTodayUsage();
});

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
