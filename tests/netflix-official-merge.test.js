// Test harness — mock Surge env, exercise merge logic end-to-end
const fs = require('fs');
const path = require('path');

// ─── Mock Surge globals ───────────────────────────────────────────────────────
const store = {};
global.$persistentStore = {
  read: (k) => store[k] || null,
  write: (v, k) => { store[k] = v; return true; },
};
const captured = {};
global.$done = (obj) => { captured.lastDone = obj; };
global.$argument = "Position=original_top&Debug=true";

// ─── Helper to load script & run with a given request/response ────────────────
async function runScript(url, body) {
  global.$request = { url };
  global.$response = { body };
  captured.lastDone = null;
  // Re-require fresh
  const scriptPath = path.join(__dirname, '..', 'scripts', 'netflix-official-merge.js');
  delete require.cache[require.resolve(scriptPath)];
  require(scriptPath);
  // The script is async (top-level IIFE), give it time
  await new Promise(r => setTimeout(r, 100));
  return captured.lastDone;
}

// ─── Test fixtures ────────────────────────────────────────────────────────────
const enVTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
Hello, world.

2
00:00:04.500 --> 00:00:06.000
How are you today?

3
00:00:07.200 --> 00:00:09.000
I'm fine, thanks.
`;

const zhVTT = `WEBVTT

1
00:00:01.100 --> 00:00:03.000
哈囉，世界。

2
00:00:04.600 --> 00:00:06.000
你今天好嗎？

3
00:00:07.300 --> 00:00:09.000
我很好，謝謝。
`;

const enTTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" ttp:tickRate="10000000" xml:lang="en">
<body><div>
<p begin="10000000t" end="30000000t"><span>Hello, world.</span></p>
<p begin="45000000t" end="60000000t"><span>How are you today?</span></p>
<p begin="72000000t" end="90000000t"><span>I'm fine, thanks.</span></p>
</div></body></tt>`;

const zhTTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" ttp:tickRate="10000000" xml:lang="zh-Hant">
<body><div>
<p begin="11000000t" end="30000000t"><span>哈囉，世界。</span></p>
<p begin="46000000t" end="60000000t"><span>你今天好嗎？</span></p>
<p begin="73000000t" end="90000000t"><span>我很好，謝謝。</span></p>
</div></body></tt>`;

// ─── Tests ────────────────────────────────────────────────────────────────────
(async () => {
  let pass = 0, fail = 0;
  const t = (name, ok, detail) => {
    if (ok) { console.log(`✓ ${name}`); pass++; }
    else    { console.log(`✗ ${name}\n   ${detail || ''}`); fail++; }
  };

  // ── Test 1: VTT, English arrives first, no counterpart → pass-through
  Object.keys(store).forEach(k => delete store[k]);
  let r = await runScript(
    "https://abc.oca.nflxvideo.net/?o=12345&v=10&e=1700000000&t=xyz",
    enVTT
  );
  t("VTT en first → pass-through (empty done)",
    r && Object.keys(r).length === 0,
    `got: ${JSON.stringify(r)}`);

  // raw cache should have en
  const enRaw = JSON.parse(store["nfsub_raw_o12345_en"] || "{}");
  t("VTT en raw cache stored", enRaw.body === enVTT);

  // ── Test 2: zh arrives → merge happens
  r = await runScript(
    "https://abc.oca.nflxvideo.net/?o=12345&v=20&e=1700000000&t=xyz",
    zhVTT
  );
  t("VTT zh arrives → merge returns body",
    r && r.body && r.body.includes("哈囉，世界") && r.body.includes("Hello, world"),
    `got body preview: ${(r?.body || '').substring(0, 200)}`);

  // primary should be zh (since zh was the trigger), so format = zh\nen with original_top
  t("VTT merge: zh on top, en below (original_top)",
    r && /哈囉，世界。\nHello, world./.test(r.body),
    `body: ${r?.body}`);

  // ── Test 3: merged cache populated for both directions
  const mergedZh = JSON.parse(store["nfsub_merged_o12345_zh-Hant"] || "{}");
  const mergedEn = JSON.parse(store["nfsub_merged_o12345_en"] || "{}");
  t("VTT merged cache for zh-Hant exists", !!mergedZh.body);
  t("VTT merged cache for en exists (bidirectional overwrite)", !!mergedEn.body);
  t("VTT en-primary merged: en on top",
    mergedEn.body && /Hello, world.\n哈囉，世界。/.test(mergedEn.body),
    `en-primary body: ${mergedEn.body}`);

  // ── Test 4: cache hit on subsequent request
  r = await runScript(
    "https://abc.oca.nflxvideo.net/?o=12345&v=10&e=1700000000&t=xyz",
    enVTT
  );
  t("VTT en re-request → merged cache hit",
    r && r.body && r.body.includes("哈囉") && r.body.includes("Hello"),
    `got: ${(r?.body || '').substring(0, 100)}`);

  // ── Test 5: TTML round
  Object.keys(store).forEach(k => delete store[k]);
  r = await runScript(
    "https://abc.oca.nflxvideo.net/?o=99999&v=30&e=1700000000&t=xyz",
    enTTML
  );
  t("TTML en first → pass-through",
    r && Object.keys(r).length === 0);

  r = await runScript(
    "https://abc.oca.nflxvideo.net/?o=99999&v=40&e=1700000000&t=xyz",
    zhTTML
  );
  t("TTML zh arrives → merge returns body",
    r && r.body && r.body.includes("哈囉，世界") && r.body.includes("Hello, world"));

  t("TTML merge preserves <p> attrs",
    r && r.body && r.body.includes('begin="11000000t"'),
    `body preview: ${(r?.body || '').substring(0, 500)}`);

  t("TTML merge uses <br/> separator",
    r && r.body && /哈囉，世界。.*<br\/>.*Hello, world./.test(r.body),
    `body preview: ${(r?.body || '').substring(0, 500)}`);

  // ── Test 6: Different episode shouldn't pair
  Object.keys(store).forEach(k => delete store[k]);
  await runScript(
    "https://abc.oca.nflxvideo.net/?o=11111&v=10&e=1700000000&t=xyz",
    enVTT
  );
  r = await runScript(
    "https://abc.oca.nflxvideo.net/?o=22222&v=20&e=1700000000&t=xyz",
    zhVTT
  );
  t("Different episode keys → no merge, pass-through",
    r && Object.keys(r).length === 0,
    `got: ${JSON.stringify(r).substring(0, 200)}`);

  // ── Test 7: Time-mismatched cues
  Object.keys(store).forEach(k => delete store[k]);
  const enOff = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
Hello.

2
00:00:20.000 --> 00:00:22.000
Far later line.
`;
  const zhOff = `WEBVTT

1
00:00:01.100 --> 00:00:03.000
哈囉，這是一個有足夠漢字的測試字幕。
`;
  await runScript("https://abc.oca.nflxvideo.net/?o=77777&v=1&e=1&t=x", enOff);
  r = await runScript("https://abc.oca.nflxvideo.net/?o=77777&v=2&e=1&t=x", zhOff);
  // primary = zh (剛到), secondary = en
  // zh 的「哈囉」應該配到 en 的「Hello.」→ 雙語
  // en 的「Far later line.」沒對手 → 以 orphan 形式單獨保留
  t("Paired cue is bilingual",
    r && r.body && /哈囉，這是一個有足夠漢字的測試字幕。\nHello\./.test(r.body),
    `body:\n${r?.body}`);
  t("Unpaired secondary cue kept (no language lost)",
    r && r.body && r.body.includes("Far later line."),
    `body:\n${r?.body}`);

  // ── Test 8: Language detection
  Object.keys(store).forEach(k => delete store[k]);
  // simulate a Spanish track — should pass-through (detectLanguage maps to "en" but
  // we only care that it doesn't crash; it'll be cached under "en" key which is a
  // limitation noted in README)
  const esVTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
Hola, mundo.
`;
  r = await runScript("https://abc.oca.nflxvideo.net/?o=55555&v=1&e=1&t=x", esVTT);
  t("Non-zh/non-en still processed (defaults to 'en' bucket)",
    r && Object.keys(r).length === 0);

  // Simplified Chinese should be detected as zh-Hans and skipped
  const zhHansVTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
你好，这个世界很简单，让我们开始学习吧，这是一个测试，需要很多简体字，时间过得真快，发展很快。
`;
  Object.keys(store).forEach(k => delete store[k]);
  r = await runScript("https://abc.oca.nflxvideo.net/?o=66666&v=1&e=1&t=x", zhHansVTT);
  t("zh-Hans subtitle → pass-through (not merged)",
    r && Object.keys(r).length === 0);

  // ── Test 9: URL without o= → no merge
  Object.keys(store).forEach(k => delete store[k]);
  r = await runScript("https://abc.oca.nflxvideo.net/?v=1&e=1&t=x", enVTT);
  t("URL without o= param → pass-through (no episode key)",
    r && Object.keys(r).length === 0);

  // ── Summary
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
