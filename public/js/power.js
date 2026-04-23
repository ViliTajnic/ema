'use strict';

let usagePoints = [];
let activePoint = null;
let activePeriodPreset = 'last30';
let chartInstance = null;

const envBadge = document.getElementById('envBadge');
const statusBar = document.getElementById('powerStatusBar');
const usagePointSelect = document.getElementById('powerUsagePoint');
const startDateInput = document.getElementById('powerStartDate');
const endDateInput = document.getElementById('powerEndDate');
const periodPresets = document.getElementById('powerPeriodPresets');
const refreshBtn = document.getElementById('refreshPowerBtn');
const summaryEl = document.getElementById('powerSummary');
const recommendationNoteEl = document.getElementById('powerRecommendationNote');
const profilesEl = document.getElementById('powerProfiles');
const excessSummaryEl = document.getElementById('powerExcessSummary');
const excessTableBody = document.getElementById('powerExcessTableBody');
const tableBody = document.getElementById('powerTableBody');
const chartTitle = document.getElementById('powerChartTitle');

(async function init() {
  applyPeriodPreset('last30');
  await loadAppConfig();
  await loadUsagePoints();
  await refreshAnalysis();
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

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toStartOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function getPresetRange(preset) {
  const today = toStartOfDay(new Date());

  if (preset === 'last30') {
    const start = new Date(today);
    start.setDate(start.getDate() - 29);
    return { start, end: today };
  }

  if (preset === 'last90') {
    const start = new Date(today);
    start.setDate(start.getDate() - 89);
    return { start, end: today };
  }

  if (preset === 'last180') {
    const start = new Date(today);
    start.setDate(start.getDate() - 179);
    return { start, end: today };
  }

  if (preset === 'last365') {
    const start = new Date(today);
    start.setDate(start.getDate() - 364);
    return { start, end: today };
  }

  if (preset === 'last730') {
    const start = new Date(today);
    start.setDate(start.getDate() - 729);
    return { start, end: today };
  }

  return null;
}

function setActivePeriodPreset(preset) {
  activePeriodPreset = preset;
  periodPresets.querySelectorAll('[data-period]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.period === preset);
  });
}

function applyPeriodPreset(preset) {
  if (preset === 'custom') {
    setActivePeriodPreset('custom');
    return;
  }

  const range = getPresetRange(preset);
  if (!range) return;

  startDateInput.value = formatLocalDate(range.start);
  endDateInput.value = formatLocalDate(range.end);
  setActivePeriodPreset(preset);
}

periodPresets.querySelectorAll('[data-period]').forEach(btn => {
  btn.addEventListener('click', () => applyPeriodPreset(btn.dataset.period));
});

startDateInput.addEventListener('change', () => setActivePeriodPreset('custom'));
endDateInput.addEventListener('change', () => setActivePeriodPreset('custom'));

usagePointSelect.addEventListener('change', () => {
  activePoint = usagePointSelect.value || null;
  saveUsagePoint(activePoint);
});

refreshBtn.addEventListener('click', () => {
  void refreshAnalysis();
});

async function refreshAnalysis() {
  const usagePoint = usagePointSelect.value || activePoint;
  const startDate = startDateInput.value;
  const endDate = endDateInput.value;

  if (!usagePoint) {
    renderEmptyState('Ni shranjenega merilnega mesta.');
    return;
  }

  if (!startDate || !endDate) {
    renderEmptyState('Izberite obdobje analize.');
    return;
  }

  activePoint = usagePoint;
  usagePointSelect.value = usagePoint;
  saveUsagePoint(usagePoint);

  showStatus('Analiziram vrhove po blokih in pripravljam predloge…', 'info');

  try {
    const data = await apiFetch('/api/power-optimization?' + new URLSearchParams({
      usagePoint,
      startDate,
      endDate,
    }));

    renderSummary(data);
    renderRecommendationNote(data);
    renderProfiles(data);
    renderExcessSummary(data);
    renderExcessTable(data);
    renderTable(data);
    renderChart(data);
    showStatus(`Analiza pripravljena za ${data.analysis.distinctDays} dni in ${data.analysis.readingCount} intervalov.`, 'success');
  } catch (err) {
    renderEmptyState(err.message);
    showStatus('Napaka: ' + err.message, 'error');
  }
}

function renderSummary(data) {
  const recommended = getRecommendedProfile(data);
  summaryEl.innerHTML = `
    <div class="summary-card summary-card-emphasis">
      <div class="summary-label">Priporočen scenarij</div>
      <div class="summary-value summary-value-small">${recommended ? recommended.label : '—'}</div>
      <div class="summary-meta">${recommended ? recommended.description : '—'}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Merilno mesto</div>
      <div class="summary-value summary-value-small">${data.usagePoint}</div>
      <div class="summary-meta">${data.supplier || 'Dobavitelj ni znan'}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Največji izmerjeni vrh</div>
      <div class="summary-value">${formatKw(data.agreement.observedOverallPeakKw)}</div>
      <div class="summary-meta">P99 ${formatKw(data.agreement.observedOverallP99Kw)}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Sedanji strošek / mesec</div>
      <div class="summary-value">${formatEur(data.currentCosts.monthlyTotalInclVat)}</div>
      <div class="summary-meta">moč + OVE/SPTE z DDV</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Prihranek / mesec</div>
      <div class="summary-value">${recommended ? formatSignedEur(recommended.estimatedMonthlySavingsInclVat) : '—'}</div>
      <div class="summary-meta">priporočen scenarij z DDV</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Prihranek / leto</div>
      <div class="summary-value">${recommended ? formatSignedEur(recommended.estimatedAnnualSavingsInclVat) : '—'}</div>
      <div class="summary-meta">priporočen scenarij z DDV</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Analizirano obdobje</div>
      <div class="summary-value summary-value-small">${data.dateRange.startDate} do ${data.dateRange.endDate}</div>
      <div class="summary-meta">${data.analysis.distinctDays} dni · ${formatNum(data.analysis.equivalentMonths)} meseca</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Aktivna dogovorjena moč</div>
      <div class="summary-value summary-value-small">${data.agreement.current.datumOd || '—'}</div>
      <div class="summary-meta">do ${data.agreement.current.datumDo || '—'}</div>
    </div>
  `;
}

function renderRecommendationNote(data) {
  const recommended = getRecommendedProfile(data);
  const recommendedKey = recommended?.key || 'balanced';
  const increasedBlocks = data.blocks.filter(block => Number(block.recommendations[recommendedKey] || 0) > Number(block.currentAgreedKw || 0));
  const reducedBlocks = data.blocks.filter(block => Number(block.recommendations[recommendedKey] || 0) < Number(block.currentAgreedKw || 0));
  const issueText = increasedBlocks.length
    ? `Pozor: v blokih ${increasedBlocks.map(item => item.block).join(', ')} je trenutna dogovorjena moč pod ali preblizu izmerjenim vrhovom, zato predlog moč zviša.`
    : `Največ rezerve za znižanje je v blokih ${reducedBlocks.map(item => item.block).join(', ') || 'brez izrazitih presežkov'}.`;
  const excessText = recommended?.excess?.monthsWithExcessCount
    ? `Izbrani scenarij se še vedno dotika presežkov v ${recommended.excess.monthsWithExcessCount} mesecih, največ v mesecu ${recommended.excess.worstMonth?.monthKey || '—'} (${formatKw(recommended.excess.peakMonthlyExcessKw)}).`
    : 'Izbrani scenarij po analiziranih meritvah ne ustvarja informativnih presežkov dogovorjene moči.';

  recommendationNoteEl.innerHTML = `
    <p><strong>Priporočilo:</strong> kot osnovni scenarij uporabi <strong>${recommended ? recommended.label : 'uravnoteženo nastavitev'}</strong>. Ocena mesečnega učinka je <strong>${recommended ? formatSignedEur(recommended.estimatedMonthlySavingsInclVat) : '—'}</strong> z DDV.</p>
    <p>${issueText}</p>
    <p>${excessText}</p>
    <p>Predlogi upoštevajo pravilo portala Moj Elektro: blok 1 mora biti manjsi ali enak bloku 2, blok 2 manjsi ali enak bloku 3, nato enako do bloka 5.</p>
    <p>${data.note}</p>
  `;
}

function renderProfiles(data) {
  profilesEl.innerHTML = data.profiles.map(profile => `
    <article class="profile-card ${profile.key === data.recommendedProfileKey ? 'featured' : ''}">
      <div class="profile-header">
        <div>
          <h3>${profile.label}</h3>
          <p>${profile.description}</p>
        </div>
        <span class="risk-chip risk-${riskClass(profile.riskLevel)}">${profile.riskLevel}</span>
      </div>
      <div class="profile-metric">${formatEur(profile.monthlyCosts.monthlyTotalInclVat)}</div>
      <div class="profile-meta">moč + OVE/SPTE z DDV na mesec</div>
      <div class="profile-list">
        <div>Prihranek / mesec <strong>${formatSignedEur(profile.estimatedMonthlySavingsInclVat)}</strong></div>
        <div>Prihranek / leto <strong>${formatSignedEur(profile.estimatedAnnualSavingsInclVat)}</strong></div>
        <div>Meseci s presežkom <strong>${profile.excess.monthsWithExcessCount}</strong></div>
        <div>Skupni informativni presežek <strong>${formatKw(profile.excess.totalInformativeExcessKw)}</strong></div>
        <div>Najslabši mesec <strong>${profile.excess.worstMonth ? `${profile.excess.worstMonth.monthKey} · ${formatKw(profile.excess.worstMonth.totalInformativeExcessKw)}` : 'brez presežkov'}</strong></div>
        <div>Bloki <strong>${formatAgreementShort(profile.agreement)}</strong></div>
      </div>
    </article>
  `).join('');
}

function renderExcessSummary(data) {
  const recommended = getRecommendedProfile(data);
  excessSummaryEl.innerHTML = `
    <div class="summary-card">
      <div class="summary-label">Trenutni meseci s presežkom</div>
      <div class="summary-value">${data.currentExcess.monthsWithExcessCount}</div>
      <div class="summary-meta">${data.currentExcess.worstMonth ? `največ v ${data.currentExcess.worstMonth.monthKey}` : 'brez zaznanih presežkov'}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Trenutni skupni presežek</div>
      <div class="summary-value">${formatKw(data.currentExcess.totalInformativeExcessKw)}</div>
      <div class="summary-meta">informativna mesečna vsota po pravilih Moj Elektro</div>
    </div>
    <div class="summary-card summary-card-emphasis">
      <div class="summary-label">Priporočen scenarij</div>
      <div class="summary-value summary-value-small">${recommended ? recommended.label : '—'}</div>
      <div class="summary-meta">${recommended ? `${recommended.excess.monthsWithExcessCount} mesecev s presežkom` : '—'}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Priporočen presežek</div>
      <div class="summary-value">${recommended ? formatKw(recommended.excess.totalInformativeExcessKw) : '—'}</div>
      <div class="summary-meta">${recommended?.excess?.worstMonth ? `največ v ${recommended.excess.worstMonth.monthKey}` : 'brez zaznanih presežkov'}</div>
    </div>
  `;
}

function renderExcessTable(data) {
  if (!data.excessMonths.length) {
    excessTableBody.innerHTML = '<tr><td colspan="5">V analiziranem obdobju ni zaznanih informativnih presežkov za noben scenarij.</td></tr>';
    return;
  }

  excessTableBody.innerHTML = data.excessMonths.map(row => `
    <tr>
      <td>${row.monthKey}</td>
      <td class="${row.current > 0 ? 'value-negative' : ''}">${formatKw(row.current)}</td>
      <td class="${row.balanced > 0 ? 'value-negative' : 'value-positive'}">${formatKw(row.balanced)}</td>
      <td class="${row.conservative > 0 ? 'value-negative' : 'value-positive'}">${formatKw(row.conservative)}</td>
      <td class="${row.aggressive > 0 ? 'value-negative' : 'value-positive'}">${formatKw(row.aggressive)}</td>
    </tr>
  `).join('');
}

function renderTable(data) {
  tableBody.innerHTML = data.blocks.map(block => `
    <tr>
      <td>${block.block}</td>
      <td>${formatKw(block.currentAgreedKw)}</td>
      <td>${formatKw(block.observedPeakKw)}</td>
      <td>${formatKw(block.observedP99Kw)}</td>
      <td>${formatKw(block.observedP95Kw)}</td>
      <td class="${Number(block.currentHeadroomKw) < 0 ? 'value-negative' : 'value-positive'}">${formatSignedKw(block.currentHeadroomKw)} <span class="cell-muted">(${formatSignedPct(block.currentHeadroomPct)})</span></td>
      <td>${formatKw(block.recommendations.balanced)} <span class="cell-muted">${formatSignedKw(block.recommendations.balanced - block.currentAgreedKw)}</span></td>
      <td>${formatKw(block.recommendations.conservative)} <span class="cell-muted">${formatSignedKw(block.recommendations.conservative - block.currentAgreedKw)}</span></td>
      <td>${formatKw(block.recommendations.aggressive)} <span class="cell-muted">${formatSignedKw(block.recommendations.aggressive - block.currentAgreedKw)}</span></td>
    </tr>
  `).join('');
}

function renderChart(data) {
  const ctx = document.getElementById('powerChart').getContext('2d');
  const labels = data.blocks.map(item => `Blok ${item.block}`);
  const balanced = data.profiles.find(item => item.key === 'balanced');
  const conservative = data.profiles.find(item => item.key === 'conservative');
  const aggressive = data.profiles.find(item => item.key === 'aggressive');

  chartTitle.textContent = `Primerjava po blokih · ${data.usagePoint}`;

  if (chartInstance) {
    chartInstance.destroy();
  }

  chartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Trenutna moč',
          data: data.blocks.map(item => item.currentAgreedKw),
          backgroundColor: 'rgba(79, 142, 247, 0.88)',
          borderRadius: 6,
        },
        {
          label: 'Izmerjeni vrh',
          data: data.blocks.map(item => item.observedPeakKw),
          backgroundColor: 'rgba(247, 193, 79, 0.92)',
          borderRadius: 6,
        },
        {
          label: 'Uravnoteženo',
          data: data.blocks.map(item => balanced?.agreement[`casovniBlok${item.block}`] || 0),
          backgroundColor: 'rgba(79, 202, 142, 0.88)',
          borderRadius: 6,
        },
        {
          label: 'Konzervativno',
          data: data.blocks.map(item => conservative?.agreement[`casovniBlok${item.block}`] || 0),
          backgroundColor: 'rgba(138, 180, 248, 0.44)',
          borderRadius: 6,
        },
        {
          label: 'Agresivno',
          data: data.blocks.map(item => aggressive?.agreement[`casovniBlok${item.block}`] || 0),
          backgroundColor: 'rgba(224, 85, 85, 0.45)',
          borderRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor: '#2a2d3a',
          borderWidth: 1,
          titleColor: '#7b8099',
          bodyColor: '#e2e4ee',
          callbacks: {
            label: context => `${context.dataset.label}: ${formatKw(context.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#7b8099' },
          grid: { color: 'rgba(42,45,58,.45)' },
        },
        y: {
          ticks: { color: '#7b8099' },
          grid: { color: 'rgba(42,45,58,.45)' },
          title: {
            display: true,
            text: 'kW',
            color: '#7b8099',
          },
        },
      },
    },
  });
}

function renderEmptyState(message) {
  summaryEl.innerHTML = `
    <div class="summary-card">
      <div class="summary-label">Optimizacija moči</div>
      <div class="summary-value summary-value-small">—</div>
      <div class="summary-meta">${message}</div>
    </div>
  `;
  recommendationNoteEl.textContent = message;
  profilesEl.innerHTML = '';
  excessSummaryEl.innerHTML = '';
  excessTableBody.innerHTML = `<tr><td colspan="5">${message}</td></tr>`;
  tableBody.innerHTML = `<tr><td colspan="9">${message}</td></tr>`;

  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
}

function showStatus(message, type = 'info') {
  statusBar.textContent = message;
  statusBar.className = `status-bar ${type}`;
  if (type === 'success') {
    setTimeout(() => statusBar.classList.add('hidden'), 4000);
  }
}

function riskClass(value) {
  if (value === 'nizko') return 'low';
  if (value === 'srednje') return 'medium';
  if (value === 'visoko') return 'high';
  return 'neutral';
}

function getRecommendedProfile(data) {
  return data.profiles.find(item => item.key === data.recommendedProfileKey) || data.profiles.find(item => item.key === 'balanced') || null;
}

function formatAgreementShort(agreement) {
  return [1, 2, 3, 4, 5]
    .map(block => `${block}:${formatNum(agreement[`casovniBlok${block}`])}`)
    .join(' · ');
}

function formatNum(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return Number(value).toFixed(2);
}

function formatKw(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${Number(value).toFixed(2)} kW`;
}

function formatEur(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${Number(value).toFixed(2)} EUR`;
}

function formatSignedEur(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const prefix = Number(value) > 0 ? '+' : '';
  return `${prefix}${Number(value).toFixed(2)} EUR`;
}

function formatSignedKw(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const prefix = Number(value) > 0 ? '+' : '';
  return `${prefix}${Number(value).toFixed(2)} kW`;
}

function formatSignedPct(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const prefix = Number(value) > 0 ? '+' : '';
  return `${prefix}${Number(value).toFixed(2)} %`;
}

function saveUsagePoint(identifier) {
  try {
    if (identifier) {
      localStorage.setItem('ema.activePoint', identifier);
    } else {
      localStorage.removeItem('ema.activePoint');
    }
  } catch (_) {}
}

function getSavedUsagePoint() {
  try {
    return localStorage.getItem('ema.activePoint');
  } catch (_) {
    return null;
  }
}

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
