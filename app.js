/* ============================================================
   婚活 すり合わせ – app.js
   ------------------------------------------------------------
   共有リンクは「id（短いランダムID）＋復号鍵（URLのフラグメント）」
   のみで構成される。回答本体は暗号化されたうえで GAS 経由で
   スプレッドシートに保存され、復号鍵はサーバーに送信されない
   （URLの # 以降はブラウザからサーバーへ送信されないため）。
   ============================================================ */

const LIFF_ID   = "2010606389-v29ZSV0f";
const DRAFT_KEY = "konkatsu_suriawase_draft_v1";

// ▼▼▼ デプロイ済みGAS Web AppのURL ▼▼▼
const GAS_ENDPOINT = "https://script.google.com/macros/s/AKfycbzyvzON4-aCxsV1T37MZhDpIvHj-bGhC2ODfHiSgRifompdUN7o_XYivh2VErYMm-v0/exec";

/* ============================================================
   Base64URL 変換ユーティリティ（AES鍵・暗号文の符号化に使用）
   ============================================================ */
function bufToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64UrlToBuf(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad    = padded.length % 4;
  const fixed  = pad ? padded + "=".repeat(4 - pad) : padded;
  const binary = atob(fixed);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/* ============================================================
   SHA-256ハッシュ（LINE UserIDのハッシュ化。生IDはサーバーに送らない）
   ============================================================ */
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ============================================================
   AES-GCM 暗号化ユーティリティ
   鍵はURLのフラグメント（#以降）にのみ含め、サーバーには渡さない。
   ============================================================ */
async function generateShareKey() {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const raw = await crypto.subtle.exportKey("raw", key);
  return { key, base64: bufToBase64Url(raw) };
}

async function importShareKey(base64) {
  const raw = base64UrlToBuf(base64);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
}

async function encryptJSON(obj, key) {
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(JSON.stringify(obj));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), iv.length);
  return bufToBase64Url(combined.buffer);
}

async function decryptJSON(base64, key) {
  const combined = new Uint8Array(base64UrlToBuf(base64));
  const iv   = combined.slice(0, 12);
  const data = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

/* ------------------------------------------------------------
   LINEユーザーIDの取得
   liff.getProfile() はLINEサーバーへの追加API呼び出しが必要で、
   ログイン直後などタイミングによって不安定になりやすい。
   ログイン時に発行されるIDトークンをその場でデコードするだけなら
   通信が発生せず、ユーザーID（sub）を安定して取得できる。
   表示名・プロフィール画像は使わない設計なので、これで十分。
   ------------------------------------------------------------ */
function getLineUserId() {
  const idToken = liff.getDecodedIDToken();
  if (!idToken || !idToken.sub) {
    throw new Error("ID token is not available (sub claim missing)");
  }
  return idToken.sub;
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ============================================================
   スライダービジュアル（ビューモード表示用 SVG）
   ============================================================ */
function sliderVisualHTML(value, leftLabel, rightLabel, max = 5) {
  const v       = Math.min(Math.max(parseInt(value, 10) || 3, 1), max);
  const width   = 320;
  const padding = 12;
  const usable  = width - padding * 2;
  const step    = usable / (max - 1);
  const cx      = padding + step * (v - 1);
  const y       = 20;
  let ticks = "";
  for (let i = 0; i < max; i++) {
    const x = padding + step * i;
    ticks += `<line x1="${x}" y1="${y-8}" x2="${x}" y2="${y+8}" stroke="#f48ca0" stroke-width="2"/>`;
  }
  return `
    <div class="slider-visual">
      <div class="slider-visual-labels">
        <span>${escapeHTML(leftLabel)}</span><span>${escapeHTML(rightLabel)}</span>
      </div>
      <svg viewBox="0 0 ${width} 40" xmlns="http://www.w3.org/2000/svg" class="slider-visual-svg">
        <line x1="${padding}" y1="${y}" x2="${width-padding}" y2="${y}" stroke="#f48ca0" stroke-width="2"/>
        ${ticks}
        <circle cx="${cx}" cy="${y}" r="9" fill="#222"/>
      </svg>
    </div>`;
}

/* ============================================================
   順位付けUI（Q19のみ）
   ============================================================ */
const rankingState = { q19: [] };

const RANKING_ID_MAP = {
  q19Ranking: "q19",
};

const Q19_OPTIONS = [
  "料理","洗い物","掃除機をかける","水回りの掃除",
  "片付け","洗濯機をまわしてから干すまで","干したものの取り込み","ゴミ捨て"
];

/* ラジオvalue→表示テキスト変換（DOM参照不可のためインラインラベルマップを使用） */
const RADIO_LABELS = {
  /* Q3 */ "a3-1":"ある", "a3-2":"ない",
  /* Q4 */ "a4-1":"ある（奨学金返済中も含みます）", "a4-2":"ない",
  /* Q5 */ "a5-1":"なっている", "a5-2":"なっていない",
  /* Q6 */ "a6-1":"ある", "a6-2":"ない",
  /* Q7 */ "a7-1":"ある", "a7-2":"ない（一般的な法事程度）",
  /* Q8 */ "a8-1":"初婚", "a8-2":"再婚以上",
  /* Q9 */ "a9-1":"ある", "a9-2":"ない",
  /* Q11 */ "a11-1":"ある", "a11-2":"ない",
  /* Q12 */ "a12-1":"2人ともフルタイム",
            "a12-2":"自分はフルタイムで働くが相手の働き方は問わない",
            "a12-3":"自分はフルタイムで働くので相手にはセーブしてほしい",
            "a12-4":"パートで働きたい",
            "a12-5":"専業主婦、專業主夫になりたい",
            "a12-6":"その他",
  /* Q13 */ "a13-1":"全て積極的にやりたい",
            "a13-2":"分担したいが好きな家事・得意な家事は積極的にやりたい",
            "a13-3":"分担したいが帰る時間が自分の方が早ければ平日は積極的にやりたい",
            "a13-4":"半々にしたい",
            "a13-5":"平日はほとんどお願いしたいが休日は積極的に行いたい",
            "a13-6":"ほとんど相手にやってほしい",
            "a13-7":"その他",
  /* Q14 */ "a14-1":"共通でかかるお金は自分がほとんど払いたい",
            "a14-2":"収入差による按分で出し合いたい",
            "a14-3":"半々で出し合いたい",
            "a14-4":"共通でかかるお金は相手にほとんど払ってほしい",
            "a14-5":"その他",
  /* Q15 */ "a15-1":"2人ともフルタイム",
            "a15-2":"自分はフルタイムで働くが相手の働き方は問わない",
            "a15-3":"自分はフルタイムで働くので相手にはセーブしてほしい",
            "a15-4":"パートで働きたい",
            "a15-5":"専業主婦、專業主夫になりたい",
            "a15-6":"その他",
  /* Q16 */ "a16-1":"全て積極的にやりたい",
            "a16-2":"分担したいが子どもの体調不良時などは自分が積極的に面倒をみたい",
            "a16-3":"分担したいが子どもの体調不良時などは相手にできるだけお願いしたい",
            "a16-4":"平日はほとんどお願いしたいが休日は積極的に行いたい",
            "a16-5":"ほとんど相手にやってほしい",
            "a16-6":"その他",
  /* Q17 */ "a17-1":"1ヶ月以内",
            "a17-2":"1~3ヶ月",
            "a17-3":"3ヶ月~保育園入るまで",
            "a17-4":"1~2年",
            "a17-5":"相手に頼まれなければ取るつもりはない",
            "a17-6":"子どもが生まれたら仕事をやめたい",
            "a17-7":"その他",
  /* Q18 */ "a18-1":"共通でかかるお金は自分がほとんど払いたい",
            "a18-2":"収入差による按分で出し合いたい",
            "a18-3":"半々で出し合いたい",
            "a18-4":"共通でかかるお金は相手にほとんど払ってほしい",
            "a18-5":"その他",
  /* Q21 */ "a21-1":"週3回以上", "a21-2":"週1〜2回", "a21-3":"週1回未満",
  /* Q22 */ "a22-1":"毎日", "a22-2":"週1回以上", "a22-3":"月1回以上",
            "a22-4":"1シーズンに1回以上", "a22-5":"あまりしない",
  /* Q23 */ "a23-1":"毎日自炊する",
            "a23-2":"週末などに作り置きして自炊したものを毎日食べている",
            "a23-3":"週の半分程度は外食または弁当を買って食べる",
            "a23-4":"ほぼ毎日外食または弁当を買って食べる",
  /* Q24 */ "a24-1":"食後すぐ", "a24-2":"少し溜まってから",
            "a24-3":"夕食の食器を翌朝洗うのも気にならない",
  /* Q25 */ "a25-1":"できるだけ避けるべきだ",
            "a25-2":"惣菜はいいが便利家電は避けたい",
            "a25-3":"便利家電はいいが惣菜は避けたい",
            "a25-4":"理想は手間ひまかけて家事を行いたいが、どちらも場合に応じて使っても良い",
            "a25-5":"予算などがあれば積極的に使いたい",
  /* Q26 */ "a26-1":"ほぼ毎日", "a26-2":"週の半分程度", "a26-3":"週1〜2回程度",
            "a26-4":"月3回以上", "a26-5":"月1〜2回程度",
            "a26-6":"1シーズンに1回以上", "a26-7":"年1〜2回程度", "a26-8":"ほとんどない",
  /* Q27 */ "a27-1":"毎日", "a27-2":"週の半分程度", "a27-3":"週1〜2回程度",
            "a27-4":"習慣化はしていないが気が向いたらする", "a27-5":"しない",
  /* Q31 */ "a31-1":"すでにファミリー使いできる車を持っている",
            "a31-2":"車は持っているがファミリー用ではないため将来的にはファミリー用を買いたい",
            "a31-3":"今は車を持っていないが将来的には車を買いたい",
            "a31-4":"カーシェアをサブスク契約したい",
            "a31-5":"旅行の時など必要なときだけ借りればよい",
            "a31-6":"免許を持っていない、車は運転するつもりがない",
  /* Q33 */ "a33-1":"月1回以上", "a33-2":"数ヶ月に1回~年に数回",
            "a33-3":"年に1回あるかないか", "a33-4":"法事などの必要に迫られた時のみ",
  /* Q34 */ "a34-1":"月1回以上", "a34-2":"数ヶ月に1回~年に数回",
            "a34-3":"年に1回あるかないか", "a34-4":"法事などの必要に迫られた時のみ",
  /* Q35 */ "a35-1":"月1回以上", "a35-2":"数ヶ月に1回~年に数回",
            "a35-3":"年に1回あるかないか", "a35-4":"法事などの必要に迫られた時のみ",
  /* Q36 */ "a36-1":"毎回一緒に会いたい",
            "a36-2":"毎回ではないが2回に1回ぐらいはついてきてほしい",
            "a36-3":"義実家に泊まる時はついてきてほしい",
  /* Q37 */ "a37-1":"月1回以上", "a37-2":"数ヶ月に1回~年に数回",
            "a37-3":"年に1回あるかないか", "a37-4":"法事などの必要に迫られた時のみ",
  /* Q38 */ "a38-1":"できれば相手に変えてほしい",
            "a38-2":"できれば相手の苗字に変えたい",
            "a38-3":"どちらでもよい、相手の希望次第で考えたい",
  /* Q39 */ "a39-1":"予算のある限り積極的に使いたい",
            "a39-2":"相手が望むのであればかけてもよい",
            "a39-3":"結婚費用はあまりかけず、将来の生活費や貯蓄にとっておきたい",
};

/* チェックボックスのvalue→表示テキスト変換マップ */
const CHECKBOX_LABELS = {
  /* Q10 不妊治療・養子（1〜4人目共通） */
  "a10_1-1":"人工授精などの一般不妊治療",
  "a10_1-2":"体外受精・顕微授精などの高度不妊治療",
  "a10_1-3":"養子",
  "a10_1-4":"自然妊娠のみ、もしくはほしくない",
  "a10_2-1":"人工授精などの一般不妊治療",
  "a10_2-2":"体外受精・顕微授精などの高度不妊治療",
  "a10_2-3":"養子",
  "a10_2-4":"自然妊娠のみ、もしくはほしくない",
  "a10_3-1":"人工授精などの一般不妊治療",
  "a10_3-2":"体外受精・顕微授精などの高度不妊治療",
  "a10_3-3":"養子",
  "a10_3-4":"自然妊娠のみ、もしくはほしくない",
  "a10_4-1":"人工授精などの一般不妊治療",
  "a10_4-2":"体外受精・顕微授精などの高度不妊治療",
  "a10_4-3":"養子",
  "a10_4-4":"自然妊娠のみ、もしくはほしくない",
  /* Q28 家 */
  "a28-1":"ずっと賃貸",
  "a28-2":"将来的には持ち家を買いたい",
  "a28-3":"すでに持ち家を持っている",
  "a28-4":"今は賃貸だが将来や相続後は自分の実家に住む",
  "a28-5":"今は賃貸だが将来や相続後は義実家に住む",
  "a28-6":"社宅などその他",
  /* Q29 戸建て・マンション */
  "a29-1":"注文住宅で戸建て",
  "a29-2":"中古の戸建て",
  "a29-3":"新築マンション",
  "a29-4":"中古マンション",
};

function setupRankingGroup(groupId) {
  const group = document.getElementById(groupId);
  if (!group) return;
  const key = RANKING_ID_MAP[groupId];
  group.querySelectorAll(".rank-option").forEach(btn => {
    btn.addEventListener("click", () => {
      const value = btn.dataset.value;
      const arr   = rankingState[key];
      const idx   = arr.indexOf(value);
      if (idx === -1) arr.push(value); else arr.splice(idx, 1);
      renderRankingGroup(groupId);
    });
  });
}

function renderRankingGroup(groupId) {
  const group = document.getElementById(groupId);
  if (!group) return;
  const arr = rankingState[RANKING_ID_MAP[groupId]];
  group.querySelectorAll(".rank-option").forEach(btn => {
    const order = arr.indexOf(btn.dataset.value);
    const numEl = btn.querySelector(".rank-number");
    if (order === -1) {
      btn.classList.remove("selected");
      if (numEl) numEl.textContent = "";
    } else {
      btn.classList.add("selected");
      if (numEl) numEl.textContent = String(order + 1);
    }
  });
}

function resetRankingGroup(groupId) {
  rankingState[RANKING_ID_MAP[groupId]] = [];
  renderRankingGroup(groupId);
}

function restoreRankingGroup(groupId, savedOrder) {
  const group = document.getElementById(groupId);
  const key   = RANKING_ID_MAP[groupId];
  const validValues = group
    ? Array.from(group.querySelectorAll(".rank-option")).map(b => b.dataset.value)
    : [];
  rankingState[key] = Array.isArray(savedOrder)
    ? savedOrder.filter(v => validValues.includes(v))
    : [];
  renderRankingGroup(groupId);
}

function rankingListHTML(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "未回答";
  return arr.map((item, i) => `${i+1}位：${escapeHTML(item)}`).join("<br>");
}

/* ============================================================
   チェックボックス・ラジオ収集ヘルパー
   ============================================================ */
function getChecked(name) {
  return Array.from(document.querySelectorAll(`input[name="${name}"]:checked`))
    .map(el => el.value || el.closest("label").textContent.trim());
}

function getRadio(name) {
  const el = document.querySelector(`input[name="${name}"]:checked`);
  return el ? (el.value || el.closest("label").textContent.trim()) : "";
}

function checkedListHTML(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "未回答";
  return arr.map(v => `・${escapeHTML(v)}`).join("<br>");
}

/* ============================================================
   詳細テキストエリアの表示・非表示
   ============================================================ */
function toggleDetail(id, show) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = show ? "block" : "none";
  if (!show) el.value = "";
}

/* ============================================================
   ラジオのvalue→表示テキスト変換ヘルパー
   ============================================================ */
function radioLabel(name, value) {
  if (!value) return "未回答";
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) {
    const label = el.closest("label");
    if (label) return label.textContent.trim();
  }
  return value;
}

/* ============================================================
   フォーム値の収集
   ============================================================ */
function collectFormData() {
  return {
    q1:         document.getElementById("q1").value,
    q2:         document.getElementById("q2").value,
    q3:         getRadio("q3"),
    q4:         getRadio("q4"),
    q5:         getRadio("q5"),
    q6:         getRadio("q6"),
    q7:         getRadio("q7"),
    q8:         getRadio("q8"),
    q8_other:   document.getElementById("q8_other").value,
    q9:         getRadio("q9"),
    q10_1_val:  document.getElementById("q10_1").value,
    q10_1_chk:  getChecked("q10_1"),
    q10_2_val:  document.getElementById("q10_2").value,
    q10_2_chk:  getChecked("q10_2"),
    q10_3_val:  document.getElementById("q10_3").value,
    q10_3_chk:  getChecked("q10_3"),
    q10_4_val:  document.getElementById("q10_4").value,
    q10_4_chk:  getChecked("q10_4"),
    q11:        getRadio("q11"),
    q12:        getRadio("q12"),
    q12_other:  document.getElementById("q12_other").value,
    q13:        getRadio("q13"),
    q13_other:  document.getElementById("q13_other").value,
    q14:        getRadio("q14"),
    q14_other:  document.getElementById("q14_other").value,
    q15:        getRadio("q15"),
    q15_other:  document.getElementById("q15_other").value,
    q16:        getRadio("q16"),
    q16_other:  document.getElementById("q16_other").value,
    q17:        getRadio("q17"),
    q17_other:  document.getElementById("q17_other").value,
    q18:        getRadio("q18"),
    q18_other:  document.getElementById("q18_other").value,
    q19:        rankingState.q19.slice(),
    q20:        document.getElementById("q20").value,
    q21:        getRadio("q21"),
    q22:        getRadio("q22"),
    q23:        getRadio("q23"),
    q24:        getRadio("q24"),
    q25:        getRadio("q25"),
    q26:        getRadio("q26"),
    q27:        getRadio("q27"),
    q28:        getChecked("q28"),
    q29:        getChecked("q29"),
    q30_budget: document.getElementById("q30_budget").value,
    q30_area:   document.getElementById("q30_area").value,
    q31:        getRadio("q31"),
    q32:        document.getElementById("q32").value,
    q32_pet:    document.getElementById("q32_pet").value,
    q33:        getRadio("q33"),
    q34:        getRadio("q34"),
    q35:        getRadio("q35"),
    q36:        getRadio("q36"),
    q37:        getRadio("q37"),
    q38:        getRadio("q38"),
    q39:        getRadio("q39"),
  };
}

/* ============================================================
   フォームへの値の復元
   ============================================================ */
function restoreFormData(data) {
  if (!data) return;

  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el && val !== undefined) el.value = val;
  };
  const setRadio = (name, val) => {
    if (!val) return;
    let r = document.querySelector(`input[name="${name}"][value="${val}"]`);
    if (!r) {
      document.querySelectorAll(`input[name="${name}"]`).forEach(el => {
        if ((el.closest("label") || {}).textContent &&
            el.closest("label").textContent.trim() === val) r = el;
      });
    }
    if (r) r.checked = true;
  };
  const setCheckboxes = (name, vals) => {
    if (!Array.isArray(vals)) return;
    document.querySelectorAll(`input[name="${name}"]`).forEach(el => {
      const label = el.closest("label");
      const text  = label ? label.textContent.trim() : "";
      if (vals.includes(el.value) || vals.includes(text)) el.checked = true;
    });
  };

  setText("q1", data.q1);
  setText("q2", data.q2);
  setText("q8_other",   data.q8_other);
  setText("q12_other",  data.q12_other);
  setText("q13_other",  data.q13_other);
  setText("q14_other",  data.q14_other);
  setText("q15_other",  data.q15_other);
  setText("q16_other",  data.q16_other);
  setText("q17_other",  data.q17_other);
  setText("q18_other",  data.q18_other);
  setText("q30_budget", data.q30_budget);
  setText("q30_area",   data.q30_area);
  setText("q32_pet",    data.q32_pet);

  /* スライダー */
  ["q10_1","q10_2","q10_3","q10_4","q20","q32"].forEach(id => {
    const key = id.startsWith("q10") ? id + "_val" : id;
    setText(id, data[key] !== undefined ? data[key] : data[id]);
  });

  /* ラジオ */
  ["q3","q4","q5","q6","q7","q8","q9","q11","q12","q13","q14","q15",
   "q16","q17","q18","q21","q22","q23","q24","q25","q26","q27",
   "q31","q33","q34","q35","q36","q37","q38","q39"]
    .forEach(name => setRadio(name, data[name]));

  /* チェックボックス */
  ["q10_1","q10_2","q10_3","q10_4"].forEach(name =>
    setCheckboxes(name, data[name + "_chk"])
  );
  setCheckboxes("q28", data.q28);
  setCheckboxes("q29", data.q29);

  /* ランキング */
  restoreRankingGroup("q19Ranking", data.q19);
}

/* ============================================================
   バリデーション
   ============================================================ */
function validate(data) {
  const errors = [];
  if (!data.q1.trim())  errors.push("Q1: 結婚したい理由を入力してください。");
  if (!data.q2.trim())  errors.push("Q2: 理想の夫婦像を入力してください。");
  if (!data.q3)         errors.push("Q3: 前科について選択してください。");
  if (!data.q4)         errors.push("Q4: 借金について選択してください。");
  if (!data.q5)         errors.push("Q5: 保証人について選択してください。");
  if (!data.q6)         errors.push("Q6: 健康上のことについて選択してください。");
  if (!data.q7)         errors.push("Q7: 宗教事情について選択してください。");
  if (!data.q8)         errors.push("Q8: 初婚・再婚について選択してください。");
  if (!data.q9)         errors.push("Q9: 転勤・転職・起業について選択してください。");
  if (!data.q11)        errors.push("Q11: ブライダルチェックについて選択してください。");
  if (!data.q12)        errors.push("Q12: 結婚後の働き方を選択してください。");
  if (!data.q13)        errors.push("Q13: 家事の分担について選択してください。");
  if (!data.q14)        errors.push("Q14: 結婚後の支出割合を選択してください。");
  if (!data.q15)        errors.push("Q15: 子ども後の働き方を選択してください。");
  if (!data.q16)        errors.push("Q16: 育児の分担について選択してください。");
  if (!data.q17)        errors.push("Q17: 育休について選択してください。");
  if (!data.q18)        errors.push("Q18: 子ども後の支出割合を選択してください。");
  if (!data.q21)        errors.push("Q21: 洗濯頻度を選択してください。");
  if (!data.q22)        errors.push("Q22: 掃除頻度を選択してください。");
  if (!data.q23)        errors.push("Q23: 自炊・外食について選択してください。");
  if (!data.q24)        errors.push("Q24: 食器を洗うタイミングを選択してください。");
  if (!data.q25)        errors.push("Q25: 便利家電・惣菜について選択してください。");
  if (!data.q26)        errors.push("Q26: 飲み会の頻度を選択してください。");
  if (!data.q27)        errors.push("Q27: 晩酌について選択してください。");
  if (!data.q28 || data.q28.length === 0) errors.push("Q28: 家について選択してください。");
  if (!data.q33)        errors.push("Q33: 両親・兄弟との面会頻度（現在）を選択してください。");
  if (!data.q34)        errors.push("Q34: 親戚との面会頻度（現在）を選択してください。");
  if (!data.q35)        errors.push("Q35: 結婚後の両親・兄弟との面会頻度を選択してください。");
  if (!data.q36)        errors.push("Q36: パートナーの同行について選択してください。");
  if (!data.q37)        errors.push("Q37: 義両親との面会頻度を選択してください。");
  if (!data.q38)        errors.push("Q38: 苗字についてのこだわりを選択してください。");
  if (!data.q39)        errors.push("Q39: 結婚費用についての考えを選択してください。");
  return errors;
}

/* ============================================================
   統計用データの抽出（Analyticsシート行）
   Analyticsシートに列がある項目のみを平文で送る。
   ※ q6（健康上のことで伝えておくこと）は個人特定性が高いため対象外。
   選択式の項目は、集計時にそのまま使えるよう選択肢の全文を入れる。
   ============================================================ */
function buildAnalyticsPayload(data) {
  const lbl = (val) => (val ? (RADIO_LABELS[val] || val) : "");
  const chkText = (arr) => (Array.isArray(arr) && arr.length > 0)
    ? arr.map(v => CHECKBOX_LABELS[v] || v).join("、")
    : "";
  const rankingText = (arr) => (Array.isArray(arr) && arr.length > 0)
    ? arr.map((v, i) => `${i + 1}位:${v}`).join("、")
    : "";

  return {
    q1: data.q1 || "",
    q2: data.q2 || "",
    q3: lbl(data.q3),
    q4: lbl(data.q4),
    q5: lbl(data.q5),
    q7: lbl(data.q7),
    q8: lbl(data.q8),
    q8_other: data.q8_other || "",
    q9: lbl(data.q9),
    "q10-1": data.q10_1_val || "",
    "q10-2": data.q10_2_val || "",
    "q10-3": data.q10_3_val || "",
    "q10-4": data.q10_4_val || "",
    q11: lbl(data.q11),
    q12: lbl(data.q12), q12_other: data.q12_other || "",
    q13: lbl(data.q13), q13_other: data.q13_other || "",
    q14: lbl(data.q14), q14_other: data.q14_other || "",
    q15: lbl(data.q15), q15_other: data.q15_other || "",
    q16: lbl(data.q16), q16_other: data.q16_other || "",
    q17: lbl(data.q17), q17_other: data.q17_other || "",
    q18: lbl(data.q18), q18_other: data.q18_other || "",
    q19: rankingText(data.q19),
    q20: data.q20 || "",
    q21: lbl(data.q21),
    q22: lbl(data.q22),
    q23: lbl(data.q23),
    q24: lbl(data.q24),
    q25: lbl(data.q25),
    q26: lbl(data.q26),
    q27: lbl(data.q27),
    q28: chkText(data.q28),
    q29: chkText(data.q29),
    q30_budget: data.q30_budget || "",
    q30_area: data.q30_area || "",
    q31: lbl(data.q31),
    q32: data.q32 || "",
    q32_pet: data.q32_pet || "",
    q33: lbl(data.q33),
    q34: lbl(data.q34),
    q35: lbl(data.q35),
    q36: lbl(data.q36),
    q37: lbl(data.q37),
    q38: lbl(data.q38),
  };
}

/* ============================================================
   フォーム要素を隠す（ビューモード／状態表示に切り替える共通処理）
   ============================================================ */
function hideFormElements() {
  document.querySelectorAll(
    ".container > label, .container > input, .container > textarea, " +
    ".container > div.slider-labels, .container > div.ranking-group, " +
    ".container > div.button-group, .container > div#shareModal, " +
    ".container > #submitBtn"
  ).forEach(el => (el.style.display = "none"));
}

/* ============================================================
   読み込み中／エラーなどの状態表示（共有リンクを開いたとき用）
   ============================================================ */
function showStateCard(title, text, isLoading = false) {
  hideFormElements();
  let container = document.getElementById("viewMode");
  if (!container) {
    container = document.createElement("div");
    container.id = "viewMode";
    document.querySelector(".container").prepend(container);
  }
  container.style.display = "block";
  container.innerHTML = `
    <div class="view-header state-card">
      ${isLoading ? `
        <div class="state-spinner">
          <img src="https://developers.line.biz/media/line-mini-app/LINE_spinner_light.svg" class="spinner-light" alt="読み込み中">
          <img src="https://developers.line.biz/media/line-mini-app/LINE_spinner_dark.svg" class="spinner-dark" alt="読み込み中">
        </div>
      ` : ""}
      <p class="view-label">${escapeHTML(title)}</p>
      <p class="state-text">${escapeHTML(text)}</p>
    </div>
  `;
}

/* ============================================================
   共有リンクを開いたときの処理
   ・URLの ?id=... がスプレッドシート上のレコードを指す
   ・URLの #以降 が復号鍵（サーバーには送信されない）
   ・閲覧にはLINEログインが必須（viewerHashによるアクセス制御のため）
   ============================================================ */
async function handleSharedView(id) {
  // ここに来た時点で liff.init() は完了済み（呼び出し元のメイン処理を参照）。
  showStateCard("読み込み中…", "回答内容を確認しています。少々お待ちください。", true);

  const keyBase64 = location.hash ? location.hash.slice(1) : "";
  if (!keyBase64) {
    showStateCard(
      "リンクが不完全です",
      "共有リンクが途中で切れているか、正しくコピーされていない可能性があります。共有した相手にもう一度リンクを送ってもらってください。"
    );
    return;
  }

  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }

  let key;
  try {
    key = await importShareKey(keyBase64);
  } catch (e) {
    console.error("key import error", e);
    showStateCard("リンクが正しくありません", "共有リンクが壊れている可能性があります。");
    return;
  }

  let viewerHash;
  try {
    const userId = getLineUserId();
    viewerHash = await sha256Hex(userId);
  } catch (e) {
    console.error("get user id error", e);
    showStateCard(
      "エラー",
      "LINEアカウント情報の確認に失敗しました。時間をおいてもう一度お試しください。" +
      "（詳細: " + (e && e.message ? e.message : String(e)) + "）"
    );
    return;
  }

  let result;
  try {
    const url = `${GAS_ENDPOINT}?action=view&id=${encodeURIComponent(id)}&viewerHash=${encodeURIComponent(viewerHash)}`;
    const resp = await fetch(url, { method: "GET" });
    result = await resp.json();
  } catch (e) {
    console.error("fetch view error", e);
    showStateCard("通信エラー", "回答内容を取得できませんでした。通信環境を確認してもう一度お試しください。");
    return;
  }

  if (!result.ok) {
    if (result.reason === "forbidden") {
      showStateCard(
        "閲覧できません",
        "このリンクは最初に開いた方専用です。転送されたリンクは、その方以外は閲覧できない仕組みになっています。"
      );
    } else if (result.reason === "revoked" || result.reason === "expired" || result.reason === "deleted") {
      showStateCard("リンクが無効です", "このリンクはすでに無効になっています。最新の共有リンクを送ってもらってください。");
    } else if (result.reason === "not_found") {
      showStateCard("リンクが見つかりません", "このリンクは存在しないか、削除された可能性があります。");
    } else {
      showStateCard("エラー", "回答内容を取得できませんでした。時間をおいて再度お試しください。");
    }
    return;
  }

  let data;
  try {
    data = await decryptJSON(result.cipherText, key);
  } catch (e) {
    console.error("decrypt error", e);
    showStateCard("復号に失敗しました", "リンクの一部が正しくない可能性があります。共有した相手にもう一度リンクを送ってもらってください。");
    return;
  }

  renderViewMode(data);
}

/* ============================================================
   ビューモード：回答をカード表示
   ============================================================ */
function renderViewMode(data, options = {}) {
  const { selfPreview = false, onShare = null } = options;

  const r = (val) => val || "未回答";
  const radioWithOther = (val, other) => {
    if (!val) return "未回答";
    if ((val === "a12-6" || val === "a13-7" || val === "a14-5" ||
         val === "a15-6" || val === "a16-6" || val === "a17-7" ||
         val === "a18-5") && other && other.trim()) {
      return `その他：${other.trim()}`;
    }
    return val;
  };


  const lbl = (val) => val ? (RADIO_LABELS[val] || val) : "未回答";
  const lblWithOther = (val, other) => {
    if (!val) return "未回答";
    const text = RADIO_LABELS[val] || val;
    if (text === "その他" && other && other.trim()) return `その他：${other.trim()}`;
    return text;
  };


  /* チェックボックス配列をラベルに変換してHTML化 */
  const chkListHTML = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return "未回答";
    return arr.map(v => `・${escapeHTML(CHECKBOX_LABELS[v] || v)}`).join("<br>");
  };

  const q10Section = (label, sliderVal, chkArr) => {
    const slider = sliderVisualHTML(sliderVal || 3, "ほしくない", "ほしい");
    const checks = (Array.isArray(chkArr) && chkArr.length > 0)
      ? chkArr.map(v => `・${escapeHTML(CHECKBOX_LABELS[v] || v)}`).join("<br>")
      : "（未選択）";
    return `<strong>${escapeHTML(label)}</strong><br>${slider}${checks}`;
  };

  const rows = [
    { q: "Q1 結婚したい理由は何ですか？",                     a: r(data.q1) },
    { q: "Q2 どんな夫婦になりたいですか？",                    a: r(data.q2) },
    { q: "Q3 前科はありますか？",                             a: lbl(data.q3) },
    { q: "Q4 借金はありますか？",                             a: lbl(data.q4) },
    { q: "Q5 他人の借金の保証人になっていますか？",              a: lbl(data.q5) },
    { q: "Q6 健康上のことで伝えておくことはありますか？",          a: lbl(data.q6) },
    { q: "Q7 宗教事情で伝えておくことはありますか？",             a: lbl(data.q7) },
    { q: "Q8 再婚の場合、離婚理由を教えてください。",
      html: (() => {
        const base = lbl(data.q8);
        return data.q8 === "a8-2" && data.q8_other && data.q8_other.trim()
          ? `${escapeHTML(base)}<br>離婚理由：${escapeHTML(data.q8_other)}`
          : escapeHTML(base);
      })() },
    { q: "Q9 転勤や転職、起業の予定はありますか？",              a: lbl(data.q9) },
    { q: "Q10 子どもはほしいですか？不妊治療・養子について",
      html: [
        q10Section("1人目",   data.q10_1_val, data.q10_1_chk),
        q10Section("2人目",   data.q10_2_val, data.q10_2_chk),
        q10Section("3人目",   data.q10_3_val, data.q10_3_chk),
        q10Section("4人目以上", data.q10_4_val, data.q10_4_chk),
      ].join("<br><br>") },
    { q: "Q11 1年以内にブライダルチェックを受けましたか？",        a: lbl(data.q11) },
    { q: "Q12 結婚後の働き方はどうしたいですか？",               a: lblWithOther(data.q12, data.q12_other) },
    { q: "Q13 家事はどう分担したいですか？",                    a: lblWithOther(data.q13, data.q13_other) },
    { q: "Q14 結婚後の支出割合はどうしたいですか？",              a: lblWithOther(data.q14, data.q14_other) },
    { q: "Q15 子どもが生まれた後の働き方は？",                   a: lblWithOther(data.q15, data.q15_other) },
    { q: "Q16 育児はどう分担したいですか？",                    a: lblWithOther(data.q16, data.q16_other) },
    { q: "Q17 育休は何ヶ月ぐらい取りたいですか？",               a: lblWithOther(data.q17, data.q17_other) },
    { q: "Q18 子どもが生まれた後の支出割合は？",                 a: lblWithOther(data.q18, data.q18_other) },
    { q: "Q19 家事の中で好きな順",                            html: rankingListHTML(data.q19) },
    { q: "Q20 部屋や水回りの清潔感はどのくらい気になりますか？",
      html: sliderVisualHTML(data.q20 || 3, "気にしない", "気になる") },
    { q: "Q21 洗濯頻度は普段どのくらいですか？",                 a: lbl(data.q21) },
    { q: "Q22 掃除頻度は普段どのくらいですか？",                 a: lbl(data.q22) },
    { q: "Q23 自炊派ですか？外食はしますか？",                   a: lbl(data.q23) },
    { q: "Q24 食器を洗うタイミングは？",                        a: lbl(data.q24) },
    { q: "Q25 便利家電や惣菜へのこだわりは？",                   a: lbl(data.q25) },
    { q: "Q26 飲み会の頻度",                                  a: lbl(data.q26) },
    { q: "Q27 家で晩酌はしますか？",                           a: lbl(data.q27) },
    { q: "Q28 家は買いたいですか？",                           html: chkListHTML(data.q28) },
    { q: "Q29 戸建て・マンション、どれが良いですか？",             html: chkListHTML(data.q29) },
    { q: "Q30 家の予算・住みたいエリア",
      html: (() => {
        const budget = data.q30_budget ? `予算：${escapeHTML(data.q30_budget)}` : "";
        const area   = data.q30_area   ? `エリア：${escapeHTML(data.q30_area)}` : "";
        return [budget, area].filter(Boolean).join("<br>") || "未回答";
      })() },
    { q: "Q31 車は買いたいですか？",                           a: lbl(data.q31) },
    { q: "Q32 ペットは飼いたいですか？",
      html: (() => {
        const slider = sliderVisualHTML(data.q32 || 3, "飼いたくない", "飼いたい");
        return slider + (data.q32_pet && data.q32_pet.trim()
          ? `飼いたいペット：${escapeHTML(data.q32_pet)}`
          : "");
      })() },
    { q: "Q33 両親・兄弟との面会頻度（現在）",                   a: lbl(data.q33) },
    { q: "Q34 家族以外の親戚との面会頻度（現在）",                a: lbl(data.q34) },
    { q: "Q35 結婚後、両親・兄弟と何回ぐらい会いたいですか？",     a: lbl(data.q35) },
    { q: "Q36 両親・兄弟と会う時、パートナーにもついてきてほしいですか？", a: lbl(data.q36) },
    { q: "Q37 結婚後、義両親・義兄弟と何回ぐらい会いたいですか？", a: lbl(data.q37) },
    { q: "Q38 苗字についてこだわりはありますか？",                a: lbl(data.q38) },
    { q: "Q39 結婚費用についてどう考えていますか？",              a: lbl(data.q39) },
  ];

  hideFormElements();

  const formURL = location.href.split("?")[0].split("#")[0];

  const descEl = document.querySelector(".form-header .form-description");
  if (descEl) {
    descEl.innerHTML =
      "回答を共有してお互いのことを知りましょう。<br>" +
      "回答内容だけじゃなく、なぜそう思ってるのか、この場合はどう変わるかなども質問し合ってみましょう。";
  }

  /* viewMode div がなければ動的に生成 */
  let container = document.getElementById("viewMode");
  if (!container) {
    container = document.createElement("div");
    container.id = "viewMode";
    document.querySelector(".container").prepend(container);
  }
  container.style.display = "block";

  container.innerHTML = `
    ${selfPreview ? `
    <div class="cta-card share-confirm-card">
      <div class="cta-content" style="text-align:center;">
        <h3 class="cta-title">この内容を共有します</h3>
        <p class="cta-text">内容を確認したら、共有先を選んでください。</p>
        <button type="button" id="goShareBtn" class="cta-button">
          共有先を選ぶ <span class="cta-arrow">›</span>
        </button>
      </div>
    </div>
    ` : `
    <div class="view-header">
      <p class="view-label">回答内容</p>
      ${data._shareName ? `<p class="view-name">${escapeHTML(data._shareName)} さんの回答</p>` : ""}
    </div>
    `}

    ${rows.map(({ q, a, html }) => `
      <div class="view-item">
        <p class="view-question">${escapeHTML(q)}</p>
        <p class="view-answer">${html !== undefined ? html : escapeHTML(a).replace(/\n/g, "<br>")}</p>
      </div>
    `).join("")}

    ${!selfPreview ? `
    <div class="cta-card">
      <img src="image1.PNG" class="cta-image-left" alt="">
      <div class="cta-content">
        <h3 class="cta-title">あなたの価値観も共有してみませんか？</h3>
        <p class="cta-text">
          婚活・交際前の自己開示は、<br>
          お互いを知る大切なきっかけになります。<br>
          あなたの考えや価値観をアンケートで伝えてみましょう。
        </p>
        <button type="button" id="ctaButton" class="cta-button" data-href="${formURL}">
          私も回答する <span class="cta-arrow">›</span>
        </button>
      </div>
    </div>
    ` : ""}
  `;

  if (selfPreview) {
    const goShareBtn = document.getElementById("goShareBtn");
    if (goShareBtn && typeof onShare === "function") {
      goShareBtn.addEventListener("click", onShare);
    }
    return;
  }

  const ctaButton = document.getElementById("ctaButton");
  if (ctaButton) {
    ctaButton.addEventListener("click", () => {
      if (confirm("婚活 すり合わせフォームを開く")) {
        window.location.href = ctaButton.dataset.href;
      }
    });
  }
}


/* ============================================================
   共有：シェアターゲットピッカー用 Flexメッセージ
   長い共有URLはボタン(uriアクション)の中に格納するため、
   相手に見える本文には長いリンクが表示されない。
   ※ uriアクションのURLは1000文字以内という制限があるため、
     超える場合は liff.shareTargetPicker 側でエラーになり、
     呼び出し元で従来のURLスキーム方式にフォールバックする。
   ※ hero画像のURLは、LINEのサーバーから読み込める公開HTTPS URL
     である必要がある（ローカルパスや相対パスは不可）。
     画像は1MB以下を推奨。PNGの透過部分はそのまま送ると
     反映されない場合があるため、白背景に合成したJPEGを使用する。
   ============================================================ */
const HEADER_IMAGE_URL = "https://marriagesketch.github.io/-suriawase-/image_message.jpg";

function buildShareFlexMessage(shareName, shareURL) {
  const nameLine = shareName ? `${shareName}さんの回答が届きました` : "回答が届きました";

  return {
    type: "flex",
    altText: `婚活 すり合わせ - ${nameLine}`,
    contents: {
      type: "bubble",
      hero: {
        type: "image",
        url: HEADER_IMAGE_URL,
        size: "full",
        aspectRatio: "3:2",
        aspectMode: "cover"
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "20px",
        contents: [
          { type: "text", text: "婚活 すり合わせ", size: "xs", weight: "bold", color: "#d96c7d" },
          { type: "text", text: nameLine, size: "lg", weight: "bold", wrap: true, margin: "sm" },
          { type: "text", text: "ボタンから回答内容を確認できます。", size: "sm", color: "#888888", wrap: true, margin: "md" }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "20px",
        contents: [
          {
            type: "button",
            style: "primary",
            height: "sm",
            color: "#f48ca0",
            action: { type: "uri", label: "回答をみる", uri: shareURL }
          }
        ]
      }
    }
  };
}

/* ============================================================
   共有先を選んで送信する
   1. シェアターゲットピッカーが使える場合はそちらを優先
      （Flexメッセージとして直接送信、送信後にトーク画面へ遷移しない）
   2. 使えない・失敗した場合は、従来のURLスキーム方式（送信先を
      選択画面を開いてテキストメッセージを送る）にフォールバック
   ============================================================ */
async function shareToOthers(flexMessage, fallbackLineSchemeURL) {
  if (liff.isApiAvailable("shareTargetPicker")) {
    try {
      await liff.shareTargetPicker([flexMessage], { isMultiple: true });
      return;
    } catch (e) {
      console.warn("shareTargetPicker failed, falling back to URL scheme:", e);
    }
  }

  if (liff.isInClient()) {
    window.location.href = fallbackLineSchemeURL;
  } else {
    window.open(fallbackLineSchemeURL, "_blank");
  }
}

/* ============================================================
   友だち追加チェック
   LINE公式アカウントを友だち追加済みかを確認し、未追加であれば
   友だち追加ダイアログを表示する。
   ※ LIFF初期化・ログイン済みの状態で呼び出すこと（liff.init は呼ばない）
   ============================================================ */
async function checkFriendship() {
  try {
    const friendship = await liff.getFriendship();
    if (!friendship.friendFlag) {
      try {
        await liff.requestFriendship();
      } catch (error) {
        console.warn("友だち追加リクエスト失敗（ユーザーがキャンセルした可能性があります）:", error);
      }
    }
  } catch (error) {
    console.warn("友だち確認をスキップ:", error);
  }
}

/* ============================================================
   メイン処理
   ============================================================ */
(async () => {

  /* ----- LIFF 初期化（必ず最初に1回だけ実行） -----
     共有リンク判定に使うURL（?id=...#key）の読み取りは、
     必ずこの後で行う。ログインのリダイレクトを経由して
     戻ってきた直後は、URLが一時的に ?liff.state=... の形に
     なっていて ?id=... が正しく読み取れないことがあるため。
  ----- */
  try {
    await liff.init({ liffId: LIFF_ID });
  } catch (e) {
    console.error("LIFF init failed", e);
    alert("LIFFの初期化に失敗しました。");
    return;
  }

  /* ----- 共有リンク判定（?id=... が付いている場合） ----- */
  const sharedId = new URLSearchParams(location.search).get("id");
  if (sharedId) {
    await handleSharedView(sharedId);
    return;
  }

  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }

  /* ----- 友だち追加チェック（未追加なら追加ダイアログを表示） ----- */
  await checkFriendship();

  /* ----- ランキングUIの初期化 ----- */
  setupRankingGroup("q19Ranking");

  /* ----- 条件付き表示：自由記述欄の表示制御 ----- */
  /* Q8：「再婚以上」(a8-2) 選択時のみ離婚理由欄を表示 */
  document.querySelectorAll('input[name="q8"]').forEach(r =>
    r.addEventListener("change", () => toggleDetail("q8_other", r.value === "a8-2"))
  );

  /* Q12〜18：「その他」選択時のみ自由記述欄を表示 */
  [
    { name: "q12", otherId: "q12_other", otherVal: "a12-6" },
    { name: "q13", otherId: "q13_other", otherVal: "a13-7" },
    { name: "q14", otherId: "q14_other", otherVal: "a14-5" },
    { name: "q15", otherId: "q15_other", otherVal: "a15-6" },
    { name: "q16", otherId: "q16_other", otherVal: "a16-6" },
    { name: "q17", otherId: "q17_other", otherVal: "a17-7" },
    { name: "q18", otherId: "q18_other", otherVal: "a18-5" },
  ].forEach(({ name, otherId, otherVal }) => {
    document.querySelectorAll(`input[name="${name}"]`).forEach(r =>
      r.addEventListener("change", () => toggleDetail(otherId, r.value === otherVal))
    );
  });

  /* ----- 下書き復元後の初期表示状態を同期 ----- */
  const syncToggle = (name, otherId, otherVal) => {
    const checked = document.querySelector(`input[name="${name}"]:checked`);
    toggleDetail(otherId, checked ? checked.value === otherVal : false);
  };

  /* ----- localStorage から下書き復元 ----- */
  try {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) restoreFormData(JSON.parse(saved));
  } catch (_) {}

  /* ----- 下書き保存 ----- */
  document.getElementById("draftBtn") &&
  document.getElementById("draftBtn").addEventListener("click", () => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(collectFormData()));
      alert("下書きを保存しました。");
    } catch (_) {
      alert("下書きの保存に失敗しました。");
    }
  });

  /* ----- フォームクリア ----- */
  document.getElementById("clearBtn") &&
  document.getElementById("clearBtn").addEventListener("click", () => {
    if (!confirm("入力内容をすべてクリアしますか？")) return;

    ["q1","q2","q8_other","q12_other","q13_other","q14_other","q15_other",
     "q16_other","q17_other","q18_other","q30_budget","q30_area","q32_pet"]
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });

    document.querySelectorAll('input[type="radio"], input[type="checkbox"]')
      .forEach(el => (el.checked = false));

    ["q10_1","q10_2","q10_3","q10_4","q20","q32"]
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = 3; });

    resetRankingGroup("q19Ranking");

    try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
  });

  /* ----- 送信ボタン ----- */
  document.getElementById("submitBtn").addEventListener("click", () => {
    const data   = collectFormData();
    const errors = validate(data);

    if (errors.length > 0) {
      alert("以下の項目を入力・選択してください。\n\n" + errors.join("\n"));
      return;
    }

    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch (_) {}

    const modal = document.getElementById("shareModal");
    if (modal) {
      modal.classList.remove("hidden");
      modal.classList.add("show");
      document.getElementById("submitBtn").disabled = true;
    } else {
      handleShare(data, "").catch(e => {
        console.error("share error", e);
        alert("共有の準備に失敗しました。通信環境を確認してもう一度お試しください。");
      });
    }
  });

  /* ----- 共有ボタン（モーダルあり） ----- */
  const shareBtn = document.getElementById("shareBtn");
  if (shareBtn) {
    shareBtn.addEventListener("click", async () => {
      const shareName = (document.getElementById("shareName") || {}).value || "";
      const data      = collectFormData();

      shareBtn.disabled = true;
      const originalLabel = shareBtn.textContent;
      shareBtn.textContent = "送信中…";

      try {
        await handleShare(data, shareName.trim());

        const modal = document.getElementById("shareModal");
        if (modal) {
          modal.classList.remove("show");
          modal.classList.add("hidden");
        }
      } catch (e) {
        console.error("share error", e);
        alert("共有の準備に失敗しました。通信環境を確認してもう一度お試しください。");
        document.getElementById("submitBtn").disabled = false;
      } finally {
        shareBtn.disabled = false;
        shareBtn.textContent = originalLabel;
      }
    });
  }

  /* ----- モーダル外クリックで閉じる ----- */
  const shareModal = document.getElementById("shareModal");
  if (shareModal) {
    shareModal.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) {
        e.currentTarget.classList.remove("show");
        e.currentTarget.classList.add("hidden");
        document.getElementById("submitBtn").disabled = false;
      }
    });
  }

})();

/* ============================================================
   共有処理（送信ボタン・共有ボタン共通）
   ============================================================ */
async function handleShare(data, shareName) {
  data._shareName = shareName;

  const userId    = getLineUserId();
  const ownerHash = await sha256Hex(userId);

  const id = (crypto.randomUUID ? crypto.randomUUID() : fallbackUUID());
  const { key, base64: keyBase64 } = await generateShareKey();
  const cipherText = await encryptJSON(data, key);
  const analytics  = buildAnalyticsPayload(data);

  const resp = await fetch(GAS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // preflight回避のため text/plain を使用
    body: JSON.stringify({ action: "share", id, cipherText, ownerHash, analytics, schemaVersion: 1 }),
  });
  const result = await resp.json();
  if (!result.ok) throw new Error(result.reason || "share_failed");

  const base     = location.href.split("?")[0].split("#")[0];
  const shareURL = `${base}?id=${id}#${keyBase64}`;

  const previewMsg = shareName
    ? `${shareName}さんの婚活 すり合わせの回答が届きました。\n回答をみる→${shareURL}`
    : `婚活 すり合わせの回答が届きました。\n回答をみる→${shareURL}`;

  const flexMessage = buildShareFlexMessage(shareName, shareURL);

  renderViewMode(data, {
    selfPreview: true,
    onShare: () => {
      // LINEの「送信先を選択」画面を開くURLスキーム（フォールバック用）
      const lineShareURL = `https://line.me/R/msg/text/?${encodeURIComponent(previewMsg)}`;
      shareToOthers(flexMessage, lineShareURL);
    },
  });

  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* crypto.randomUUID が使えない古い環境用のフォールバック */
function fallbackUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
