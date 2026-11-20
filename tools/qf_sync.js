// Weekly sync of Quran Foundation recitation data for Quran Nest (ex Dua Nest).
// Rules (Quran Foundation FAQ, 2026-11-20): offline copies only through Content Sync; the backend may sync and
// refresh device copies at least every 7 days; no audio files on our servers or in the app bundle.
// This script reads the Husary (Muallim) verse-by-verse recitation through Content Sync and writes only the
// audio URLs and word timings of the verses the app teaches into one JSON file that the app reads online.
// Verse files, not whole chapters: Al-Baqarah alone is 224 MB as one file, Ayat al-Kursi as a verse is 1.8 MB.
// The client secret stays in GitHub secrets; the app itself never sees it.
//   QF_CLIENT_ID=... QF_CLIENT_SECRET=... [QF_ENV=prelive] [QF_RECITATION=12] node qf_sync.js out.json
const fs = require('fs');

const ENV = process.env.QF_ENV === 'prelive' ? 'prelive' : 'production';
const OAUTH = ENV === 'prelive' ? 'https://prelive-oauth2.quran.foundation' : 'https://oauth2.quran.foundation';
const BASE = (ENV === 'prelive' ? 'https://apis-prelive.quran.foundation' : 'https://apis.quran.foundation') + '/content';
const RECITATION = +(process.env.QF_RECITATION || 12);   // Mahmoud Khalil Al-Husary (Muallim), quran.com/reciters/12
// what the app teaches: Al-Fatiha (its first verse is also the Basmala before other surahs), Ayat al-Kursi,
// and the short surahs of Juz 'Amma
const range = (s, n) => Array.from({ length: n }, (_, i) => `${s}:${i + 1}`);
const WANT = new Set(['2:255', ...range(1, 7), ...range(103, 3), ...range(105, 5), ...range(106, 4), ...range(107, 7),
  ...range(108, 3), ...range(109, 6), ...range(110, 3), ...range(111, 5), ...range(112, 4), ...range(113, 5), ...range(114, 6)]);

async function token() {
  const r = await fetch(`${OAUTH}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${process.env.QF_CLIENT_ID}:${process.env.QF_CLIENT_SECRET}`).toString('base64'),
    },
    body: 'grant_type=client_credentials&scope=content.sync.read',
  });
  if (!r.ok) throw new Error(`token: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

async function get(tok, path) {
  const r = await fetch(path.startsWith('http') ? path : BASE + (path.startsWith('/api/') ? '' : '/api/v4') + path, {
    headers: { 'x-auth-token': tok, 'x-client-id': process.env.QF_CLIENT_ID },
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// A full copy of the recitation through Content Sync: a bootstrap sync lists the resource with its snapshot
// address (RESOURCE_CREATE), and the snapshot holds every row. Rows sent inline as ROW_CREATE / ROW_UPDATE
// mutations are kept as well, in case a resource comes without a snapshot.
async function snapshot(tok) {
  const rows = [], snaps = new Set();
  let page = `/api/v4/resources/sync?bootstrap=true&resources=recitations:${RECITATION}&per_page=100`;
  let first = true;
  while (page) {
    const d = await get(tok, page);
    const muts = (d.sync && d.sync.mutations) || d.mutations || [];
    if (first) { console.log('sync page keys', Object.keys(d).join(','), '·', muts.length, 'mutations'); console.log('first mutation', JSON.stringify(muts[0] || null).slice(0, 500)); first = false; }
    for (const m of muts) {
      if (m.snapshot_url) snaps.add(m.snapshot_url);
      const row = m.record || m.data || m.row;
      if (row && /ROW_(CREATE|UPDATE)/.test(m.type || '')) rows.push(row);
    }
    page = d.has_more || (d.sync && d.sync.has_more) ? (d.next_page_url || d.sync.next_page_url) : null;
  }
  for (let url of snaps) {
    while (url) {
      const d = await get(tok, url);
      rows.push(...(d.records || []));
      url = d.has_more ? d.next_page_url : null;
    }
  }
  return rows;
}

// Verse audio rows: field names are not in the public docs yet, so accept the names the v4 API uses.
// Segments come as [word index, start, end] or [word from, word to, start, end]; only the times are kept.
const audioUrl = u => !u ? null : u.startsWith('//') ? 'https:' + u : u.startsWith('http') ? u : 'https://verses.quran.com/' + u;
const times = segs => (segs || []).map(s => s.slice(-2).map(Math.round));

(async () => {
  const tok = await token();
  const rows = await snapshot(tok);
  // what came back, for the run log (content only, no credentials)
  const types = {};
  for (const r of rows) types[r.record_type || '?'] = (types[r.record_type || '?'] || 0) + 1;
  console.log(rows.length, 'rows', JSON.stringify(types));
  console.log('sample', JSON.stringify(rows.find(r => r.verse_key === '112:1') || rows[0] || null).slice(0, 600));
  const out = {
    source: 'Quran.com / Quran Foundation (Content Sync)',
    reciter: { id: RECITATION, name: 'Mahmoud Khalil Al-Husary (Muallim)' },
    synced: new Date().toISOString(),
    verses: {},
  };
  for (const r of rows) {
    const key = r.verse_key, url = audioUrl(r.url || r.audio_url);
    if (key && url && WANT.has(key)) out.verses[key] = { url, words: times(r.segments) };
  }
  const missing = [...WANT].filter(k => !out.verses[k]);
  console.log(Object.keys(out.verses).length, 'verses;', missing.length ? 'missing ' + missing.join(' ') : 'none missing');
  if (!Object.keys(out.verses).length) throw new Error(`no verse audio in snapshot (${rows.length} rows); check QF_RECITATION`);
  fs.writeFileSync(process.argv[2], JSON.stringify(out));
})().catch(e => { console.error(e.message); process.exit(1); });
