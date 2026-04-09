/**
 * CryptoRadar — App Logic
 * Live data from CoinGecko public API
 * AI Chat powered by OpenAI (env var: OPENAI_API_KEY via /api/chat)
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
  // AI chat endpoint — proxied serverless function so the API key stays server-side
  // Set environment variable: OPENAI_API_KEY  in Vercel project settings
  CHAT_API: '/api/chat',
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
  chatHistory: [],                   // [{role, content}]
  chatLoading: false,
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
  t.style.borderColor = type === 'error' ? 'rgba(220,38,38,0.4)'
    : type === 'success' ? 'rgba(22,163,74,0.4)'
    : 'rgba(0,0,0,0.12)';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3200);
}

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
 * Early-Warning Radar
 */
function pickRadarCoins(coins, topPerformers) {
  const topIds = new Set(topPerformers.map(c => c.id));
  const candidates = coins.filter(c => !topIds.has(c.id) && c.sparkline_in_7d?.price?.length > 10);

  const scored = candidates.map(c => {
    const spark = c.sparkline_in_7d.price;
    const recent = spark.slice(-12);
    const prev   = spark.slice(-24, -12);

    let consecutiveUp = 0;
    for (let i = recent.length - 1; i > 0; i--) {
      if (recent[i] > recent[i - 1]) consecutiveUp++;
      else break;
    }

    const volRatio = c.total_volume / (c.market_cap || 1);
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const prevAvg   = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : recentAvg;
    const recoveryPct = prevAvg > 0 ? ((recentAvg - prevAvg) / prevAvg) * 100 : 0;

    const pct1h  = c.price_change_percentage_1h_in_currency  || 0;
    const pct24h = c.price_change_percentage_24h              || 0;

    let score = 0;
    score += Math.max(0, pct1h) * 3;
    score += Math.max(0, recoveryPct) * 2;
    score += consecutiveUp * 1.5;
    score += Math.min(volRatio * 100, 20);
    score -= Math.max(0, pct24h) * 0.5;

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
function drawSparkline(canvas, prices, isPositive, isRadar = false, enlarged = false) {
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

  const padX = enlarged ? 8 : 0;
  const padY = enlarged ? 10 : 4;

  const x = (i) => padX + (i / (prices.length - 1)) * (W - padX * 2);
  const y = (p) => padY + (1 - (p - min) / range) * (H - padY * 2);

  const gradColor = isRadar ? '#d97706' : isPositive ? '#16a34a' : '#dc2626';
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, gradColor + '28');
  grad.addColorStop(1, gradColor + '04');

  // Fill
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
    const px = x(i - 1), py = y(prices[i - 1]);
    const cx1 = px + (x(i) - px) / 2;
    const cx2 = x(i) - (x(i) - px) / 2;
    ctx.bezierCurveTo(cx1, py, cx2, y(p), x(i), y(p));
  });

  ctx.strokeStyle = gradColor;
  ctx.lineWidth  = enlarged ? 2 : 1.5;
  ctx.lineJoin   = 'round';
  ctx.lineCap    = 'round';
  ctx.stroke();

  if (enlarged) {
    // Grid lines
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(t => {
      const lineY = padY + t * (H - padY * 2);
      ctx.beginPath();
      ctx.moveTo(padX, lineY);
      ctx.lineTo(W - padX, lineY);
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  // End dot
  const lastX = x(prices.length - 1);
  const lastY = y(prices[prices.length - 1]);
  ctx.beginPath();
  ctx.arc(lastX, lastY, enlarged ? 4 : 2.5, 0, Math.PI * 2);
  ctx.fillStyle = gradColor;
  ctx.shadowColor = gradColor;
  ctx.shadowBlur  = enlarged ? 10 : 6;
  ctx.fill();
  ctx.shadowBlur  = 0;
}

/* ====================================================
   CHART MODAL (Enlarge Graph)
   ==================================================== */
function openChartModal(coin, prices, isPositive, isRadar) {
  const overlay = $('#chartModalOverlay');
  const change  = getChangeForTimeframe(coin, state.selectedTimeframe);
  const isPos   = isRadar ? coin.price_change_percentage_24h >= 0 : isPositive;

  $('#chartModalIcon').src = coin.image;
  $('#chartModalIcon').alt = coin.name;
  $('#chartModalName').textContent = coin.name;
  $('#chartModalSymbol').textContent = coin.symbol.toUpperCase();
  $('#chartModalPrice').textContent = fmt(coin.current_price);

  const changeEl = $('#chartModalChange');
  const pctVal = isRadar ? coin.price_change_percentage_24h : change;
  changeEl.textContent = (isPos ? '▲ ' : '▼ ') + fmtPct(Math.abs(pctVal || 0));
  changeEl.className = `price-change ${isPos ? 'up' : 'down'}`;

  // Stats grid
  $('#chartModalStats').innerHTML = `
    <div class="chart-modal-stat">
      <span class="label">Market Cap</span>
      <span class="value">${fmtCap(coin.market_cap)}</span>
    </div>
    <div class="chart-modal-stat">
      <span class="label">Vol 24h</span>
      <span class="value">${fmtVol(coin.total_volume)}</span>
    </div>
    <div class="chart-modal-stat">
      <span class="label">High 24h</span>
      <span class="value">${fmt(coin.high_24h)}</span>
    </div>
    <div class="chart-modal-stat">
      <span class="label">Low 24h</span>
      <span class="value">${fmt(coin.low_24h)}</span>
    </div>
  `;

  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  requestAnimationFrame(() => {
    const canvas = $('#chartModalCanvas');
    drawSparkline(canvas, prices, isPos, isRadar, true);
  });
}

function closeChartModal() {
  $('#chartModalOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

function initChartModal() {
  $('#chartModalClose').addEventListener('click', closeChartModal);
  $('#chartModalOverlay').addEventListener('click', (e) => {
    if (e.target === $('#chartModalOverlay')) closeChartModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeChartModal();
  });
}

/* ====================================================
   CARD BUILDERS
   ==================================================== */
function buildTopCard(coin, rank, tf) {
  const change = getChangeForTimeframe(coin, tf);
  const isPos  = change >= 0;
  const spark  = coin.sparkline_in_7d?.price ?? [];
  const sparkSlice = tf === 1 ? spark.slice(-12) : tf === 24 ? spark.slice(-24) : spark;

  const card = document.createElement('div');
  card.className = `card ${isPos ? 'positive' : 'negative'} card-enter`;
  card.style.animationDelay = `${rank * 60}ms`;
  card.setAttribute('data-coin-id', coin.id);

  card.innerHTML = `
    <button class="card-expand-btn" title="Expand chart" aria-label="Expand chart">⤢</button>
    <div class="card-rank">${rank + 1}</div>
    <div class="card-top">
      <img class="coin-icon" src="${coin.image}" alt="${coin.name}" loading="lazy"
           onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 36 36%22><circle cx=%2218%22 cy=%2218%22 r=%2218%22 fill=%22%23eef2f7%22/><text x=%2218%22 y=%2223%22 text-anchor=%22middle%22 fill=%22%2394a3b8%22 font-size=%2214%22>${coin.symbol[0].toUpperCase()}</text></svg>'"/>
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

  requestAnimationFrame(() => {
    const canvas = card.querySelector('canvas');
    if (canvas && sparkSlice.length) drawSparkline(canvas, sparkSlice, isPos, false);
  });

  addSparklineTooltip(card, sparkSlice, coin, tf);

  // Expand button & sparkline click
  const expandBtn = card.querySelector('.card-expand-btn');
  expandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openChartModal(coin, sparkSlice, isPos, false);
  });
  card.querySelector('.sparkline-container').addEventListener('click', () => {
    openChartModal(coin, sparkSlice, isPos, false);
  });

  return card;
}

function buildRadarCard(scored, rank) {
  const { coin, signals, score, pct1h, pct24h, volRatio } = scored;
  const spark = coin.sparkline_in_7d?.price ?? [];
  const sparkSlice = spark.slice(-24);
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
    <button class="card-expand-btn" title="Expand chart" aria-label="Expand chart">⤢</button>
    <div class="card-rank">${rank + 1}</div>
    <div class="card-top">
      <img class="coin-icon" src="${coin.image}" alt="${coin.name}" loading="lazy"
           onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 36 36%22><circle cx=%2218%22 cy=%2218%22 r=%2218%22 fill=%22%23eef2f7%22/><text x=%2218%22 y=%2223%22 text-anchor=%22middle%22 fill=%22%2394a3b8%22 font-size=%2214%22>${coin.symbol[0].toUpperCase()}</text></svg>'"/>
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

  const expandBtn = card.querySelector('.card-expand-btn');
  expandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openChartModal(coin, sparkSlice, pct24h >= 0, true);
  });
  card.querySelector('.sparkline-container').addEventListener('click', () => {
    openChartModal(coin, sparkSlice, pct24h >= 0, true);
  });

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
  if (showLoader) setStatus('loading');

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

    if (!showLoader) showToast('Data refreshed ✓', 'success');

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
  state.refreshTimer = setInterval(() => loadData(false), CONFIG.REFRESH_INTERVAL);
}

/* ====================================================
   RESPONSIVE SPARKLINE RESIZE
   ==================================================== */
function handleResize() {
  document.querySelectorAll('.card[data-coin-id]').forEach(card => {
    const coinId = card.getAttribute('data-coin-id');
    const coin   = state.allCoins.find(c => c.id === coinId);
    if (!coin) return;
    const canvas  = card.querySelector('canvas');
    const isRadar = card.classList.contains('radar');
    const spark   = coin.sparkline_in_7d?.price ?? [];
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
   AI CHATBOT
   Environment variable required: OPENAI_API_KEY
   Set this in Vercel → Project Settings → Environment Variables
   The value should be your OpenAI API key (starts with sk-...)
   ==================================================== */
function appendMessage(role, content) {
  const messages = $('#chatbotMessages');
  const wrap = document.createElement('div');
  wrap.className = `chat-message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'chat-avatar';
  avatar.textContent = role === 'assistant' ? '🤖' : 'You';

  const bubbleWrap = document.createElement('div');
  bubbleWrap.style.display = 'flex';
  bubbleWrap.style.flexDirection = 'column';
  bubbleWrap.style.alignItems = role === 'user' ? 'flex-end' : 'flex-start';

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.textContent = content;

  const time = document.createElement('div');
  time.className = 'chat-bubble-time';
  time.textContent = nowTime();

  bubbleWrap.appendChild(bubble);
  bubbleWrap.appendChild(time);
  wrap.appendChild(avatar);
  wrap.appendChild(bubbleWrap);
  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function showTypingIndicator() {
  const messages = $('#chatbotMessages');
  const wrap = document.createElement('div');
  wrap.className = 'chat-message assistant';
  wrap.id = 'typingIndicator';

  const avatar = document.createElement('div');
  avatar.className = 'chat-avatar';
  avatar.textContent = '🤖';

  const typing = document.createElement('div');
  typing.className = 'chat-typing';
  typing.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';

  wrap.appendChild(avatar);
  wrap.appendChild(typing);
  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
}

function hideTypingIndicator() {
  const el = $('#typingIndicator');
  if (el) el.remove();
}

function buildMarketContext() {
  if (!state.allCoins.length) return '';
  const top3 = state.topPerformers.slice(0, 3).map(c =>
    `${c.name} (${c.symbol.toUpperCase()}) ${fmtPct(getChangeForTimeframe(c, state.selectedTimeframe))}`
  ).join(', ');
  const btcDom = $('#btcDominance')?.textContent || '—';
  const mcap   = $('#totalMarketCap')?.textContent || '—';
  return `\n\n[Live context] BTC Dominance: ${btcDom}, Total Mkt Cap: ${mcap}. Top performers: ${top3}.`;
}

async function sendChatMessage(userText) {
  if (!userText.trim() || state.chatLoading) return;

  state.chatLoading = true;
  const sendBtn = $('#chatbotSendBtn');
  sendBtn.disabled = true;

  appendMessage('user', userText);
  $('#chatbotInput').value = '';

  // Add live market context to system message
  const systemPrompt = `You are a knowledgeable crypto and financial markets AI assistant embedded in a live cryptocurrency dashboard called CryptoRadar. 
Answer questions about crypto markets, trading, DeFi, tokenomics, technical analysis, and market psychology.
Be concise, helpful, and educational. Do not provide financial advice — always remind users to DYOR (do your own research).
When relevant, refer to the live market context provided.${buildMarketContext()}`;

  state.chatHistory.push({ role: 'user', content: userText });

  showTypingIndicator();

  try {
    const res = await fetch(CONFIG.CHAT_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          ...state.chatHistory,
        ],
        model: 'gpt-4o-mini',
        max_tokens: 600,
        temperature: 0.7,
      }),
    });

    hideTypingIndicator();

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const errMsg = errData.error || `API error ${res.status}`;
      appendMessage('assistant', `⚠️ ${errMsg}`);
      state.chatHistory.pop();
      return;
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';
    state.chatHistory.push({ role: 'assistant', content: reply });
    appendMessage('assistant', reply);

    // Keep history trimmed to last 20 messages
    if (state.chatHistory.length > 20) {
      state.chatHistory = state.chatHistory.slice(-20);
    }

  } catch (err) {
    hideTypingIndicator();
    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      appendMessage('assistant', '⚠️ Could not reach the AI API. Make sure the OPENAI_API_KEY environment variable is set in Vercel and the /api/chat serverless function is deployed.');
    } else {
      appendMessage('assistant', `⚠️ Error: ${err.message}`);
    }
    state.chatHistory.pop();
  } finally {
    state.chatLoading = false;
    sendBtn.disabled = false;
    $('#chatbotInput').focus();
  }
}

function initChatbot() {
  const panel      = $('#chatbotPanel');
  const toggleBtn  = $('#chatToggleBtn');
  const closeBtn   = $('#chatbotCloseBtn');
  const input      = $('#chatbotInput');
  const sendBtn    = $('#chatbotSendBtn');

  // Welcome message
  appendMessage('assistant', '👋 Hi! I\'m your Market AI Assistant. Ask me anything about crypto markets, trading strategies, technical analysis, or specific coins. I have live market data from your dashboard!');

  // Toggle open/close
  function openChat() {
    panel.classList.add('open');
    toggleBtn.classList.add('active');
    document.body.classList.add('chatbot-open');
    input.focus();
  }
  function closeChat() {
    panel.classList.remove('open');
    toggleBtn.classList.remove('active');
    document.body.classList.remove('chatbot-open');
  }

  toggleBtn.addEventListener('click', () => {
    panel.classList.contains('open') ? closeChat() : openChat();
  });
  closeBtn.addEventListener('click', closeChat);

  // Send button
  sendBtn.addEventListener('click', () => sendChatMessage(input.value));

  // Enter to send (Shift+Enter for newline)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage(input.value);
    }
  });

  // Auto-resize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  // Quick prompt buttons
  $$('.quick-prompt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const prompt = btn.dataset.prompt;
      input.value = prompt;
      sendChatMessage(prompt);
    });
  });
}

/* ====================================================
   BOOT
   ==================================================== */
function init() {
  initTimeSelector();
  initRefreshButton();
  initChartModal();
  initChatbot();
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
