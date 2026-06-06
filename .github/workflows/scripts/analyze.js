import fetch from 'node-fetch';

const OR_KEY = process.env.OPENROUTER_KEY;
const FB_PROJECT = process.env.FIREBASE_PROJECT_ID || 'stock-web-c2068';
const FB_API_KEY = process.env.FIREBASE_API_KEY;
const FB_URL = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

// ── FIREBASE REST API ──
async function fbGet(path) {
  const res = await fetch(`${FB_URL}/${path}?key=${FB_API_KEY}`);
  return res.json();
}
async function fbSet(path, data) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') fields[k] = { stringValue: v };
    else if (typeof v === 'number') fields[k] = { integerValue: v };
    else if (typeof v === 'object') fields[k] = { stringValue: JSON.stringify(v) };
  }
  const res = await fetch(`${FB_URL}/${path}?key=${FB_API_KEY}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  return res.json();
}

// ── YAHOO PRICE ──
async function getPrice(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
    const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`);
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (meta?.regularMarketPrice) {
      return {
        current: meta.regularMarketPrice,
        changePct: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100),
        high52: meta.fiftyTwoWeekHigh || meta.regularMarketPrice,
        low52: meta.fiftyTwoWeekLow || meta.regularMarketPrice
      };
    }
  } catch (e) {}
  return null;
}

// ── OPENROUTER AI ──
async function callAI(prompt, maxTokens = 800) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OR_KEY}`,
      'X-Title': 'Stock Portfolio Auto'
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

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── MAIN ──
async function main() {
  console.log('🤖 Auto Analysis started:', new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }));

  // Get holdings from Firebase
  const doc = await fbGet('portfolio/bright');
  const holdingsStr = doc.fields?.holdings?.stringValue;
  if (!holdingsStr) { console.log('No holdings found'); return; }
  const holdings = JSON.parse(holdingsStr);
  console.log(`Found ${holdings.length} holdings:`, holdings.map(h => h.ticker).join(', '));

  const aiCache = {};
  const now = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' });
  const today = new Date().toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' });

  // Analyze each ticker
  for (const h of holdings) {
    console.log(`\nAnalyzing ${h.ticker}...`);
    const sym = h.type === 'GOLD' ? 'GC=F' : h.ticker;
    const price = await getPrice(sym);
    const pInfo = price ? `ราคา $${price.current.toFixed(2)} (${price.changePct >= 0 ? '+' : ''}${price.changePct.toFixed(2)}% วันนี้) 52W H:$${price.high52?.toFixed(2)} L:$${price.low52?.toFixed(2)}` : '';

    const prompt = `วิเคราะห์หุ้น ${h.ticker} (${h.name || h.ticker}) ${pInfo} วันที่ ${today}
ตอบ JSON เท่านั้น ไม่มี markdown:
{"bull":"มุมมองขาขึ้น 2-3 ประโยคไทย","bear":"มุมมองขาลง 2-3 ประโยคไทย","summary":"สรุป+คำแนะนำ 2 ประโยคไทย","target":"$xxx","sentiment":"BULLISH หรือ BEARISH หรือ NEUTRAL"}`;

    try {
      const text = await callAI(prompt, 900);
      const data = JSON.parse(text.replace(/```json|```/g, '').trim());
      const sentMap = { BULLISH: '▲ BULLISH', BEARISH: '▼ BEARISH', NEUTRAL: '◆ NEUTRAL' };
      const sentCls = { BULLISH: 'bull', BEARISH: 'bear', NEUTRAL: 'neut' };
      aiCache[h.ticker] = { ...data, sentiment: sentMap[data.sentiment] || '◆ NEUTRAL', sentimentClass: sentCls[data.sentiment] || 'neut', time: now };
      console.log(`✅ ${h.ticker}: ${data.sentiment}`);
    } catch (e) {
      console.error(`❌ ${h.ticker}:`, e.message);
    }
    await sleep(800);
  }

  // Fetch news
  console.log('\nFetching news...');
  const tickers = holdings.map(h => h.ticker).join(', ');
  const newsPrompt = `ข่าวล่าสุด ${holdings.length * 2} ข่าวเกี่ยวกับ: ${tickers} วันที่ ${today}
JSON array เท่านั้น ไม่มี markdown:
[{"ticker":"X","title":"หัวข่าว","summary":"สรุป 1 ประโยค","impact":"POSITIVE หรือ NEGATIVE หรือ NEUTRAL","time":"Xh ago"}]`;

  let newsCache = [];
  try {
    const text = await callAI(newsPrompt, 1200);
    let clean = text.replace(/```json|```/g, '').trim();
    if (!clean.endsWith(']')) { const lb = clean.lastIndexOf('}'); if (lb > 0) clean = clean.substring(0, lb + 1) + ']'; }
    newsCache = JSON.parse(clean);
    console.log(`✅ Got ${newsCache.length} news items`);
  } catch (e) {
    console.error('❌ News error:', e.message);
  }

  // Save to Firebase
  await fbSet('portfolio/bright', {
    aiCache: JSON.stringify(aiCache),
    newsCache: JSON.stringify(newsCache),
    lastNewsTime: Date.now(),
    autoUpdatedAt: new Date().toISOString()
  });
  console.log('\n✅ Saved to Firebase successfully!');
}

main().catch(console.error);
