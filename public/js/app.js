'use strict';

// ── State ──────────────────────────────────────────────────────
let usagePoints  = [];
let activePoint  = null;
let chartInstance = null;
let lastTableData = [];
let lastTableHeaders = [];
let chartType = 'bar';
let activePeriodPreset = 'last7';
let currentPriceLookupToken = 0;
let lastPriceLookupUsagePoint = null;

// ── DOM refs ───────────────────────────────────────────────────
const usagePointList     = document.getElementById('usagePointList');
const queryUsagePoint    = document.getElementById('queryUsagePoint');
const addForm            = document.getElementById('addUsagePointForm');
const toggleAddUsagePointBtn = document.getElementById('toggleAddUsagePointBtn');
const upIdentifier       = document.getElementById('upIdentifier');
const upGsrn             = document.getElementById('upGsrn');
const upLabel            = document.getElementById('upLabel');

const queryStartDate     = document.getElementById('queryStartDate');
const queryEndDate       = document.getElementById('queryEndDate');
const periodPresets      = document.getElementById('periodPresets');
const queryRegister      = document.getElementById('queryRegister');
const queryVtPrice       = document.getElementById('queryVtPrice');
const queryMtPrice       = document.getElementById('queryMtPrice');
const queryMonthlyFee    = document.getElementById('queryMonthlyFee');
const queryMonthlyDiscount = document.getElementById('queryMonthlyDiscount');
const priceSourceNote    = document.getElementById('priceSourceNote');
const fetchReadingsBtn   = document.getElementById('fetchReadingsBtn');
const fetchDailyBtn      = document.getElementById('fetchDailyBtn');
const fetchCostBtn       = document.getElementById('fetchCostBtn');

const detailIdentifier   = document.getElementById('detailIdentifier');
const detailGsrn         = document.getElementById('detailGsrn');
const fetchMMBtn         = document.getElementById('fetchMerilnoMestoBtn');
const fetchMTBtn         = document.getElementById('fetchMerilnaTockaBtn');

const statusBar          = document.getElementById('statusBar');
const chartPanel         = document.getElementById('chartPanel');
const chartTitle         = document.getElementById('chartTitle');
const summaryCards       = document.getElementById('summaryCards');
const tablePanel         = document.getElementById('tablePanel');
const tableTitle         = document.getElementById('tableTitle');
const tableHead          = document.getElementById('tableHead');
const tableBody          = document.getElementById('tableBody');
const costPanel          = document.getElementById('costPanel');
const costTitle          = document.getElementById('costTitle');
const costSummary        = document.getElementById('costSummary');
const costBlocksHead     = document.getElementById('costBlocksHead');
const costBlocksBody     = document.getElementById('costBlocksBody');
const costBreakdownHead  = document.getElementById('costBreakdownHead');
const costBreakdownBody  = document.getElementById('costBreakdownBody');
const detailPanel        = document.getElementById('detailPanel');
const detailTitle        = document.getElementById('detailTitle');
const detailJson         = document.getElementById('detailJson');
const exportCsvBtn       = document.getElementById('exportCsvBtn');
const chartBarBtn        = document.getElementById('chartBar');
const chartLineBtn       = document.getElementById('chartLine');
const envBadge           = document.getElementById('envBadge');

// ── Init ───────────────────────────────────────────────────────
(async function init() {
  setDefaultDates();
  await loadAppConfig();
  await loadUsagePoints();
})();

function setDefaultDates() {
  applyPeriodPreset('last7');
}

function setAddUsagePointFormOpen(isOpen) {
  addForm.classList.toggle('collapsed', !isOpen);
  toggleAddUsagePointBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

// ── Usage Points ───────────────────────────────────────────────
async function loadUsagePoints() {
  try {
    usagePoints = await apiFetch('/api/usage-points');
    const saved = getSavedUsagePoint();
    if (!activePoint && saved && usagePoints.some(up => up.IDENTIFIER === saved)) {
      activePoint = saved;
    }
    if (!activePoint && usagePoints.length) {
      setActivePoint(usagePoints[0].IDENTIFIER);
    } else if (activePoint && !usagePoints.some(up => up.IDENTIFIER === activePoint)) {
      setActivePoint(null);
    }
    renderUsagePointList();
    rebuildSelect();
  } catch (e) {
    showStatus('Napaka pri nalaganju merilnih mest: ' + e.message, 'error');
  }
}

async function loadAppConfig() {
  try {
    const config = await apiFetch('/api/app-config');
    const env = (config.mojelektroEnv || 'test').toUpperCase();
    envBadge.textContent = env;
    envBadge.classList.toggle('prod', env === 'PRODUCTION');
    queryVtPrice.value = '0.11990';
    queryMtPrice.value = '0.09790';
    queryMonthlyFee.value = '1.99';
    queryMonthlyDiscount.value = '-1.00';
  } catch (_) {
    envBadge.textContent = 'UNKNOWN';
  }
}

function extractOmtoGsrn(data) {
  return data?.merilneTocke?.find(point => point.vrsta === 'OMTO')?.gsrn || '';
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

  if (preset === 'last7') {
    const start = new Date(today);
    start.setDate(start.getDate() - 6);
    return { start, end: today };
  }

  if (preset === 'last30') {
    const start = new Date(today);
    start.setDate(start.getDate() - 29);
    return { start, end: today };
  }

  if (preset === 'thisMonth') {
    return {
      start: new Date(today.getFullYear(), today.getMonth(), 1),
      end: today,
    };
  }

  if (preset === 'prevMonth') {
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end = new Date(today.getFullYear(), today.getMonth(), 0);
    return { start, end };
  }

  if (preset === 'thisYear') {
    return {
      start: new Date(today.getFullYear(), 0, 1),
      end: today,
    };
  }

  if (preset === 'prevYear') {
    return {
      start: new Date(today.getFullYear() - 1, 0, 1),
      end: new Date(today.getFullYear() - 1, 11, 31),
    };
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

  queryStartDate.value = formatLocalDate(range.start);
  queryEndDate.value = formatLocalDate(range.end);
  setActivePeriodPreset(preset);
}

async function refreshSupplierPrices({ force = false } = {}) {
  const usagePoint = queryUsagePoint.value || activePoint;
  if (!usagePoint) {
    priceSourceNote.textContent = 'Cene bodo samodejno pridobljene s spleta glede na dobavitelja.';
    return;
  }

  if (!force && lastPriceLookupUsagePoint === usagePoint) return;

  const lookupToken = ++currentPriceLookupToken;
  lastPriceLookupUsagePoint = usagePoint;
  priceSourceNote.textContent = 'Nalagam aktualni cenik dobavitelja s spleta…';

  try {
    const data = await apiFetch('/api/current-supplier-prices?' + new URLSearchParams({ usagePoint }));
    if (lookupToken !== currentPriceLookupToken) return;

    queryVtPrice.value = Number(data.vtPricePerKwh).toFixed(5);
    queryMtPrice.value = Number(data.mtPricePerKwh).toFixed(5);

    const parts = [data.supplier || 'Dobavitelj'];
    if (data.tariffName) parts.push(data.tariffName);
    if (data.validFrom) parts.push(`velja od ${data.validFrom}`);
    priceSourceNote.textContent = parts.join(' · ');
  } catch (err) {
    if (lookupToken !== currentPriceLookupToken) return;
    lastPriceLookupUsagePoint = null;
    if (/HTTP 404/i.test(err.message)) {
      priceSourceNote.textContent = 'Samodejni zajem cen še ni na voljo v trenutno zagnanem strežniku. Potreben je ponovni zagon backend-a.';
      return;
    }
    priceSourceNote.textContent = `Samodejni zajem cen ni uspel: ${err.message}`;
  }
}

function renderUsagePointList() {
  if (!usagePoints.length) {
    usagePointList.innerHTML = '<p class="empty-hint">Ni shranjenih merilnih mest.</p>';
    return;
  }
  usagePointList.innerHTML = usagePoints.map(up => `
    <div class="usage-item ${activePoint === up.IDENTIFIER ? 'active' : ''}"
         data-id="${up.IDENTIFIER}">
      <div>
        <div class="usage-item-label">${up.LABEL || up.IDENTIFIER}</div>
        <div class="usage-item-id">${up.IDENTIFIER}${up.GSRN ? ' · ' + up.GSRN : ''}</div>
      </div>
      <button class="usage-item-del" data-del="${up.IDENTIFIER}" title="Odstrani">✕</button>
    </div>
  `).join('');

  usagePointList.querySelectorAll('.usage-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('[data-del]')) return;
      setActivePoint(el.dataset.id);
      renderUsagePointList();
    });
  });

  usagePointList.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Odstrani merilno mesto?')) return;
      await apiFetch(`/api/usage-points/${encodeURIComponent(btn.dataset.del)}`, { method: 'DELETE' });
      if (activePoint === btn.dataset.del) {
        const nextPoint = usagePoints.find(up => up.IDENTIFIER !== btn.dataset.del);
        setActivePoint(nextPoint?.IDENTIFIER || null);
      }
      await loadUsagePoints();
    });
  });
}

function rebuildSelect() {
  queryUsagePoint.innerHTML = '<option value="">— izberi —</option>';
  usagePoints.forEach(up => {
    const opt = document.createElement('option');
    opt.value = up.IDENTIFIER;
    opt.textContent = up.LABEL ? `${up.LABEL} (${up.IDENTIFIER})` : up.IDENTIFIER;
    if (up.IDENTIFIER === activePoint) opt.selected = true;
    queryUsagePoint.appendChild(opt);
  });
}

function setActivePoint(identifier) {
  activePoint = identifier || null;
  saveUsagePoint(activePoint);
  queryUsagePoint.value = activePoint || '';
  detailIdentifier.value = activePoint || '';

  const up = usagePoints.find(item => item.IDENTIFIER === activePoint);
  detailGsrn.value = up?.GSRN || '';
  lastPriceLookupUsagePoint = null;
  void refreshSupplierPrices();
}

queryUsagePoint.addEventListener('change', () => {
  setActivePoint(queryUsagePoint.value || null);
  renderUsagePointList();
});

periodPresets.querySelectorAll('[data-period]').forEach(btn => {
  btn.addEventListener('click', () => applyPeriodPreset(btn.dataset.period));
});

queryStartDate.addEventListener('change', () => setActivePeriodPreset('custom'));
queryEndDate.addEventListener('change', () => setActivePeriodPreset('custom'));

toggleAddUsagePointBtn.addEventListener('click', () => {
  const isOpen = toggleAddUsagePointBtn.getAttribute('aria-expanded') === 'true';
  setAddUsagePointFormOpen(!isOpen);
  if (!isOpen) {
    upIdentifier.focus();
  }
});

addForm.addEventListener('submit', async e => {
  e.preventDefault();
  const identifier = upIdentifier.value.trim();
  if (!identifier) return;
  try {
    await apiFetch('/api/usage-points', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier,
        gsrn:  upGsrn.value.trim()  || null,
        label: upLabel.value.trim() || null,
      }),
    });
    upIdentifier.value = '';
    upGsrn.value       = '';
    upLabel.value      = '';
    setAddUsagePointFormOpen(false);
    await loadUsagePoints();
    setActivePoint(identifier);
    renderUsagePointList();
    rebuildSelect();
    showStatus(`Merilno mesto "${identifier}" je bilo dodano.`, 'success');
  } catch (err) {
    showStatus('Napaka: ' + err.message, 'error');
  }
});

// ── Readings ───────────────────────────────────────────────────
fetchReadingsBtn.addEventListener('click', async () => {
  const params = getQueryParams();
  if (!params) return;
  showStatus('Pridobivam 15-minutne odčitke…', 'info');
  try {
    const rows = await apiFetch('/api/meter-readings?' + new URLSearchParams(params));
    if (!rows.length) { showStatus('Ni podatkov za izbrano obdobje.', 'info'); return; }
    showStatus(`Pridobljenih ${rows.length} odčitkov.`, 'success');
    renderReadingsTable(rows);
    renderReadingsChart(rows);
    renderSummary15min(rows);
  } catch (err) {
    showStatus('Napaka: ' + err.message, 'error');
  }
});

fetchDailyBtn.addEventListener('click', async () => {
  const params = getQueryParams();
  if (!params) return;
  showStatus('Pridobivam dnevne agregate…', 'info');
  try {
    const rows = await apiFetch('/api/daily-aggregates?' + new URLSearchParams(params));
    if (!rows.length) { showStatus('Ni podatkov za izbrano obdobje.', 'info'); return; }
    showStatus(`Pridobljenih ${rows.length} dnevnih agregatov.`, 'success');
    renderDailyTable(rows);
    renderDailyChart(rows);
    renderDailySummary(rows);
  } catch (err) {
    showStatus('Napaka: ' + err.message, 'error');
  }
});

fetchCostBtn.addEventListener('click', async () => {
  const params = getQueryParams();
  if (!params) return;

  if (queryVtPrice.value.trim()) params.vtPricePerKwh = queryVtPrice.value.trim();
  if (queryMtPrice.value.trim()) params.mtPricePerKwh = queryMtPrice.value.trim();
  if (queryMonthlyFee.value.trim()) params.monthlyFee = queryMonthlyFee.value.trim();
  if (queryMonthlyDiscount.value.trim()) params.monthlyDiscount = queryMonthlyDiscount.value.trim();

  showStatus('Računam strošek in bloke porabe…', 'info');
  try {
    const data = await apiFetch('/api/cost-estimate?' + new URLSearchParams(params));
    if (data.gsrn && detailIdentifier.value === data.usagePoint) {
      detailGsrn.value = data.gsrn;
    }
    renderCostEstimate(data);
    showStatus('Ocena stroška pripravljena.', 'success');
  } catch (err) {
    showStatus('Napaka: ' + err.message, 'error');
  }
});

function getQueryParams() {
  const usagePoint = queryUsagePoint.value || activePoint;
  const startDate  = queryStartDate.value;
  const endDate    = queryEndDate.value;
  if (!usagePoint) { showStatus('Izberite merilno mesto.', 'error'); return null; }
  if (!startDate || !endDate) { showStatus('Vnesite obdobje.', 'error'); return null; }
  const p = { usagePoint, startDate, endDate };
  const rc = queryRegister.value.trim();
  if (rc) p.registerCode = rc;
  return p;
}

// ── Rendering – 15-min ─────────────────────────────────────────
function renderReadingsTable(rows) {
  tableTitle.textContent = '15-minutni odčitki';
  lastTableHeaders = ['Začetek', 'Konec', 'Register', 'Vrednost', 'Enota', 'Kakovost', 'Tip'];
  lastTableData = rows.map(r => [
    r.INTERVAL_START, r.INTERVAL_END,
    r.REGISTER_CODE ?? '—', formatNum(r.VALUE), r.UNIT ?? '—',
    r.QUALITY_CODE ?? '—', r.READING_TYPE ?? '—',
  ]);
  renderTable();
}

function renderReadingsChart(rows) {
  const series = buildAdaptiveReadingSeries(rows);
  chartTitle.textContent = series.title;
  drawChart(series.labels, series.data, 'kWh');
}

function renderSummary15min(rows) {
  const total = rows.reduce((s, r) => s + (r.VALUE || 0), 0);
  const byDay = {};
  rows.forEach(r => {
    const day = r.INTERVAL_START?.slice(0, 10);
    if (!day) return;
    byDay[day] = (byDay[day] || 0) + (r.VALUE || 0);
  });
  const dayTotals = Object.values(byDay);
  const days = dayTotals.length;
  const max = dayTotals.length ? Math.max(...dayTotals) : 0;
  document.getElementById('sumTotal').textContent = formatNum(total);
  document.getElementById('sumAvg').textContent   = days ? formatNum(total / days) : '—';
  document.getElementById('sumMax').textContent   = formatNum(max);
  document.getElementById('sumCount').textContent = rows.length;
  summaryCards.style.display = '';
}

function buildAdaptiveReadingSeries(rows) {
  const days = new Set(rows.map(r => r.INTERVAL_START?.slice(0, 10)).filter(Boolean)).size;

  if (days > 90) {
    return buildGroupedReadingSeries(rows, {
      keyFn: row => row.INTERVAL_START?.slice(0, 10),
      title: 'Dnevna poraba iz 15-minutnih odčitkov',
    });
  }

  if (days > 14) {
    return buildGroupedReadingSeries(rows, {
      keyFn: row => row.INTERVAL_START?.slice(0, 13).replace('T', ' ') + ':00',
      title: 'Urna poraba iz 15-minutnih odčitkov',
    });
  }

  return buildGroupedReadingSeries(rows, {
    keyFn: row => row.INTERVAL_START?.slice(0, 16).replace('T', ' '),
    title: '15-minutna poraba',
  });
}

function buildGroupedReadingSeries(rows, { keyFn, title }) {
  const grouped = {};

  rows.forEach(row => {
    const key = keyFn(row);
    if (!key) return;
    grouped[key] = (grouped[key] || 0) + Number(row.VALUE || 0);
  });

  const labels = Object.keys(grouped).sort();
  return {
    title,
    labels,
    data: labels.map(label => grouped[label]),
  };
}

// ── Rendering – daily ──────────────────────────────────────────
function renderDailyTable(rows) {
  tableTitle.textContent = 'Dnevni agregati';
  lastTableHeaders = ['Datum', 'Register', 'Skupaj (kWh)', 'Min', 'Avg', 'Max', 'Odčitki'];
  lastTableData = rows.map(r => [
    r.READING_DATE, r.REGISTER_CODE ?? '—',
    formatNum(r.TOTAL_KWH), formatNum(r.MIN_VALUE),
    formatNum(r.AVG_VALUE), formatNum(r.MAX_VALUE),
    r.READING_COUNT,
  ]);
  renderTable();
}

function renderDailyChart(rows) {
  chartTitle.textContent = 'Dnevna poraba (kWh)';
  const labels = rows.map(r => r.READING_DATE);
  const data   = rows.map(r => r.TOTAL_KWH ?? 0);
  drawChart(labels, data, 'kWh');
}

function renderDailySummary(rows) {
  const total  = rows.reduce((s, r) => s + (r.TOTAL_KWH || 0), 0);
  const maxVal = Math.max(...rows.map(r => r.TOTAL_KWH || 0));
  const count  = rows.reduce((s, r) => s + (r.READING_COUNT || 0), 0);
  document.getElementById('sumTotal').textContent = formatNum(total);
  document.getElementById('sumAvg').textContent   = rows.length ? formatNum(total / rows.length) : '—';
  document.getElementById('sumMax').textContent   = formatNum(maxVal);
  document.getElementById('sumCount').textContent = count;
  summaryCards.style.display = '';
}

// ── Table render ───────────────────────────────────────────────
function renderTable() {
  tableHead.innerHTML = '<tr>' + lastTableHeaders.map(h => `<th>${h}</th>`).join('') + '</tr>';
  tableBody.innerHTML = lastTableData.map(row =>
    '<tr>' + row.map(v => `<td>${v ?? '—'}</td>`).join('') + '</tr>'
  ).join('');
  tablePanel.style.display = '';
}

function renderCostEstimate(data) {
  costTitle.textContent = `Ocena stroška za ${data.usagePoint}`;
  costSummary.innerHTML = `
    <div class="summary-card">
      <div class="summary-label">Dobavitelj</div>
      <div class="summary-value summary-value-small">${data.supplier || '—'}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Skupaj kWh</div>
      <div class="summary-value">${formatNum(data.totals.totalKwh)}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">VT / MT</div>
      <div class="summary-value summary-value-small">${formatNum(data.totals.vtKwh)} / ${formatNum(data.totals.mtKwh)}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Skupaj brez DDV</div>
      <div class="summary-value">${formatEur(data.totals.subtotalExVat)}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Skupaj z DDV</div>
      <div class="summary-value">${formatEur(data.totals.totalInclVat)}</div>
    </div>
  `;

  costBlocksHead.innerHTML = '<tr><th>Blok</th><th>Poraba (kWh)</th><th>Omrežnina energija</th><th>Dogovorjena moč (kW)</th><th>Omrežnina moč</th></tr>';
  costBlocksBody.innerHTML = data.blockConsumption.map(item => `
    <tr>
      <td>${item.block}</td>
      <td>${formatNum(item.kwh)}</td>
      <td>${formatEur(item.energyCost)} <span class="cell-muted">(${item.energyTariffPerKwh.toFixed(5)} €/kWh)</span></td>
      <td>${item.agreedPowerKw != null ? formatNum(item.agreedPowerKw) : '—'}</td>
      <td>${formatEur(item.powerCost)} <span class="cell-muted">(${item.powerTariffPerKwMonth.toFixed(5)} €/kW/mesec)</span></td>
    </tr>
  `).join('');

  costBreakdownHead.innerHTML = '<tr><th>Postavka</th><th>Znesek</th></tr>';
  costBreakdownBody.innerHTML = [
    ['Energija dobavitelja VT', formatEur(data.totals.supplyCostVT)],
    ['Energija dobavitelja MT', formatEur(data.totals.supplyCostMT)],
    ['Skupaj energija dobavitelja', formatEur(data.totals.supplyCost)],
    ['Omrežnina za moč', formatEur(data.totals.networkPowerCost)],
    ['Omrežnina za energijo', formatEur(data.totals.networkEnergyCost)],
    ['Prispevek OVE/SPTE', formatEur(data.totals.ovespteFee)],
    ['Prispevek operaterja trga', formatEur(data.totals.operatorFee)],
    ['Prispevek URE', formatEur(data.totals.efficiencyFee)],
    ['Trošarina', formatEur(data.totals.exciseDuty)],
    ['Mesečno nadomestilo', formatEur(data.totals.serviceFee)],
    ['Popust', formatEur(data.totals.serviceDiscount)],
    ['DDV', formatEur(data.totals.vatAmount)],
    ['Skupaj', formatEur(data.totals.totalInclVat)],
  ].map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`).join('');

  costPanel.style.display = '';
  costPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Chart ──────────────────────────────────────────────────────
function drawChart(labels, data, unit) {
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  const ctx = document.getElementById('readingsChart').getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, 'rgba(79,142,247,0.55)');
  gradient.addColorStop(1, 'rgba(79,142,247,0.02)');

  chartInstance = new Chart(ctx, {
    type: chartType,
    data: {
      labels,
      datasets: [{
        label: unit,
        data,
        backgroundColor: chartType === 'bar' ? 'rgba(79,142,247,0.75)' : gradient,
        borderColor: 'rgba(79,142,247,1)',
        borderWidth: chartType === 'bar' ? 0 : 2,
        fill: chartType === 'line',
        tension: 0.35,
        pointRadius: data.length > 100 ? 0 : 3,
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
            label: ctx => `${ctx.parsed.y?.toFixed(4)} ${unit}`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#7b8099',
            maxTicksLimit: 12,
            maxRotation: 45,
            font: { size: 11 },
          },
          grid: { color: 'rgba(42,45,58,.5)' },
        },
        y: {
          ticks: { color: '#7b8099', font: { size: 11 } },
          grid:  { color: 'rgba(42,45,58,.5)' },
          title: { display: true, text: unit, color: '#7b8099', font: { size: 11 } },
        },
      },
    },
  });

  chartPanel.style.display = '';
}

chartBarBtn.addEventListener('click', () => {
  chartType = 'bar';
  chartBarBtn.classList.add('active');
  chartLineBtn.classList.remove('active');
  if (chartInstance) {
    const { labels, datasets } = chartInstance.data;
    drawChart(labels, datasets[0].data, datasets[0].label);
  }
});

chartLineBtn.addEventListener('click', () => {
  chartType = 'line';
  chartLineBtn.classList.add('active');
  chartBarBtn.classList.remove('active');
  if (chartInstance) {
    const { labels, datasets } = chartInstance.data;
    drawChart(labels, datasets[0].data, datasets[0].label);
  }
});

// ── Detail panel ───────────────────────────────────────────────
fetchMMBtn.addEventListener('click', async () => {
  const id = detailIdentifier.value.trim();
  if (!id) { showStatus('Vnesite identifikator.', 'error'); return; }
  showStatus('Pridobivam podatke merilnega mesta…', 'info');
  try {
    const data = await apiFetch(`/api/merilno-mesto/${encodeURIComponent(id)}`);
    const omtoGsrn = extractOmtoGsrn(data);
    if (omtoGsrn) {
      detailGsrn.value = omtoGsrn;
      await loadUsagePoints();
      setActivePoint(id);
      renderUsagePointList();
      rebuildSelect();
    }
    detailTitle.textContent = `Merilno mesto: ${id}`;
    detailJson.textContent  = JSON.stringify(data, null, 2);
    detailPanel.style.display = '';
    showStatus('Podatki merilnega mesta pridobljeni.', 'success');
  } catch (err) {
    showStatus('Napaka: ' + err.message, 'error');
  }
});

fetchMTBtn.addEventListener('click', async () => {
  const gsrn = detailGsrn.value.trim();
  if (!gsrn) { showStatus('Vnesite GSRN.', 'error'); return; }
  showStatus('Pridobivam podatke merilne točke…', 'info');
  try {
    const data = await apiFetch(`/api/merilna-tocka/${encodeURIComponent(gsrn)}`);
    detailTitle.textContent = `Merilna točka: ${gsrn}`;
    detailJson.textContent  = JSON.stringify(data, null, 2);
    detailPanel.style.display = '';
    showStatus('Podatki merilne točke pridobljeni.', 'success');
  } catch (err) {
    showStatus('Napaka: ' + err.message, 'error');
  }
});

// ── CSV Export ─────────────────────────────────────────────────
exportCsvBtn.addEventListener('click', () => {
  if (!lastTableData.length) return;
  const lines = [lastTableHeaders.join(',')];
  lastTableData.forEach(row => lines.push(row.map(v => `"${v ?? ''}"`).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ema_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
});

// ── Status bar ─────────────────────────────────────────────────
function showStatus(msg, type = 'info') {
  statusBar.textContent = msg;
  statusBar.className   = `status-bar ${type}`;
  if (type === 'success') {
    setTimeout(() => statusBar.classList.add('hidden'), 4000);
  }
}

// ── Helpers ────────────────────────────────────────────────────
function formatNum(n) {
  if (n == null || n === '') return '—';
  const f = parseFloat(n);
  return isNaN(f) ? n : f.toFixed(4);
}

function formatEur(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Number(n).toFixed(2)} EUR`;
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
