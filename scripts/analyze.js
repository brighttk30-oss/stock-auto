import fetch from 'node-fetch';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// ── INIT ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const OR_KEY = process.env.OPENROUTER_KEY;
const TD_KEY = process.env.TWELVE_DATA_KEY;   // Key 1: สำหรับ Portfolio analysis
const TD_KEY_2 = process.env.TWELVE_DATA_KEY_2; // Key 2: สำหรับ Watchlist ticker (shared cache)

// watchlist 30 ตัว สำหรับ AI แนะนำ
const WATCHLIST = [
  { s: 'AAPL', n: 'Apple' },      { s: 'MSFT', n: 'Microsoft' },
  { s: 'GOOGL', n: 'Google' },    { s: 'META', n: 'Meta' },
  { s: 'AMZN', n: 'Amazon' },     { s: 'TSLA', n: 'Tesla' },
  { s: 'NVDA', n: 'NVIDIA' },     { s: 'MU', n: 'Micron' },
  { s: 'AMD', n: 'AMD' },         { s: 'INTC', n: 'Intel' },
  { s: 'AVGO', n: 'Broadcom' },   { s: 'QCOM', n: 'Qualcomm' },
  { s: 'ALAB', n: 'Astera Labs' },{ s: 'STX', n: 'Seagate' },
  { s: 'WDC', n: 'West Digital' },{ s: 'V', n: 'Visa' },
  { s: 'MA', n: 'Mastercard' },   { s: 'JPM', n: 'JPMorgan' },
  { s: 'NFLX', n: 'Netflix' },    { s: 'DIS', n: 'Disney' },
  { s: 'PYPL', n: 'PayPal' },     { s: 'RIVN', n: 'Rivian' },
  { s: 'NIO', n: 'NIO' },         { s: 'QQQ', n: 'Nasdaq ETF' },
  { s: 'SPY', n: 'S&P500 ETF' },  { s: 'COIN', n: 'Coinbase' },
  { s: 'GLD', n: 'Gold ETF' },    { s: 'UBER', n: 'Uber' },
  { s: 'ABNB', n: 'Airbnb' },     { s: 'SNOW', n: 'Snowflake' }
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── TWELVE DATA: ดึงราคาแบบ batch ──
async function fetchPriceBatch(symbols, apiKey=TD_KEY) {
  const joined = symbols.join(',');
  try {
    const res = await fetch(
      `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(joined)}&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(20000) }
    );
    if(res.status === 429) {
      console.warn('⚠️ 429 Too Many Requests — หยุดชั่วคราว 60s');
      await sleep(60000);
      return {};
    }
    const data = await res.json();
    if(data.message?.toLowerCase().includes('run out') || data.code === 429) {
      console.warn('⚠️ Quota exhausted:', data.message);
      return { _quotaExhausted: true };
    }
    if (data.status === 'error') {
      console.error('TwelveData error:', data.message);
      return {};
    }
    // 1 symbol → object ตรง, หลาย symbol → nested object
    const entries = symbols.length === 1 ? { [symbols[0]]: data } : data;
    const result = {};
    Object.entries(entries).forEach(([sym, q]) => {
      if (!q || q.status === 'error' || !q.close) return;
      const cur = parseFloat(q.close);
      const prev = parseFloat(q.previous_close) || cur;
      const high52 = parseFloat(q['52_week']?.high || q.fifty_two_week?.high || cur);
      const low52 = parseFloat(q['52_week']?.low || q.fifty_two_week?.low || cur);
      result[sym] = {
        current: cur,
        prev,
        changePct: prev > 0 ? ((cur - prev) / prev * 100) : 0,
        high52: isNaN(high52) ? cur : high52,
        low52: isNaN(low52) ? cur : low52
      };
    });
    return result;
  } catch(e) {
    console.error('fetchPriceBatch error:', e.message);
    return {};
  }
}

// ── OPENROUTER AI ──
async function callAI(prompt, maxTokens = 900) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OR_KEY}`,
      'X-Title': 'StockAI Auto Analysis'
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4-5',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.choices?.[0]?.message?.content || '';
}

// ── MODE: วิเคราะห์พอร์ต user ทั้งหมด (21:00) ──
async function analyzeUserPortfolios() {
  console.log(`\n📊 MODE: Analyze User Portfolios (21:00)`);

  // ดึง users ทั้งหมดที่เป็น Premium
  const usersSnap = await db.collection('users').get();
  let processed = 0;

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    try {
      // เช็ค profile
      const profSnap = await db.doc(`users/${uid}/profile/data`).get();
      if (!profSnap.exists) continue;
      const prof = profSnap.data();
      const isPremium = (prof.plan === 'premium' || prof.plan === 'trial') && prof.planExpiry > Date.now();
      if (!isPremium) continue;

      // ดึง portfolio
      const portSnap = await db.doc(`users/${uid}/portfolio/main`).get();
      if (!portSnap.exists) continue;
      const portData = portSnap.data();
      const holdings = portData.holdings || [];
      if (!holdings.length) continue;

      console.log(`\n👤 User: ${prof.email} | ${holdings.length} holdings`);

      // ดึงราคา holdings
      const usTickers = holdings.filter(h => h.type === 'US').map(h => h.ticker);
      let priceMap = {};
      if (usTickers.length) {
        for (let i = 0; i < usTickers.length; i += 8) {
          const batch = usTickers.slice(i, i + 8);
          const res = await fetchPriceBatch(batch, TD_KEY);
          if(res._quotaExhausted) { console.warn('TD_KEY quota หมด'); break; }
          Object.assign(priceMap, res);
          if(i + 8 < usTickers.length) await sleep(10000);
        }
      }

      const now = new Date();
      const thaiDate = now.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' });
      const thaiTime = now.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
      const aiCache = { ...(portData.aiCache || {}) };

      // วิเคราะห์แต่ละตัว
      for (const h of holdings) {
        console.log(`  📈 Analyzing ${h.ticker}...`);
        const p = priceMap[h.ticker];
        const pInfo = p
          ? `ราคาปิด $${p.current.toFixed(2)} (${p.changePct >= 0 ? '+' : ''}${p.changePct.toFixed(2)}% วันนี้) 52W H:$${p.high52.toFixed(2)} L:$${p.low52.toFixed(2)}`
          : 'ไม่มีข้อมูลราคา';

        const prompt = `วิเคราะห์หุ้น ${h.ticker} (${h.name || h.ticker}) ${pInfo} วันที่ ${thaiDate}
ตอบ JSON เท่านั้น ไม่มี markdown ไม่มี backtick:
{"bull":"มุมมองขาขึ้น 2-3 ประโยคไทย","bear":"มุมมองขาลง 2-3 ประโยคไทย","summary":"สรุป+คำแนะนำ 2 ประโยคไทย","target":"$xxx หรือ $xxx-$xxx","sentiment":"BULLISH หรือ BEARISH หรือ NEUTRAL"}`;

        try {
          const text = await callAI(prompt, 900);
          const clean = text.replace(/```json|```/g, '').trim();
          const result = JSON.parse(clean);
          const sentMap = { BULLISH: '▲ BULLISH', BEARISH: '▼ BEARISH', NEUTRAL: '◆ NEUTRAL' };
          const clsMap = { BULLISH: 'bull', BEARISH: 'bear', NEUTRAL: 'neut' };
          aiCache[h.ticker] = {
            ...result,
            sentiment: sentMap[result.sentiment] || '◆ NEUTRAL',
            sentimentClass: clsMap[result.sentiment] || 'neut',
            time: thaiTime
          };
          console.log(`    ✅ ${h.ticker}: ${result.sentiment} | Target: ${result.target}`);
        } catch(e) {
          console.error(`    ❌ ${h.ticker}:`, e.message);
        }
        await sleep(800);
      }

      // ดึงข่าว
      console.log(`  📰 Fetching news...`);
      const tickers = holdings.map(h => h.ticker).join(', ');
      const newsCount = Math.min(holdings.length * 2, 8);
      const newsPrompt = `ข่าวล่าสุด ${newsCount} ข่าวเกี่ยวกับหุ้น: ${tickers} วันที่ ${thaiDate}
ตอบ JSON array เท่านั้น ไม่มี markdown ไม่มี backtick:
[{"ticker":"X","title":"หัวข่าวไทย","summary":"สรุปผลกระทบ 1 ประโยคไทย","impact":"POSITIVE หรือ NEGATIVE หรือ NEUTRAL","time":"Xh ago"}]`;

      let newsCache = portData.newsCache || [];
      try {
        const text = await callAI(newsPrompt, 1200);
        let clean = text.replace(/```json|```/g, '').trim();
        if (!clean.endsWith(']')) {
          const lb = clean.lastIndexOf('}');
          if (lb > 0) clean = clean.substring(0, lb + 1) + ']';
        }
        newsCache = JSON.parse(clean);
        console.log(`    ✅ Got ${newsCache.length} news`);
      } catch(e) {
        console.error(`    ❌ News:`, e.message);
      }

      // บันทึก priceCache เพื่อให้ browser โหลดราคาได้ทันทีตอนเปิดหน้า
      const priceCache = {};
      holdings.forEach(h => {
        if(priceMap[h.ticker]) {
          const p = priceMap[h.ticker];
          priceCache[h.ticker] = {
            current: p.current,
            prev: p.prev || p.current,
            change: p.current - (p.prev || p.current),
            changePct: p.changePct || 0,
            high52: p.high52 || p.current,
            low52: p.low52 || p.current,
            dayHigh: p.current,
            dayLow: p.current,
            cachedAt: now.toISOString()
          };
        }
      });

      // Save
      await db.doc(`users/${uid}/portfolio/main`).set({
        holdings, aiCache, newsCache, priceCache,
        lastNewsTime: Date.now(),
        autoUpdatedAt: now.toISOString()
      }, { merge: true });

      processed++;
      console.log(`  💾 Saved user ${prof.email}`);

      // ── Line Notify: ส่งสรุปพอร์ตถ้ามี token ──
      const lineToken = prof.lineToken || '';
      if (lineToken && Object.keys(aiCache).length > 0) {
        const bullish = Object.entries(aiCache)
          .filter(([,v]) => v.sentiment?.includes('BULLISH'))
          .map(([k]) => k).join(', ');
        const bearish = Object.entries(aiCache)
          .filter(([,v]) => v.sentiment?.includes('BEARISH'))
          .map(([k]) => k).join(', ');
        let msg = `
📊 StockAI วิเคราะห์ ${thaiDate} ${thaiTime}
`;
        if (bullish) msg += `🟢 BULLISH: ${bullish}
`;
        if (bearish) msg += `🔴 BEARISH: ${bearish}
`;
        msg += `
🔗 ดูรายละเอียด: https://brighttk30-oss.github.io/stock-auto/stock-dashboard.html`;
        await sendLineNotify(lineToken, msg);
      }

      await sleep(1000);
    } catch(e) {
      console.error(`❌ User ${uid}:`, e.message);
    }
  }
  console.log(`\n✅ Done: ${processed} users analyzed`);
}

// ── MODE: วิเคราะห์ watchlist 30 ตัว + สร้าง recommendation (08:00) ──
async function analyzeWatchlistAndRecommend() {
  console.log(`\n🌅 MODE: Watchlist Analysis + Recommendations (08:00)`);

  const now = new Date();
  const thaiDate = now.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' });
  const thaiTime = now.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });

  // ── ขั้นตอน 1: ดึงราคาปิดล่าสุด 30 ตัว ──
  console.log(`\n📡 Fetching prices for 30 watchlist stocks...`);
  const allSyms = WATCHLIST.map(w => w.s);
  const priceMap = {};

  // Rate limit: 8 req/min = 1 req ทุก 7.5s
  // batch 8 ตัว = 1 req, delay 10s = ปลอดภัย (6 req/min)
  for (let i = 0; i < allSyms.length; i += 8) {
    const batch = allSyms.slice(i, i + 8);
    console.log(`  Batch ${Math.floor(i/8)+1}: ${batch.join(', ')}`);
    const res = await fetchPriceBatch(batch, TD_KEY_2); // ใช้ KEY_2 แยก quota
    if(res._quotaExhausted) { console.warn('KEY_2 quota หมด'); break; }
    Object.assign(priceMap, res);
    if(i + 8 < allSyms.length) await sleep(10000); // 10s ระหว่าง batch
  }

  const priceCount = Object.keys(priceMap).length;
  console.log(`✅ Got prices for ${priceCount}/${allSyms.length} stocks`);

  // ── ขั้นตอน 2: ส่งให้ AI วิเคราะห์ทั้งหมดในครั้งเดียว ──
  console.log(`\n🤖 AI analyzing all stocks...`);

  const stockData = WATCHLIST
    .filter(w => priceMap[w.s])
    .map(w => {
      const p = priceMap[w.s];
      const fromHigh = p.high52 > 0 ? ((p.high52 - p.current) / p.high52 * 100).toFixed(1) : 'N/A';
      const fromLow = p.low52 > 0 ? ((p.current - p.low52) / p.low52 * 100).toFixed(1) : 'N/A';
      return `${w.s} (${w.n}): ราคาปิด $${p.current.toFixed(2)} | เปลี่ยน ${p.changePct >= 0 ? '+' : ''}${p.changePct.toFixed(2)}% | 52W H:$${p.high52.toFixed(2)} L:$${p.low52.toFixed(2)} | ห่างจาก High ${fromHigh}% | เหนือ Low ${fromLow}%`;
    }).join('\n');

  const todayIsMonday = now.toLocaleDateString('en-US', { timeZone: 'Asia/Bangkok', weekday: 'long' }) === 'Monday';
  const mondayNote = todayIsMonday ? '\n⚠️ หมายเหตุ: ราคานี้คือราคาปิดวันศุกร์ที่แล้ว อาจมีข่าวสุดสัปดาห์กระทบ' : '';

  const prompt = `วันที่ ${thaiDate}${mondayNote}
ข้อมูลราคาปิดตลาด US ล่าสุด (ตลาดปิดแล้ว รอเปิดตอนเย็น):

${stockData}

วิเคราะห์และเลือกเฉพาะหุ้นที่น่าซื้อเมื่อตลาดเปิดวันนี้ โดยพิจารณาจาก:
1. ราคาใกล้แนวรับ (ห่างจาก 52W Low ไม่มาก)
2. Momentum ดี (% change เป็นบวก หรือ recovery จาก Low)
3. Risk/Reward คุ้มค่า

ถ้าไม่มีหุ้นน่าซื้อเลย ให้ recs เป็น array ว่าง

ตอบ JSON เท่านั้น ไม่มี markdown ไม่มี backtick:
{
  "date": "${thaiDate}",
  "marketSentiment": "BULLISH หรือ BEARISH หรือ NEUTRAL",
  "marketSummary": "สรุปภาพรวมตลาดวันนี้ 1-2 ประโยคไทย",
  "recs": [
    {
      "ticker": "XXXX",
      "name": "ชื่อบริษัท",
      "currentPrice": 0.00,
      "entryZone": "$xxx-$xxx",
      "targetPrice": "$xxx",
      "stopLoss": "$xxx",
      "reason": "เหตุผลสั้นๆ 1 ประโยคไทย",
      "risk": "LOW หรือ MEDIUM หรือ HIGH"
    }
  ]
}`;

  let recData = { date: thaiDate, marketSentiment: 'NEUTRAL', marketSummary: 'ไม่สามารถวิเคราะห์ได้', recs: [] };

  try {
    const text = await callAI(prompt, 2000);
    const clean = text.replace(/```json|```/g, '').trim();
    recData = JSON.parse(clean);
    console.log(`✅ Market: ${recData.marketSentiment} | ${recData.recs?.length || 0} recommendations`);
    recData.recs?.forEach(r => {
      console.log(`  📌 ${r.ticker}: เข้า ${r.entryZone} | Target ${r.targetPrice} | ${r.risk} risk`);
    });
  } catch(e) {
    console.error('❌ AI recommendation error:', e.message);
  }

  // ── ขั้นตอน 3: เก็บใน Firestore ที่ marketData/recommendations ──
  await db.doc('marketData/recommendations').set({
    ...recData,
    priceSnapshot: priceMap,
    updatedAt: now.toISOString(),
    thaiTime
  });

  console.log(`\n💾 Saved recommendations to Firestore: marketData/recommendations`);

  // ── ขั้นตอน 4: update stats ──
  await updateStats();

  // ── ขั้นตอน 5: วิเคราะห์พอร์ต user + Line Notify ──
  await analyzeUserPortfolios();
}

// ── LINE NOTIFY ──
async function sendLineNotify(token, message) {
  if (!token) return;
  try {
    const res = await fetch('https://notify-api.line.me/api/notify', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'message=' + encodeURIComponent(message)
    });
    const ok = res.status === 200;
    console.log(`Line Notify: ${ok ? '✅ sent' : '❌ failed ' + res.status}`);
  } catch(e) {
    console.warn('Line Notify error:', e.message);
  }
}

// ── UPDATE STATS (marketData/stats) ──
async function updateStats() {
  try {
    console.log(`\n📊 Updating stats...`);
    const usersSnap = await db.collection('users').get();
    let totalUsers = 0, premiumUsers = 0;
    for (const userDoc of usersSnap.docs) {
      try {
        const prof = await db.doc(`users/${userDoc.id}/profile/data`).get();
        if (!prof.exists) continue;
        totalUsers++;
        const d = prof.data();
        const isPrem = (d.plan === 'premium' || d.plan === 'trial') && d.planExpiry > Date.now();
        if (isPrem) premiumUsers++;
      } catch(e) {}
    }
    await db.doc('marketData/stats').set({
      totalUsers, premiumUsers,
      updatedAt: new Date().toISOString()
    });
    console.log(`✅ Stats: ${totalUsers} users, ${premiumUsers} premium`);
  } catch(e) {
    console.error('updateStats error:', e.message);
  }
}

// ── MODE: ดึงราคา watchlist → Firestore shared cache (ทุก 20 นาที) ──
// ใช้ TD_KEY_2 แยกจาก TD_KEY เพื่อไม่กิน quota ของ portfolio
async function fetchWatchlistPrices() {
  if(!TD_KEY_2) {
    console.warn('⚠️ TWELVE_DATA_KEY_2 not set — skip watchlist fetch');
    return;
  }

  const now = new Date();
  const thaiTime = now.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  console.log(`\n📊 Fetching watchlist prices at ${thaiTime}`);

  const allSyms = WATCHLIST.map(w => w.s);
  const priceMap = {};
  let successCount = 0;
  let quotaExhausted = false;

  // ดึงทีละ batch 8 ตัว
  for(let i = 0; i < allSyms.length; i += 8) {
    if(quotaExhausted) break;

    const batch = allSyms.slice(i, i + 8);
    console.log(`  Batch ${Math.floor(i/8)+1}: ${batch.join(', ')}`);

    try {
      // ใช้ TD_KEY_2 เพื่อแยก quota
      const joined = batch.join(',');
      const res = await fetch(
        `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(joined)}&apikey=${TD_KEY_2}`,
        { signal: AbortSignal.timeout(20000) }
      );

      // detect 429
      if(res.status === 429) {
        console.warn('  ⚠️ 429 Too Many Requests — quota exhausted for TD_KEY_2');
        quotaExhausted = true;
        break;
      }

      const data = await res.json();

      // detect quota message
      if(data.message && data.message.toLowerCase().includes('run out')) {
        console.warn('  ⚠️ Quota exhausted:', data.message);
        quotaExhausted = true;
        break;
      }

      // parse response (1 symbol = object, หลาย symbol = nested object)
      const entries = batch.length === 1 ? { [batch[0]]: data } : data;
      Object.entries(entries).forEach(([sym, q]) => {
        if(!q || q.status === 'error' || !q.close) return;
        const cur = parseFloat(q.close);
        const prev = parseFloat(q.previous_close) || cur;
        const high52 = parseFloat(q.fifty_two_week?.high || cur);
        const low52  = parseFloat(q.fifty_two_week?.low  || cur);
        priceMap[sym] = {
          price: cur,
          prev,
          change: cur - prev,
          changePct: prev > 0 ? ((cur - prev) / prev * 100) : 0,
          high52: isNaN(high52) ? cur : high52,
          low52:  isNaN(low52)  ? cur : low52,
        };
        successCount++;
      });

    } catch(e) {
      console.error(`  ❌ Batch error:`, e.message);
    }

    // หน่วง 1 วินาทีระหว่าง batch
    if(i + 8 < allSyms.length && !quotaExhausted) await sleep(1000);
  }

  console.log(`✅ Got prices: ${successCount}/${allSyms.length} symbols`);

  if(successCount === 0) {
    console.warn('No prices fetched — skip Firestore write');
    return;
  }

  // บันทึกใน Firestore: marketData/tickerPrices
  // browser ทุก user จะอ่านจาก document นี้แทนการยิง Twelve Data เอง
  await db.doc('marketData/tickerPrices').set({
    prices: priceMap,
    updatedAt: now.toISOString(),
    thaiTime,
    symbolCount: successCount,
    quotaExhausted
  });

  console.log(`💾 Saved to Firestore: marketData/tickerPrices`);
  if(quotaExhausted) console.warn('⚠️ Quota exhausted — partial data saved');
}

// ── MAIN ──
// ── COLLECT & CACHE PORTFOLIO PRICES → Firestore ──
// รวบรวม tickers ทุกตัวที่ users ถือ → ดึงราคา → บันทึก Firestore
// Browser จะอ่านจาก Firestore แทนยิง Twelve Data โดยตรง
async function collectAndCachePrices() {
  console.log(`
💰 Collecting portfolio prices for all users...`);
  const now = new Date();

  // รวบรวม unique tickers จากทุก user
  const usersSnap = await db.collection('users').get();
  const uniqueTickers = new Map(); // ticker → type

  for(const userDoc of usersSnap.docs) {
    try {
      const portSnap = await db.doc(`users/${userDoc.id}/portfolio/main`).get();
      if(!portSnap.exists) continue;
      const holdings = portSnap.data().holdings || [];
      holdings.forEach(h => {
        if(h.ticker && h.type && !uniqueTickers.has(h.ticker)) {
          uniqueTickers.set(h.ticker, h.type);
        }
      });
    } catch(e) {}
  }

  const tickers = [...uniqueTickers.entries()];
  console.log(`Found ${tickers.length} unique tickers across all users`);
  if(!tickers.length) return;

  // ดึงราคาทุกตัว (ใช้ TD_KEY หลัก — แยกจาก watchlist)
  const priceMap = {};
  const usTickers = tickers.filter(([,t]) => t==='US'||t==='ETF').map(([s])=>s);
  const goldTicker = tickers.filter(([,t]) => t==='GOLD').map(([s])=>s);
  const cryptoTickers = tickers.filter(([,t]) => t==='CRYPTO').map(([s])=>s);
  const thTickers = tickers.filter(([,t]) => t==='TH').map(([s])=>s);

  // ดึง US/ETF/GOLD/CRYPTO batch
  const allFetch = [
    ...usTickers,
    ...goldTicker.map(s => s==='XAUUSD'?'XAU/USD':s),
    ...cryptoTickers.map(s => s+'/USD'),
    ...thTickers.map(s => s.includes(':')?s:s+':SET')
  ];

  for(let i = 0; i < allFetch.length; i += 8) {
    const batch = allFetch.slice(i, i+8);
    try {
      const joined = batch.join(',');
      const res = await fetch(
        `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(joined)}&apikey=${TD_KEY}`,
        { signal: AbortSignal.timeout(20000) }
      );
      if(res.status === 429) { console.warn('⚠️ TD_KEY quota exhausted'); break; }
      const data = await res.json();
      if(data.message?.toLowerCase().includes('run out')) { console.warn('⚠️ Quota:', data.message); break; }

      const entries = batch.length===1 ? {[batch[0]]:data} : data;
      Object.entries(entries).forEach(([sym, q]) => {
        if(!q||q.status==='error'||!q.close) return;
        const cur = parseFloat(q.close);
        const prev = parseFloat(q.previous_close)||cur;
        // map symbol กลับเป็น ticker จริง
        const ticker = sym.replace('/USD','').replace(':SET','').replace('XAU/USD','XAUUSD');
        priceMap[ticker] = {
          price: cur,    // ใช้ 'price' ให้ตรงกับ tickerPrices structure
          current: cur,  // เก็บทั้งสองเพื่อ backward compat
          prev,
          change: cur-prev,
          changePct: prev>0?((cur-prev)/prev*100):0,
          high52: parseFloat(q.fifty_two_week?.high||q['52_week']?.high||cur),
          low52: parseFloat(q.fifty_two_week?.low||q['52_week']?.low||cur),
          dayHigh: parseFloat(q.high)||cur,
          dayLow: parseFloat(q.low)||cur,
          updatedAt: now.toISOString()
        };
      });
    } catch(e) { console.warn('Batch error:', e.message); }
    if(i+8 < allFetch.length) await sleep(10000); // 10s ระหว่าง batch (6 req/min)
  }

  console.log(`✅ Fetched ${Object.keys(priceMap).length}/${tickers.length} prices`);
  if(!Object.keys(priceMap).length) return;

  // บันทึกใน Firestore: marketData/portfolioPrices
  // Browser อ่านจาก document นี้ → แสดงราคาทันที
  await db.doc('marketData/portfolioPrices').set({
    prices: priceMap,
    updatedAt: now.toISOString(),
    thaiTime: now.toLocaleString('th-TH', {timeZone:'Asia/Bangkok'}),
    tickerCount: Object.keys(priceMap).length
  });
  console.log(`💾 Saved to Firestore: marketData/portfolioPrices`);

  // อัปเดต priceCache ของแต่ละ user ด้วย (fast path)
  for(const userDoc of usersSnap.docs) {
    try {
      const portSnap = await db.doc(`users/${userDoc.id}/portfolio/main`).get();
      if(!portSnap.exists) continue;
      const holdings = portSnap.data().holdings||[];
      const priceCache = {};
      holdings.forEach(h => {
        if(priceMap[h.ticker]) {
          const pm = priceMap[h.ticker];
          priceCache[h.ticker] = {
            ...pm,
            price: pm.current || pm.price,
            current: pm.current || pm.price
          };
        }
      });
      if(Object.keys(priceCache).length) {
        await db.doc(`users/${userDoc.id}/portfolio/main`).set(
          { priceCache, priceCacheUpdatedAt: now.toISOString() },
          { merge: true }
        );
      }
    } catch(e) {}
  }
  console.log(`✅ Updated priceCache for all users`);
}

async function main() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const thaiTime = now.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  const isManual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const inputMode = (process.env.INPUT_MODE || '').toLowerCase();

  console.log(`
🚀 StockAI Auto Analysis`);
  console.log(`📅 Bangkok: ${thaiTime}`);
  console.log(`🕐 UTC: ${utcHour}:${String(utcMin).padStart(2,'0')}`);
  console.log(`🔑 TD_KEY:${TD_KEY?'✅':'❌'} TD_KEY_2:${TD_KEY_2?'✅':'❌'}`);

  // ── ตัดสินใจ mode ──
  let mode = 'ticker';
  if(isManual && inputMode) {
    mode = inputMode;
  } else if(utcHour === 22) {
    mode = 'close';   // ตี 5 ไทย: เก็บราคาปิด
  } else if(utcHour === 1) {
    mode = 'morning'; // 08:00 ไทย: AI analysis
  } else if(utcHour === 13 && utcMin === 0) {
    mode = 'news';    // 20:00 ไทย: ข่าวสาร 1 ทุ่ม
  } else if((utcHour >= 14 && utcHour <= 20) || (utcHour === 13 && utcMin >= 30)) {
    mode = 'ticker';  // ตลาดเปิด: ราคา real-time
  } else {
    mode = 'close';   // นอกเวลา: เก็บราคา
  }

  console.log(`🎯 Mode: ${mode}
`);

  switch(mode) {
    case 'close':
      console.log('📦 เก็บราคาปิดตลาด US → Firestore');
      await collectAndCachePrices();
      if(TD_KEY_2) await fetchWatchlistPrices();
      break;
    case 'morning':
      console.log('🌅 AI analysis + recommendations');
      await analyzeWatchlistAndRecommend(); // AI + watchlist prices
      await sleep(20000); // รัก 20s
      await collectAndCachePrices(); // portfolio prices
      break;
    case 'news':
      console.log('📰 ข่าวสาร 1 ทุ่ม');
      await analyzeUserPortfolios();
      await collectAndCachePrices();
      break;
    case 'ticker':
      console.log('📊 ราคา real-time ช่วงตลาดเปิด');
      // แยก sequential — ไม่ parallel เพราะจะชนกัน rate limit
      if(TD_KEY_2) {
        await fetchWatchlistPrices(); // KEY_2: 30 ตัว ~60s
      }
      await sleep(15000); // รัก 15s ก่อนเริ่ม portfolio
      await collectAndCachePrices(); // KEY_1: portfolio users
      break;
    default:
      console.log('🔄 วิเคราะห์ portfolios');
      await analyzeUserPortfolios();
      await collectAndCachePrices();
  }

  console.log(`
🎉 Done!`);
}
main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
