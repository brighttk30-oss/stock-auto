import fetch from 'node-fetch';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// ── INIT ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const OR_KEY = process.env.OPENROUTER_KEY;

// ── YAHOO PRICE ──
async function getPrice(symbol) {
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`
  ];
  for (const url of urls) {
    try {
      const proxied = `https://corsproxy.io/?${encodeURIComponent(url)}`;
      const res = await fetch(proxied, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        return {
          current: meta.regularMarketPrice,
          prev: meta.chartPreviousClose || meta.regularMarketPrice,
          changePct: ((meta.regularMarketPrice - (meta.chartPreviousClose || meta.regularMarketPrice)) / (meta.chartPreviousClose || meta.regularMarketPrice) * 100),
          high52: meta.fiftyTwoWeekHigh || meta.regularMarketPrice,
          low52: meta.fiftyTwoWeekLow || meta.regularMarketPrice
        };
      }
    } catch (e) { continue; }
  }
  // fallback direct
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        return {
          current: meta.regularMarketPrice,
          prev: meta.chartPreviousClose || meta.regularMarketPrice,
          changePct: ((meta.regularMarketPrice - (meta.chartPreviousClose || meta.regularMarketPrice)) / (meta.chartPreviousClose || meta.regularMarketPrice) * 100),
          high52: meta.fiftyTwoWeekHigh || meta.regularMarketPrice,
          low52: meta.fiftyTwoWeekLow || meta.regularMarketPrice
        };
      }
    } catch (e) { continue; }
  }
  return null;
}

// ── OPENROUTER AI ──
async function callAI(prompt, maxTokens = 900) {
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── MAIN ──
async function main() {
  const now = new Date();
  const thaiTime = now.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  console.log('🤖 Auto Analysis started:', thaiTime);

  // Read holdings from Firestore
  const docRef = db.collection('portfolio').doc('bright');
  const snap = await docRef.get();

  if (!snap.exists) {
    console.log('❌ No document found at portfolio/bright');
    return;
  }

  const data = snap.data();
  const holdings = data.holdings || [];

  if (!holdings.length) {
    console.log('❌ No holdings found in document');
    return;
  }

  console.log(`✅ Found ${holdings.length} holdings:`, holdings.map(h => h.ticker).join(', '));

  const aiCache = { ...( data.aiCache || {} ) };
  const timeStr = now.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
  const dateStr = now.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' });

  // Analyze each holding
  for (const h of holdings) {
    console.log(`\n📊 Analyzing ${h.ticker}...`);
    const sym = h.type === 'GOLD' || h.ticker === 'XAUUSD' ? 'GC=F' : h.ticker;
    const price = await getPrice(sym);

    const pInfo = price
      ? `ราคา $${price.current.toFixed(2)} (${price.changePct >= 0 ? '+' : ''}${price.changePct.toFixed(2)}% วันนี้) 52W H:$${price.high52.toFixed(2)} L:$${price.low52.toFixed(2)}`
      : 'ไม่มีข้อมูลราคา';

    const prompt = `วิเคราะห์หุ้น ${h.ticker} (${h.name || h.ticker}) ${pInfo} วันที่ ${dateStr}
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
        time: timeStr
      };
      console.log(`✅ ${h.ticker}: ${result.sentiment} | Target: ${result.target}`);
    } catch (e) {
      console.error(`❌ ${h.ticker} error:`, e.message);
    }
    await sleep(800);
  }

  // Fetch news
  console.log('\n📰 Fetching news...');
  const tickers = holdings.map(h => h.ticker).join(', ');
  const newsCount = Math.min(holdings.length * 2, 8);
  const newsPrompt = `ข่าวล่าสุด ${newsCount} ข่าวเกี่ยวกับหุ้น: ${tickers} วันที่ ${dateStr}
ตอบ JSON array เท่านั้น ไม่มี markdown ไม่มี backtick:
[{"ticker":"X","title":"หัวข่าวไทย","summary":"สรุปผลกระทบ 1 ประโยคไทย","impact":"POSITIVE หรือ NEGATIVE หรือ NEUTRAL","time":"Xh ago"}]`;

  let newsCache = [];
  try {
    const text = await callAI(newsPrompt, 1200);
    let clean = text.replace(/```json|```/g, '').trim();
    if (!clean.endsWith(']')) {
      const lb = clean.lastIndexOf('}');
      if (lb > 0) clean = clean.substring(0, lb + 1) + ']';
    }
    newsCache = JSON.parse(clean);
    console.log(`✅ Got ${newsCache.length} news items`);
  } catch (e) {
    console.error('❌ News error:', e.message);
  }

  // Save to Firestore
  await docRef.set({
    holdings,
    aiCache,
    newsCache,
    lastNewsTime: Date.now(),
    autoUpdatedAt: now.toISOString()
  }, { merge: true });

  console.log('\n✅ Saved to Firestore successfully!');
  console.log('📊 Summary:');
  Object.entries(aiCache).forEach(([ticker, c]) => {
    console.log(`  ${ticker}: ${c.sentiment} | Target: ${c.target}`);
  });
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
