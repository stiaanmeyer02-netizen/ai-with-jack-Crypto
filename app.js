/**
 * CryptoRadar — App Logic
 * Live data from CoinGecko public API
 * No API key required
 */

/* ====================================================
   CONFIG
   ==================================================== */
const CONFIG = {
  API_BASE: 'https://api.coingecko.com/api/v3',
  REFRESH_INTERVAL: 90_000,           // 90 seconds auto-refresh
  TOP_COUNT: 100,                     // fetch top 100 to find best performers & radar
  SPARKLINE_POINTS: 24,               // hours of sparkline data
  VS_CURRENCY: 'usd',
};

/* ====================================================
   STATE
   ==================================================== */
let state = {
  allCoins: [],
  topPerformers: [],
  radarCoins: [],
  selectedTimeframe: 24,             // hours: 1, 24, 168
  refreshTimer: null,
  lastFetch: null,
};

/* ====================================================
   UTILITY HELPERS
   ==================================================== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function fmt(n, digits = 2) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return '$' + (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6)  return '$' + (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3)  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 1)    return '$' + n.toFixed(digits);
  if (abs >= 0.01) return '$' + n.toFixed(4);
  return '$' + n.toFixed(6);
}

function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return sign + n.toFixed(2) + '%';
}

function fmtVol(n) {
  if (!n) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

function fmtCap(n) {
  if (!n) return '—';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(1) + 'M';
  return n.toFixed(0);
}

function timeAgo(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

function showToast(msg, type = 'info') {
  const t = $('#toast');
  t.textContent = msg;
  t.style.borderColor = type === 'error' ? 'rgba(239,68,68,0.4)'
    : type === 'success' ? 'rgba(34,197,94,0.4)'
    : 'rgba(255,255,255,0.12)';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3200);
}

/* ====================================================
   API
   ==================================================== */
async function fetchCoins() {
  const endpoint = `${CONFIG.API_BASE}/coins/markets?vs_currency=${CONFIG.VS_CURRENCY}&order=market_cap_desc&per_page=${CONFIG.TOP_COUNT}&page=1&sparkline=true&price_change_percentage=1h,24h,7d`;
  const res = await fetch(endpoint, {
    headers: { 'Accept': 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

async function fetchGlobal() {
  const res = await fetch(`${CONFIG.API_BASE}/global`, { cache: 'no-store' });
  if (!res.ok) return null;
  const data = await res.json();
  return data.data;
}

/* ====================================================
   DATA PROCESSING
   ==================================================== */
function getChangeForTimeframe(coin, tf) {
  if (tf === 1)   return coin.price_change_percentage_1h_in_currency;
  if (tf === 168) return coin.price_change_percentage_7d_in_currency;
  return coin.price_change_percentage_24h;
}

function pickTopPerformers(coins, tf) {
  return [...coins]
    .filter(c => {
      const pct = getChangeForTimeframe(c, tf);
      return pct !== null && pct !== undefined && !isNaN(pct);
    })
    .sort((a, b) => getChangeForTimeframe(b, tf) - getChangeForTimeframe(a, tf))
    .slice(0, 5);
}

/**
 * Early-Warning Radar:
 * Score coins by a composite of:
 *  - Volume surge: current vol / market cap ratio above average
 *  - Momentum: price has risen consecutively over recent sparkline points
 *  - 1h change is positive but 24h change is modest (early, not pumped)
 *  - Not already in top 5 performers
 */
function pickRadarCoins(coins, topPerformers) {
  const topIds = new Set(topPerformers.map(c => c.id));

  const candidates = coins.filter(c => !topIds.has(c.id) && c.sparkline_in_7d?.price?.length > 10);

  const scored = candidates.map(c => {
    const spark = c.sparkline_in_7d.price;
    const recent = spark.slice(-12);         // last 12 hours
    const prev   = spark.slice(-24, -12);

    // Momentum: how many of last 6 candles were up
    let consecutiveUp = 0;
    for (let i = recent.length - 1; i > 0; i--) {
      if (recent[i] > recent[i - 1]) consecutiveUp++;
      else break;
    }

    // Volume surge ratio (vol/mcap, higher = more unusual activity)
    const volRatio = c.total_volume / (c.market_cap || 1);

    // Price recovery: recent avg vs prev avg
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const prevAvg   = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : recentAvg;
    const recoveryPct = prevAvg > 0 ? ((recentAvg - prevAvg) / prevAvg) * 100 : 0;

    const pct1h  = c.price_change_percentage_1h_in_currency  || 0;
    const pct24h = c.price_change_percentage_24h              || 0;

    // Composite score — higher is more "radar-worthy"
    let score = 0;
    score += Math.max(0, pct1h) * 3;                        // 1h positive momentum weighted heavily
    score += Math.max(0, recoveryPct) * 2;                   // recent vs older price recovery
    score += consecutiveUp * 1.5;                            // consecutive up bars
    score += Math.min(volRatio * 100, 20);                   // volume surge (capped)
    score -= Math.max(0, pct24h) * 0.5;                      // penalise if 24h is already huge (not early)

    const signals = [];
    if (volRatio > 0.05)       signals.push('vol');
    if (pct1h > 1)             signals.push('brk');
    if (consecutiveUp >= 2)    signals.push('rsi');
    if (recoveryPct > 2)       signals.push('mom');

    return { coin: c, score, signals, consecutiveUp, volRatio, recoveryPct, pct1h, pct24h };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/* ====================================================
   SPARKLINE RENDERER (Canvas)
   ==================================================== */
function drawSparkline(canvas, prices, isPositive, isRadar = false) {
  if (!canvas || !prices || prices.length < 2) return;

  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight;

  canvas.width  = W * dpr;
  canvas.height = H * dpr;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const padX = 0;
  const padY = 4;

  const x = (i) => padX + (i / (prices.length - 1)) * (W - padX * 2);
  const y = (p) => padY + (1 - (p - min) / range) * (H - padY * 2);

  // Gradient fill
  const gradColor = isRadar ? '#f59e0b' : isPositive ? '#22c55e' : '#ef4444';
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, gradColor + '30');
  grad.addColorStop(1, gradColor + '00');

  // Fill path
  ctx.beginPath();
  ctx.moveTo(x(0), H);
  prices.forEach((p, i) => ctx.lineTo(x(i), y(p)));
  ctx.lineTo(x(prices.length - 1), H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(x(0), y(prices[0]));
  prices.forEach((p, i) => {
    if (i === 0) return;
    // Smooth bezier
    const px = x(i - 1), py = y(prices[i - 1]);
    const cx1 = px + (x(i) - px) / 2;
    const cx2 = x(i) - (x(i) - px) / 2;
    ctx.bezierCurveTo(cx1, py, cx2, y(p), x(i), y(p));
  });

  ctx.strokeStyle = gradColor;
  ctx.lineWidth  = 1.5;
  ctx.lineJoin   = 'round';
  ctx.lineCap    = 'round';
  ctx.stroke();

  // End dot
  const lastX = x(prices.length - 1);
  const lastY = y(prices[prices.length - 1]);
  ctx.beginPath();
  ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = gradColor;
  ctx.shadowColor = gradColor;
  ctx.shadowBlur  = 6;
  ctx.fill();
  ctx.shadowBlur  = 0;
}

/* ====================================================
   CARD BUILDERS
   ==================================================== */
function buildTopCard(coin, rank, tf) {
  const change = getChangeForTimeframe(coin, tf);
  const isPos  = change >= 0;
  const spark  = coin.sparkline_in_7d?.price ?? [];
  // For 1h: take last 12 points; 24h: last 24; 7d: all
  const sparkSlice = tf === 1 ? spark.slice(-12) : tf === 24 ? spark.slice(-24) : spark;

  const card = document.createElement('div');
  card.className = `card ${isPos ? 'positive' : 'negative'} card-enter`;
  card.style.animationDelay = `${rank * 60}ms`;
  card.setAttribute('data-coin-id', coin.id);

  card.innerHTML = `
    <div class="card-rank">${rank + 1}</div>
    <div class="card-top">
      <img class="coin-icon" src="${coin.image}" alt="${coin.name}" loading="lazy"
           onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 36 36%22><circle cx=%2218%22 cy=%2218%22 r=%2218%22 fill=%22%231e2330%22/><text x=%2218%22 y=%2223%22 text-anchor=%22middle%22 fill=%22%238892a4%22 font-size=%2214%22>${coin.symbol[0].toUpperCase()}</text></svg>'"/>
      <div class="coin-names">
        <div class="coin-name">${coin.name}</div>
        <div class="coin-symbol">${coin.symbol}</div>
      </div>
    </div>
    <div class="card-price">
      <div class="price-value">${fmt(coin.current_price)}</div>
      <div class="price-change ${isPos ? 'up' : 'down'}">
        ${isPos ? '▲' : '▼'} ${fmtPct(Math.abs(change))}
      </div>
    </div>
    <div class="sparkline-container">
      <canvas></canvas>
    </div>
    <div class="card-metrics">
      <div class="metric">
        <div class="metric-label">Market Cap</div>
        <div class="metric-value">${fmtCap(coin.market_cap)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Vol 24h</div>
        <div class="metric-value">${fmtVol(coin.total_volume)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">High 24h</div>
        <div class="metric-value">${fmt(coin.high_24h)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Low 24h</div>
        <div class="metric-value">${fmt(coin.low_24h)}</div>
      </div>
    </div>
  `;

  // Draw sparkline after inserted
  requestAnimationFrame(() => {
    const canvas = card.querySelector('canvas');
    if (canvas && sparkSlice.length) {
      drawSparkline(canvas, sparkSlice, isPos, false);
    }
  });

  // Tooltip on sparkline hover
  addSparklineTooltip(card, sparkSlice, coin, tf);

  return card;
}

function buildRadarCard(scored, rank) {
  const { coin, signals, score, pct1h, pct24h, volRatio, consecutiveUp } = scored;
  const spark = coin.sparkline_in_7d?.price ?? [];
  const sparkSlice = spark.slice(-24);

  // Momentum strength 0–100 for the bar
  const momentum = Math.min(100, Math.round(score * 4));

  const card = document.createElement('div');
  card.className = `card radar card-enter`;
  card.style.animationDelay = `${rank * 70}ms`;
  card.setAttribute('data-coin-id', coin.id);

  const signalTags = signals.map(s => {
    const labels = { vol: '◈ Vol Surge', brk: '◎ Breakout', rsi: '▲ Momentum', mom: '⟳ Recovery' };
    return `<span class="signal-tag ${s}">${labels[s] || s}</span>`;
  }).join('');

  card.innerHTML = `
    <div class="card-rank">${rank + 1}</div>
    <div class="card-top">
      <img class="coin-icon" src="${coin.image}" alt="${coin.name}" loading="lazy"
           onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 36 36%22><circle cx=%2218%22 cy=%2218%22 r=%2218%22 fill=%22%231e2330%22/><text x=%2218%22 y=%2223%22 text-anchor=%22middle%22 fill=%22%238892a4%22 font-size=%2214%22>${coin.symbol[0].toUpperCase()}</text></svg>'"/>
      <div class="coin-names">
        <div class="coin-name">${coin.name}</div>
        <div class="coin-symbol">${coin.symbol}</div>
      </div>
    </div>
    <div class="card-price">
      <div class="price-value">${fmt(coin.current_price)}</div>
      <div class="price-change ${pct24h >= 0 ? 'up' : 'down'}">
        ${pct24h >= 0 ? '▲' : '▼'} ${fmtPct(Math.abs(pct24h))}
      </div>
    </div>
    <div class="sparkline-container">
      <canvas></canvas>
    </div>
    <div class="signals">${signalTags || '<span class="signal-tag vol">◈ Watching</span>'}</div>
    <div class="card-metrics">
      <div class="metric">
        <div class="metric-label">1h Move</div>
        <div class="metric-value" style="color:${pct1h >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtPct(pct1h)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Vol Ratio</div>
        <div class="metric-value" style="color:var(--amber)">${(volRatio * 100).toFixed(1)}%</div>
      </div>
    </div>
    <div class="momentum-bar">
      <div class="momentum-fill" data-momentum="${momentum}" style="width:0%"></div>
    </div>
  `;

  requestAnimationFrame(() => {
    const canvas = card.querySelector('canvas');
    if (canvas && sparkSlice.length) drawSparkline(canvas, sparkSlice, pct24h >= 0, true);
    const bar = card.querySelector('.momentum-fill');
    if (bar) setTimeout(() => { bar.style.width = `${momentum}%`; }, 100);
  });

  addSparklineTooltip(card, sparkSlice, coin, 24);
  return card;
}

function addSparklineTooltip(card, prices, coin, tf) {
  const container = card.querySelector('.sparkline-container');
  const tooltip = $('#tooltip');
  if (!container || !prices.length) return;

  container.addEventListener('mousemove', (e) => {
    const rect = container.getBoundingClientRect();
    const pct  = (e.clientX - rect.left) / rect.width;
    const idx  = Math.round(pct * (prices.length - 1));
    const p    = prices[Math.max(0, Math.min(idx, prices.length - 1))];
    const hoursAgo = prices.length - 1 - idx;
    tooltip.textContent = `${fmt(p)}  ·  ${hoursAgo}h ago`;
    tooltip.style.left   = `${e.clientX + 10}px`;
    tooltip.style.top    = `${e.clientY - 28}px`;
    tooltip.classList.add('visible');
  });

  container.addEventListener('mouseleave', () => {
    tooltip.classList.remove('visible');
  });
}

/* ====================================================
   MARKET BREADTH
   ==================================================== */
function updateBreadth(coins) {
  let up = 0, flat = 0, down = 0;
  coins.forEach(c => {
    const pct = c.price_change_percentage_24h;
    if (pct >  0.5) up++;
    else if (pct < -0.5) down++;
    else flat++;
  });
  const total = up + flat + down;
  if (!total) return;

  const upPct   = (up   / total * 100).toFixed(0);
  const flatPct = (flat / total * 100).toFixed(0);
  const downPct = (down / total * 100).toFixed(0);

  $('#breadthGreen').style.width = `${upPct}%`;
  $('#breadthAmber').style.width = `${flatPct}%`;
  $('#breadthRed').style.width   = `${downPct}%`;

  $('#breadthGreenLabel').textContent = `${up} Up`;
  $('#breadthAmberLabel').textContent = `${flat} Flat`;
  $('#breadthRedLabel').textContent   = `${down} Down`;

  const sentiment = up > down
    ? `${Math.round(up / total * 100)}% of top ${total} coins are rising`
    : `${Math.round(down / total * 100)}% of top ${total} coins are falling`;
  $('#breadthSummary').textContent = sentiment;
}

/* ====================================================
   RENDER
   ==================================================== */
function renderTopPerformers(coins, tf) {
  const grid = $('#topPerformersGrid');
  grid.innerHTML = '';
  coins.forEach((c, i) => grid.appendChild(buildTopCard(c, i, tf)));
}

function renderRadar(scored) {
  const grid = $('#radarGrid');
  grid.innerHTML = '';
  scored.forEach((s, i) => grid.appendChild(buildRadarCard(s, i)));
}

function renderGlobal(data) {
  if (!data) return;
  const btcDom = data.market_cap_percentage?.btc;
  const mcap   = data.total_market_cap?.usd;
  if (btcDom !== undefined) $('#btcDominance').textContent = btcDom.toFixed(1) + '%';
  if (mcap)                 $('#totalMarketCap').textContent = fmtCap(mcap);
}

/* ====================================================
   MAIN FETCH & REFRESH CYCLE
   ==================================================== */
async function loadData(showLoader = false) {
  const btn = $('#refreshBtn');
  btn.classList.add('spinning');

  if (showLoader) {
    setStatus('loading');
  }

  try {
    const [coins, global] = await Promise.all([fetchCoins(), fetchGlobal()]);

    state.allCoins       = coins;
    state.topPerformers  = pickTopPerformers(coins, state.selectedTimeframe);
    state.radarCoins     = pickRadarCoins(coins, state.topPerformers);
    state.lastFetch      = new Date();

    renderTopPerformers(state.topPerformers, state.selectedTimeframe);
    renderRadar(state.radarCoins);
    updateBreadth(coins);
    renderGlobal(global);

    setStatus('live');
    $('#lastUpdated').textContent = state.lastFetch.toLocaleTimeString();

    if (!showLoader) showToast('Data refreshed', 'success');

  } catch (err) {
    console.error('Fetch error:', err);
    setStatus('error');
    showToast('Failed to load data — retry in a moment', 'error');
  } finally {
    btn.classList.remove('spinning');
  }
}

function setStatus(s) {
  const dot  = $('#statusDot');
  const text = $('#statusText');
  dot.className = `pulse-dot ${s === 'live' ? 'live' : s === 'error' ? 'error' : ''}`;
  text.textContent = s === 'live' ? 'Live' : s === 'error' ? 'Error' : 'Loading…';
}

/* ====================================================
   TIME SELECTOR
   ==================================================== */
function initTimeSelector() {
  $$('.time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.time-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.selectedTimeframe = Number(btn.dataset.time);
      state.topPerformers = pickTopPerformers(state.allCoins, state.selectedTimeframe);
      renderTopPerformers(state.topPerformers, state.selectedTimeframe);
    });
  });
}

/* ====================================================
   REFRESH BUTTON
   ==================================================== */
function initRefreshButton() {
  $('#refreshBtn').addEventListener('click', () => {
    clearInterval(state.refreshTimer);
    loadData(false);
    scheduleRefresh();
  });
}

/* ====================================================
   AUTO REFRESH
   ==================================================== */
function scheduleRefresh() {
  state.refreshTimer = setInterval(() => {
    loadData(false);
  }, CONFIG.REFRESH_INTERVAL);
}

/* ====================================================
   RESPONSIVE SPARKLINE RESIZE
   ==================================================== */
function handleResize() {
  // Redraw all sparklines on resize
  document.querySelectorAll('.card[data-coin-id]').forEach(card => {
    const coinId = card.getAttribute('data-coin-id');
    const coin   = state.allCoins.find(c => c.id === coinId);
    if (!coin) return;
    const canvas = card.querySelector('canvas');
    const isRadar = card.classList.contains('radar');
    const spark = coin.sparkline_in_7d?.price ?? [];
    const sparkSlice = isRadar
      ? spark.slice(-24)
      : state.selectedTimeframe === 1 ? spark.slice(-12) : state.selectedTimeframe === 24 ? spark.slice(-24) : spark;
    const pct = isRadar
      ? coin.price_change_percentage_24h
      : getChangeForTimeframe(coin, state.selectedTimeframe);
    if (canvas && sparkSlice.length) drawSparkline(canvas, sparkSlice, pct >= 0, isRadar);
  });
}

/* ====================================================
   BOOT
   ==================================================== */
function init() {
  initTimeSelector();
  initRefreshButton();
  loadData(true);
  scheduleRefresh();

  // Debounce resize
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(handleResize, 200);
  });

  // Update "last updated" label every 30s
  setInterval(() => {
    if (state.lastFetch) {
      $('#lastUpdated').textContent = timeAgo(state.lastFetch);
    }
  }, 30_000);
}

document.addEventListener('DOMContentLoaded', init);
