import { firebaseConfig, APP_PASSCODE, DM_PASSCODE } from "./firebase-config.js";
import {
  DEFAULT_PARTY, ABILITIES, abilityMod, fmtMod, freeToCarry,
  casterInfo, spellsKnownAtLevel, defaultCharacter, slugify,
  GEAR_CATALOG, CRAWLING_KIT,
} from "./rules.js";

const app = document.getElementById("app");

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// esc + turn *emphasis* markers (used in the item data) into <em>
function md(s) {
  return esc(s).replace(/\*([^*\n]+)\*/g, "<em>$1</em>").replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>");
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over ?? base;
  if (typeof base === "object" && base && typeof over === "object" && over) {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
    return out;
  }
  return over ?? base;
}

function coerce(el) {
  if (el.type === "number" || el.dataset.num === "1") {
    const n = parseFloat(el.value);
    return Number.isFinite(n) ? n : 0;
  }
  return el.value;
}

function normalizeChar(slug, data) {
  return deepMerge(defaultCharacter(""), data || {});
}

/* ---------------- shared party state (light timer, battle) ---------------- */

// Lives in a reserved document inside the characters collection so the
// existing Firestore rules cover it. Meta slugs are hidden from rosters.
const PARTY_SLUG = "_party";
const isMetaSlug = (s) => s.startsWith("_");

function defaultParty() {
  return { meta: true, lightUntil: 0, battle: { entries: [] } };
}

function partyOf(chars) {
  return deepMerge(defaultParty(), chars[PARTY_SLUG] || {});
}

function fmtCountdown(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function lightCardHtml(party) {
  const rem = (party.lightUntil || 0) - Date.now();
  if (rem > 0) {
    return `
      <section class="card light-card lit">
        <h2>Light</h2>
        <p class="light-line">&#128293; Torchlight &mdash; <strong class="light-count">${fmtCountdown(rem)}</strong> remaining</p>
        <div class="light-tools">
          <button class="btn small" data-action="light-1h">Fresh torch (1 hr)</button>
          <button class="btn small danger" data-action="light-snuff">Snuff</button>
        </div>
      </section>`;
  }
  return `
    <section class="card light-card dark">
      <h2>Light</h2>
      <p class="light-line dim"><em>The dark presses in. No light burns.</em></p>
      <div class="light-tools">
        <button class="btn small" data-action="light-1h">&#128293; Light a torch (1 hr)</button>
      </div>
    </section>`;
}

function battleSorted(party) {
  return [...(party.battle.entries || [])].sort((a, b) => (Number(b.init) || 0) - (Number(a.init) || 0));
}

// DM-managed NPCs, in their own reserved document.
const NPCS_SLUG = "_npcs";

function defaultNpcs() {
  return { meta: true, npcs: [] };
}

function npcsOf(chars) {
  return deepMerge(defaultNpcs(), chars[NPCS_SLUG] || {});
}

/* ---------------- storage (Firestore or device-only fallback) ---------------- */

const store = { mode: "local", subscribe: null, subscribeAll: null, save: null, delete: null };

function initLocalStore() {
  store.mode = "local";
  const PREFIX = "sd_char_";
  const key = (slug) => `${PREFIX}${slug}`;
  const docListeners = new Map();  // slug -> Set<cb>
  const allListeners = new Set();

  const read = (slug) => {
    try { return JSON.parse(localStorage.getItem(key(slug))); } catch { return null; }
  };
  const readAll = () => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) {
        const data = read(k.slice(PREFIX.length));
        if (data) out[k.slice(PREFIX.length)] = data;
      }
    }
    return out;
  };
  const notify = (slug, data, pending) => {
    (docListeners.get(slug) || []).forEach((cb) => cb(data, pending));
    const all = readAll();
    allListeners.forEach((cb) => cb(all));
  };

  store.subscribe = (slug, cb) => {
    if (!docListeners.has(slug)) docListeners.set(slug, new Set());
    docListeners.get(slug).add(cb);
    cb(read(slug), false);
    return () => docListeners.get(slug).delete(cb);
  };
  store.subscribeAll = (cb) => {
    allListeners.add(cb);
    cb(readAll());
    return () => allListeners.delete(cb);
  };
  store.save = async (slug, data) => {
    localStorage.setItem(key(slug), JSON.stringify(data));
    notify(slug, data, true);
  };
  store.delete = async (slug) => {
    localStorage.removeItem(key(slug));
    notify(slug, null, false);
  };
  // sync between tabs on the same device
  window.addEventListener("storage", (e) => {
    if (!e.key || !e.key.startsWith(PREFIX)) return;
    let data = null;
    try { data = JSON.parse(e.newValue); } catch { /* removed or corrupt */ }
    notify(e.key.slice(PREFIX.length), data, false);
  });
}

async function initStore() {
  const configured = firebaseConfig?.projectId && !/PASTE/.test(firebaseConfig.projectId);
  if (!configured) { initLocalStore(); return; }
  try {
    const [{ initializeApp }, fs] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js"),
    ]);
    const db = fs.getFirestore(initializeApp(firebaseConfig));
    store.mode = "cloud";
    store.subscribe = (slug, cb) =>
      fs.onSnapshot(
        fs.doc(db, "characters", slug),
        (snap) => cb(snap.exists() ? snap.data() : null, snap.metadata.hasPendingWrites),
        (err) => console.error("Firestore subscribe failed:", err),
      );
    store.subscribeAll = (cb) =>
      fs.onSnapshot(
        fs.collection(db, "characters"),
        (snap) => {
          const out = {};
          snap.forEach((d) => { out[d.id] = d.data(); });
          cb(out);
        },
        (err) => console.error("Firestore subscribeAll failed:", err),
      );
    store.save = (slug, data) => fs.setDoc(fs.doc(db, "characters", slug), data);
    store.delete = (slug) => fs.deleteDoc(fs.doc(db, "characters", slug));
  } catch (err) {
    console.error("Firebase init failed, falling back to device-only mode:", err);
    initLocalStore();
  }
}

// Seed the five starting PCs once, on an empty roster.
let seedChecked = false;
function maybeSeed(chars) {
  if (seedChecked) return;
  seedChecked = true;
  if (Object.keys(chars).filter((s) => !isMetaSlug(s)).length > 0) return;
  if (localStorage.getItem("sd_seeded")) return;
  localStorage.setItem("sd_seeded", "1");
  // deferred so the writes (and their re-notifications) land after the
  // in-flight paint of the empty roster, not inside it
  setTimeout(() => {
    for (const p of DEFAULT_PARTY) store.save(p.slug, defaultCharacter(p.name));
  }, 0);
}

/* ---------------- passcode gate (soft) ---------------- */

function gatePassed() {
  return !APP_PASSCODE || localStorage.getItem("sd_gate") === APP_PASSCODE;
}

function renderGate() {
  app.innerHTML = `
    <div class="gate">
      <h1 class="wordmark">Vermis</h1>
      <p>Speak the password, wanderer.</p>
      <form id="gate-form">
        <input type="password" id="gate-input" autocomplete="off" autofocus>
        <button type="submit" class="btn primary">Enter</button>
        <p id="gate-err" class="gate-err hidden">The dark does not yield.</p>
      </form>
    </div>`;
  document.getElementById("gate-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (document.getElementById("gate-input").value === APP_PASSCODE) {
      localStorage.setItem("sd_gate", APP_PASSCODE);
      route();
    } else {
      document.getElementById("gate-err").classList.remove("hidden");
    }
  });
}

/* ---------------- routing ---------------- */

let cleanups = [];
function cleanup() {
  cleanups.forEach((fn) => { try { fn(); } catch { /* already gone */ } });
  cleanups = [];
}

function route() {
  cleanup();
  window.scrollTo(0, 0);
  if (!gatePassed()) { renderGate(); return; }
  const hash = location.hash || "#/";
  if (hash.startsWith("#/c/")) { renderSheet(decodeURIComponent(hash.slice(4))); return; }
  if (hash === "#/dm") { renderDM(); return; }
  if (hash.startsWith("#/ref")) { renderReference(); return; }
  renderHome();
}

function modeBanner() {
  if (store.mode === "cloud") return "";
  return `<div class="banner">Device-only mode &mdash; edits save to this browser but do not sync.
    Paste your Firebase config into <code>js/firebase-config.js</code> to enable cloud sync (see README).</div>`;
}

/* ---------------- home ---------------- */

function renderHome() {
  app.innerHTML = `
    ${modeBanner()}
    <header class="home-head">
      <h1 class="wordmark">Vermis</h1>
      <p class="app-name">DM Hixx&rsquo;s Emberledger</p>
    </header>
    <div id="party-status"></div>
    <section class="card">
      <h2>Active Characters</h2>
      <nav class="char-list" id="active-list"><p class="empty">Consulting the ledger&hellip;</p></nav>
      <form id="new-char" class="new-char">
        <input type="text" id="new-char-name" placeholder="Name a new adventurer&hellip;" maxlength="60">
        <button type="submit" class="btn">+ Add</button>
      </form>
    </section>
    <section class="card fallen-card">
      <h2>The Fallen</h2>
      <div id="fallen-list"><p class="empty">None yet. The worm is patient.</p></div>
    </section>
    <nav class="home-tools">
      <a class="btn wide" href="#/dm">DM View &mdash; the whole company</a>
      <a class="btn wide" href="#/ref">Reference &mdash; spells, monsters, treasure, rules</a>
    </nav>`;

  let latest = {};
  let party = defaultParty();
  let wasLit = false;

  function paintPartyStatus() {
    const box = document.getElementById("party-status");
    if (!box) return;
    const order = battleSorted(party);
    const battleCard = order.length ? `
      <section class="card battle-card">
        <h2>Current Battle</h2>
        <ol class="battle-order">
          ${order.map((e) => `<li><span class="battle-init">${esc(e.init)}</span> ${esc(e.name)}</li>`).join("")}
        </ol>
        <p class="ref-meta">The DM manages initiative from the DM View.</p>
      </section>` : "";
    box.innerHTML = lightCardHtml(party) + battleCard;
    wasLit = (party.lightUntil || 0) > Date.now();
  }

  function paint(chars) {
    latest = chars;
    maybeSeed(chars);
    party = partyOf(chars);
    paintPartyStatus();
    const entries = Object.entries(chars)
      .filter(([slug]) => !isMetaSlug(slug))
      .map(([slug, data]) => [slug, normalizeChar(slug, data)])
      .sort((a, b) => (a[1].name || a[0]).localeCompare(b[1].name || b[0]));
    const active = entries.filter(([, c]) => c.active !== false);
    const fallen = entries.filter(([, c]) => c.active === false);

    document.getElementById("active-list").innerHTML = active.length
      ? active.map(([slug, c]) => `
          <a class="char-link" href="#/c/${encodeURIComponent(slug)}">
            <span class="char-name">${esc(c.name || slug)}</span>
            <span class="char-sub">${esc([`Lvl ${c.level}`, c.ancestry, c.class].filter(Boolean).join(" · "))}</span>
          </a>`).join("")
      : `<p class="empty">No living souls. Add an adventurer below.</p>`;

    document.getElementById("fallen-list").innerHTML = fallen.length
      ? fallen.map(([slug, c]) => `
          <div class="fallen-row" data-slug="${esc(slug)}">
            <span class="fallen-name">&dagger; ${esc(c.name || slug)} <span class="dim">${esc([c.class, `Lvl ${c.level}`].filter(Boolean).join(", "))}</span></span>
            <span class="fallen-actions">
              <button class="btn small" data-action="revive">Revive</button>
              <button class="btn small danger" data-action="delete">Delete</button>
            </span>
          </div>`).join("")
      : `<p class="empty">None yet. The worm is patient.</p>`;
  }

  cleanups.push(store.subscribeAll(paint));

  // countdown tick
  const tick = setInterval(() => {
    const lit = (party.lightUntil || 0) > Date.now();
    if (lit !== wasLit) { paintPartyStatus(); return; }
    if (lit) {
      const el = document.querySelector("#party-status .light-count");
      if (el) el.textContent = fmtCountdown(party.lightUntil - Date.now());
    }
  }, 1000);
  cleanups.push(() => clearInterval(tick));

  document.getElementById("party-status").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "light-1h") party.lightUntil = Date.now() + 3600_000;
    if (btn.dataset.action === "light-snuff") party.lightUntil = 0;
    store.save(PARTY_SLUG, party);
    paintPartyStatus();
  });

  document.getElementById("new-char").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("new-char-name").value.trim();
    if (!name) return;
    let slug = slugify(name);
    while (latest[slug] || isMetaSlug(slug)) slug = isMetaSlug(slug) ? slug.replace(/^_+/, "") || "adventurer" : slug + "_ii";
    store.save(slug, defaultCharacter(name));
    location.hash = `#/c/${encodeURIComponent(slug)}`;
  });

  document.getElementById("fallen-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const slug = btn.closest(".fallen-row").dataset.slug;
    const c = normalizeChar(slug, latest[slug]);
    if (btn.dataset.action === "revive") {
      c.active = true;
      store.save(slug, c);
    } else if (btn.dataset.action === "delete") {
      if (confirm(`Erase ${c.name || slug} forever? This cannot be undone.`)) {
        store.delete(slug);
      }
    }
  });
}

/* ---------------- character sheet ---------------- */

let sheetTab = sessionStorage.getItem("sd_tab") || "character";

function renderSheet(slug) {
  let char = defaultCharacter("");
  let dirty = false;       // local edits not yet written
  let saveTimer = null;
  let loaded = false;
  let exists = false;
  let party = defaultParty();
  const openNotes = new Set(); // gear rows with the notes field expanded

  app.innerHTML = `
    ${modeBanner()}
    <header class="sheet-head">
      <a class="back" href="#/">&larr; Company</a>
      <span class="head-right">
        <span id="light-chip" class="light-chip"></span>
        <span id="save-status" class="save-status"></span>
      </span>
    </header>
    <div id="sheet"></div>`;

  const sheet = document.getElementById("sheet");
  const statusEl = document.getElementById("save-status");

  function setStatus(txt, cls) {
    statusEl.textContent = txt;
    statusEl.className = `save-status ${cls || ""}`;
  }
  setStatus("Loading…");

  /* ----- templates ----- */

  const textField = (label, path, value, opts = "") =>
    `<label class="field"><span>${label}</span>
      <input type="text" data-path="${path}" value="${esc(value)}" ${opts}></label>`;

  const numField = (label, path, value, opts = "") =>
    `<label class="field"><span>${label}</span>
      <input type="number" inputmode="numeric" data-path="${path}" value="${esc(value)}" ${opts}></label>`;

  function atkTotal(a) {
    if (!a.stat) return null;
    return abilityMod(char.stats[a.stat]) + (parseInt(a.bonus, 10) || 0);
  }

  function atkTotalText(a) {
    const t = atkTotal(a);
    if (t === null) return "";
    const misc = parseInt(a.bonus, 10) || 0;
    const parts = [`${a.stat.toUpperCase()} ${fmtMod(abilityMod(char.stats[a.stat]))}`];
    if (misc) parts.push(`bonus ${fmtMod(misc)}`);
    return `To hit ${fmtMod(t)} (${parts.join(", ")})`;
  }

  function attacksRows() {
    if (!char.attacks.length) return `<p class="empty">No attacks yet.</p>`;
    const statOpts = (sel) => ["", "str", "dex"].map((v) =>
      `<option value="${v}" ${sel === v ? "selected" : ""}>${v ? v.toUpperCase() : "–"}</option>`).join("");
    return char.attacks.map((a, i) => `
      <div class="row attack-row">
        <input type="text" placeholder="Name" data-path="attacks.${i}.name" value="${esc(a.name)}">
        <select data-path="attacks.${i}.stat" title="Attack stat — auto-adds its modifier">${statOpts(a.stat || "")}</select>
        <input type="text" placeholder="+0" class="narrow" title="Flat bonus: talents, mastery, magic"
          data-path="attacks.${i}.bonus" value="${esc(a.bonus)}">
        <input type="text" placeholder="1d6" class="narrow" data-path="attacks.${i}.damage" value="${esc(a.damage)}">
        <button class="del" data-action="del" data-list="attacks" data-idx="${i}" title="Remove">&times;</button>
        <span class="atk-total" data-idx="${i}">${esc(atkTotalText(a))}</span>
      </div>`).join("");
  }

  function gearRows() {
    if (!char.gear.length) return `<p class="empty">Empty-handed in the dark.</p>`;
    const last = char.gear.length - 1;
    return char.gear.map((g, i) => `
      <div class="row gear-row">
        <span class="movers">
          <button class="mv" data-action="move" data-list="gear" data-idx="${i}" data-d="-1" ${i === 0 ? "disabled" : ""} title="Move up">&#9650;</button>
          <button class="mv" data-action="move" data-list="gear" data-idx="${i}" data-d="1" ${i === last ? "disabled" : ""} title="Move down">&#9660;</button>
        </span>
        <input type="text" placeholder="Item" data-path="gear.${i}.name" value="${esc(g.name)}">
        <input type="number" inputmode="decimal" step="any" min="0" class="narrow" title="Slots each"
          data-path="gear.${i}.slots" value="${esc(g.slots)}">
        <input type="number" inputmode="numeric" min="1" class="narrow" title="Quantity"
          data-path="gear.${i}.quantity" value="${esc(g.quantity)}">
        <button class="nbtn ${(g.notes || "").trim() ? "has" : ""}" data-action="gnotes" data-idx="${i}" title="Item details">&#9998;</button>
        <button class="del" data-action="del" data-list="gear" data-idx="${i}" title="Remove">&times;</button>
        <textarea class="notes gear-notes ${openNotes.has(i) ? "" : "hidden"}" rows="2"
          placeholder="Details — what it does, where it came from…"
          data-path="gear.${i}.notes">${esc(g.notes || "")}</textarea>
      </div>`).join("");
  }

  // Renders only entries of one type; indexes still point into the shared
  // talentsAndSpells array. Flipping a row's type moves it to the other card.
  function talentRows(type) {
    const tierOpts = (sel) => ["", 1, 2, 3, 4, 5].map((t) =>
      `<option value="${t}" ${String(sel ?? "") === String(t) ? "selected" : ""}>${t === "" ? "Tier –" : "Tier " + t}</option>`).join("");
    const rows = char.talentsAndSpells
      .map((t, i) => [t, i])
      .filter(([t]) => (t.type === "spell") === (type === "spell"))
      .map(([t, i]) => `
      <div class="row talent-row">
        <input type="text" placeholder="Name" data-path="talentsAndSpells.${i}.name" value="${esc(t.name)}">
        <select data-path="talentsAndSpells.${i}.type" title="Move between Spells and Talents">
          <option value="talent" ${t.type !== "spell" ? "selected" : ""}>Talent</option>
          <option value="spell" ${t.type === "spell" ? "selected" : ""}>Spell</option>
        </select>
        <select data-path="talentsAndSpells.${i}.tier" data-num="1" ${t.type !== "spell" ? "disabled" : ""}>
          ${tierOpts(t.tier)}
        </select>
        <button class="del" data-action="del" data-list="talentsAndSpells" data-idx="${i}" title="Remove">&times;</button>
        <input type="text" class="notes" placeholder="Notes" data-path="talentsAndSpells.${i}.notes" value="${esc(t.notes)}">
      </div>`);
    if (!rows.length) {
      return `<p class="empty">${type === "spell" ? "No spells inscribed." : "No talents earned."}</p>`;
    }
    return rows.join("");
  }

  function spellcastingBlock() {
    const info = casterInfo(char.class);
    if (!info) return "";
    const mod = abilityMod(char.stats[info.ability]);
    const known = spellsKnownAtLevel(info.type, char.level);
    const have = [0, 0, 0, 0, 0];
    for (const t of char.talentsAndSpells) {
      if (t.type === "spell" && t.tier >= 1 && t.tier <= 5) have[t.tier - 1]++;
    }
    const chips = known.map((k, i) => {
      if (!k && !have[i]) return "";
      const over = have[i] > k;
      return `<span class="chip ${over ? "warn" : ""}">Tier ${i + 1}: ${have[i]}/${k} known</span>`;
    }).join("");
    return `
      <div class="cast-summary">
        <div class="cast-check">Spellcasting check: <strong>${fmtMod(mod)}</strong> (${info.label}) &middot; spell DC 10 + tier</div>
        <div class="chips">${chips || `<span class="chip">No spells known yet at level ${esc(char.level)}</span>`}</div>
      </div>`;
  }

  function applyTab() {
    sheet.querySelectorAll("[data-panel]").forEach((p) =>
      p.classList.toggle("hidden", p.dataset.panel !== sheetTab));
    sheet.querySelectorAll(".stab").forEach((b) =>
      b.classList.toggle("active", b.dataset.stab === sheetTab));
  }

  function render() {
    const s = char.stats;
    const total = gearTotal();
    const cap = freeToCarry(s.str);
    const gearOptions = GEAR_CATALOG.map((g, i) =>
      `<option value="${i}">${esc(g.name)} — ${esc(g.cost)}, ${g.slots} slot${g.slots === 1 ? "" : "s"}</option>`).join("");
    sheet.innerHTML = `
      <input class="name-input" type="text" data-path="name" value="${esc(char.name)}" placeholder="Character name">

      <nav class="sheet-tabs">
        <button class="stab" data-stab="character">Stats</button>
        <button class="stab" data-stab="combat">Weapons</button>
        <button class="stab" data-stab="gear">Gear</button>
        <button class="stab" data-stab="magic">Spells/Talents</button>
      </nav>

      <div data-panel="character">
        <section class="card">
          <div class="grid2">
            ${textField("Ancestry", "ancestry", char.ancestry)}
            ${textField("Class", "class", char.class)}
            ${textField("Title", "title", char.title)}
            ${textField("Alignment", "alignment", char.alignment)}
            ${textField("Background", "background", char.background)}
            ${textField("Deity", "deity", char.deity)}
          </div>
        </section>

        <section class="card">
          <h2>Stats</h2>
          <div class="stats-grid">
            ${ABILITIES.map((a) => `
              <div class="stat-box">
                <span class="stat-label">${a.toUpperCase()}</span>
                <input type="number" inputmode="numeric" min="1" max="20" data-path="stats.${a}" value="${esc(s[a])}">
                <span class="stat-mod" id="mod-${a}">${fmtMod(abilityMod(s[a]))}</span>
              </div>`).join("")}
          </div>
        </section>

        <section class="card">
          <h2>Vitals</h2>
          <div class="vitals">
            <div class="counter-row">
              <div class="hp-block">
                <span class="vital-label">HP</span>
                <div class="hp-controls">
                  <button class="bump" data-action="hp" data-d="-1">&minus;</button>
                  <input type="number" inputmode="numeric" data-path="hp.current" value="${esc(char.hp.current)}">
                  <span class="hp-sep">/</span>
                  <input type="number" inputmode="numeric" data-path="hp.max" value="${esc(char.hp.max)}">
                  <button class="bump" data-action="hp" data-d="1">+</button>
                </div>
              </div>
              <div class="luck-block">
                <span class="vital-label">Luck tokens</span>
                <div class="hp-controls">
                  <button class="bump" data-action="luck" data-d="-1">&minus;</button>
                  <input type="number" inputmode="numeric" min="0" data-path="luck" value="${esc(char.luck)}">
                  <button class="bump" data-action="luck" data-d="1">+</button>
                </div>
              </div>
            </div>
            <div class="vital-row">
              ${numField("AC", "ac", char.ac, 'min="0"')}
              ${numField("Level", "level", char.level, 'min="1" max="10"')}
              ${numField("XP", "xp", char.xp, 'min="0"')}
            </div>
          </div>
        </section>
      </div>

      <div data-panel="combat">
        <section class="card">
          <h2>Weapons</h2>
          <div class="row head-row head-attacks"><span>Name</span><span>Stat</span><span>Bonus</span><span>Damage</span><span class="del-spacer"></span></div>
          <div id="attacks-list">${attacksRows()}</div>
          <button class="btn add" data-action="add" data-list="attacks">+ Add weapon</button>
          <p class="ref-meta">Pick a stat and the modifier is added automatically. Put talent, mastery, and ancestry bonuses in the Bonus box.</p>
        </section>
      </div>

      <div data-panel="gear">
        <section class="card">
          <h2>Gear <span class="gear-total ${total > cap ? "warn" : ""}" id="gear-total">${total} / ${cap} slots</span></h2>
          <div class="row head-row head-gear"><span></span><span>Item</span><span>Slots</span><span>Qty</span><span></span><span class="del-spacer"></span></div>
          <div id="gear-list">${gearRows()}</div>
          <div class="gear-tools">
            <button class="btn add" data-action="add" data-list="gear">+ Add gear</button>
            <select id="gear-picker">
              <option value="">+ From gear list&hellip;</option>
              ${gearOptions}
            </select>
            <button class="btn add" data-action="kit" title="Backpack, flint &amp; steel, 2 torches, rations, spikes, hook, rope — 7 gp">+ Crawling kit</button>
          </div>
          <div class="coins">
            ${numField("GP", "coins.gp", char.coins.gp, 'min="0"')}
            ${numField("SP", "coins.sp", char.coins.sp, 'min="0"')}
            ${numField("CP", "coins.cp", char.coins.cp, 'min="0"')}
          </div>
        </section>
      </div>

      <div data-panel="magic">
        <section class="card">
          <h2>Spells</h2>
          <div id="cast-block">${spellcastingBlock()}</div>
          <div id="spells-list">${talentRows("spell")}</div>
          <button class="btn add" data-action="add" data-list="talentsAndSpells" data-type="spell">+ Add spell</button>
        </section>
        <section class="card">
          <h2>Talents</h2>
          <div id="talents-list">${talentRows("talent")}</div>
          <button class="btn add" data-action="add" data-list="talentsAndSpells" data-type="talent">+ Add talent</button>
        </section>
      </div>

      <section class="grave-tools">
        ${char.active !== false
          ? `<button class="btn danger" data-action="bury">&dagger; Mark as fallen</button>`
          : `<div class="banner red">This character lies among the fallen.</div>
             <button class="btn" data-action="revive">Return to the living</button>`}
      </section>`;
    applyTab();
  }

  /* ----- derived values ----- */

  function gearTotal() {
    return char.gear.reduce((sum, g) => sum + (Number(g.slots) || 0) * (Number(g.quantity) || 1), 0);
  }

  function updateDerived() {
    for (const a of ABILITIES) {
      const el = document.getElementById(`mod-${a}`);
      if (el) el.textContent = fmtMod(abilityMod(char.stats[a]));
    }
    const totalEl = document.getElementById("gear-total");
    if (totalEl) {
      const total = gearTotal();
      const cap = freeToCarry(char.stats.str);
      totalEl.textContent = `${total} / ${cap} slots`;
      totalEl.classList.toggle("warn", total > cap);
    }
    const castEl = document.getElementById("cast-block");
    if (castEl) castEl.innerHTML = spellcastingBlock();
    sheet.querySelectorAll(".atk-total").forEach((el) => {
      const a = char.attacks[Number(el.dataset.idx)];
      el.textContent = a ? atkTotalText(a) : "";
    });
  }

  /* ----- saving ----- */

  function scheduleSave() {
    dirty = true;
    setStatus("Editing…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 700);
  }

  async function doSave() {
    clearTimeout(saveTimer);
    dirty = false;
    setStatus("Saving…");
    try {
      await store.save(slug, char);
      exists = true;
      if (!dirty) setStatus(store.mode === "cloud" ? "Saved ✓" : "Saved to this device", "ok");
    } catch (err) {
      console.error("Save failed:", err);
      setStatus("Save failed — retrying", "err");
      saveTimer = setTimeout(doSave, 3000);
    }
  }

  /* ----- remote updates ----- */

  function applyRemote(data) {
    char = normalizeChar(slug, data);
    const active = document.activeElement;
    const editing = active && sheet.contains(active) && (active.matches("input, select, textarea"));
    if (!loaded || !editing) {
      render();
      loaded = true;
      return;
    }
    // A field is focused: sync every other input in place, leave lists alone
    // if the focused field is inside one (row counts could differ briefly).
    sheet.querySelectorAll("[data-path]").forEach((el) => {
      if (el === active) return;
      const v = getPath(char, el.dataset.path);
      if (v !== undefined && String(el.value) !== String(v)) el.value = v;
    });
    updateDerived();
  }

  const unsub = store.subscribe(slug, (data, pending) => {
    if (pending && loaded) return; // echo of our own write (but never skip the initial load)
    if (data) exists = true;
    if (dirty) return;            // don't clobber in-flight local edits
    if (!data && !exists && loaded) return; // deleted elsewhere; keep local view
    applyRemote(data);
    if (statusEl.textContent.startsWith("Loading")) setStatus("");
  });
  cleanups.push(unsub, () => { clearTimeout(saveTimer); if (dirty) doSave(); });

  // light chip in the header (shared party state)
  function paintChip() {
    const chip = document.getElementById("light-chip");
    if (!chip) return;
    const rem = (party.lightUntil || 0) - Date.now();
    chip.textContent = rem > 0 ? `\u{1F525} ${fmtCountdown(rem)}` : "";
  }
  cleanups.push(store.subscribe(PARTY_SLUG, (data) => { party = deepMerge(defaultParty(), data || {}); paintChip(); }));
  const chipTick = setInterval(paintChip, 1000);
  cleanups.push(() => clearInterval(chipTick));

  /* ----- events (delegated) ----- */

  sheet.addEventListener("input", (e) => {
    const path = e.target.dataset?.path;
    if (!path) return;
    setPath(char, path, coerce(e.target));
    // switching type moves the entry between the Spells and Talents cards
    if (path.endsWith(".type")) {
      const idx = path.split(".")[1];
      if (e.target.value !== "spell") setPath(char, `talentsAndSpells.${idx}.tier`, "");
      render();
      updateDerived();
      scheduleSave();
      return;
    }
    updateDerived();
    scheduleSave();
  });

  sheet.addEventListener("change", (e) => {
    if (e.target.id !== "gear-picker") return;
    const idx = e.target.value;
    if (idx === "") return;
    const g = GEAR_CATALOG[Number(idx)];
    char.gear.push({ name: g.name, slots: g.slots, quantity: 1, notes: "" });
    render();
    updateDerived();
    scheduleSave();
  });

  sheet.addEventListener("click", (e) => {
    const tab = e.target.closest(".stab");
    if (tab) {
      sheetTab = tab.dataset.stab;
      sessionStorage.setItem("sd_tab", sheetTab);
      applyTab();
      return;
    }
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "hp" || action === "luck") {
      const path = action === "hp" ? "hp.current" : "luck";
      let v = (Number(getPath(char, path)) || 0) + Number(btn.dataset.d);
      if (action === "luck") v = Math.max(0, v);
      setPath(char, path, v);
      const el = sheet.querySelector(`[data-path="${path}"]`);
      if (el) el.value = v;
      scheduleSave();
      return;
    }
    if (action === "add") {
      const list = btn.dataset.list;
      if (list === "attacks") char.attacks.push({ name: "", stat: "", bonus: "", damage: "" });
      if (list === "gear") char.gear.push({ name: "", slots: 1, quantity: 1, notes: "" });
      if (list === "talentsAndSpells") char.talentsAndSpells.push({ name: "", type: btn.dataset.type || "talent", tier: "", notes: "" });
      render();
      updateDerived();
      scheduleSave();
      const listId = list === "talentsAndSpells" ? (btn.dataset.type === "spell" ? "spells" : "talents") : list;
      const rows = document.getElementById(`${listId}-list`).querySelectorAll(".row:not(.head-row)");
      rows[rows.length - 1]?.querySelector("input")?.focus();
      return;
    }
    if (action === "kit") {
      char.gear.push(...CRAWLING_KIT.map((g) => ({ ...g, notes: "" })));
      render();
      updateDerived();
      scheduleSave();
      return;
    }
    if (action === "move") {
      const list = btn.dataset.list;
      const i = Number(btn.dataset.idx);
      const j = i + Number(btn.dataset.d);
      const arr = char[list];
      if (j < 0 || j >= arr.length) return;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      openNotes.clear();
      render();
      scheduleSave();
      return;
    }
    if (action === "gnotes") {
      const i = Number(btn.dataset.idx);
      if (openNotes.has(i)) openNotes.delete(i); else openNotes.add(i);
      const ta = btn.closest(".gear-row")?.querySelector(".gear-notes");
      if (ta) {
        ta.classList.toggle("hidden", !openNotes.has(i));
        if (openNotes.has(i)) ta.focus();
      }
      return;
    }
    if (action === "del") {
      const list = btn.dataset.list;
      const i = Number(btn.dataset.idx);
      const label = (char[list][i]?.name || "").trim();
      if (label && !confirm(`Remove "${label}"?`)) return;
      char[list].splice(i, 1);
      openNotes.clear();
      render();
      updateDerived();
      scheduleSave();
      return;
    }
    if (action === "bury") {
      if (!confirm(`Mark ${char.name || "this character"} as fallen? They move to The Fallen on the home page.`)) return;
      char.active = false;
      doSave();
      render();
      return;
    }
    if (action === "revive") {
      char.active = true;
      doSave();
      render();
    }
  });
}

/* ---------------- DM view ---------------- */

function renderDM() {
  if (DM_PASSCODE && localStorage.getItem("sd_dm_gate") !== DM_PASSCODE) {
    app.innerHTML = `
      <div class="gate">
        <h1 class="wordmark">DM View</h1>
        <p>The Game Master&rsquo;s seal bars the way.</p>
        <form id="dm-gate-form">
          <input type="password" id="dm-gate-input" autocomplete="off" autofocus>
          <button type="submit" class="btn primary">Enter</button>
          <p id="dm-gate-err" class="gate-err hidden">The seal holds.</p>
        </form>
        <p><a href="#/">&larr; Back to the company</a></p>
      </div>`;
    document.getElementById("dm-gate-form").addEventListener("submit", (e) => {
      e.preventDefault();
      if (document.getElementById("dm-gate-input").value === DM_PASSCODE) {
        localStorage.setItem("sd_dm_gate", DM_PASSCODE);
        renderDM();
      } else {
        document.getElementById("dm-gate-err").classList.remove("hidden");
      }
    });
    return;
  }

  app.innerHTML = `
    ${modeBanner()}
    <header class="sheet-head">
      <a class="back" href="#/">&larr; Company</a>
      <h1 class="dm-title">DM View</h1>
    </header>
    <div id="party-tools"></div>
    <div class="dm-grid" id="dm-grid"><p class="empty">Consulting the ledger&hellip;</p></div>
    <div id="npc-area"></div>`;

  const grid = document.getElementById("dm-grid");
  const toolsEl = document.getElementById("party-tools");
  const state = {}; // slug -> normalized char
  let party = defaultParty();
  let wasLit = false;

  function battleEditorHtml() {
    const entries = battleSorted(party);
    party.battle.entries = entries; // keep stored order = display order
    return `
      <section class="card battle-card" id="battle-editor">
        <h2>Current Battle</h2>
        ${entries.length ? `
          <div class="battle-rows">
            ${entries.map((en, i) => `
              <div class="row battle-row">
                <input type="number" inputmode="numeric" class="narrow" data-bt="init" data-idx="${i}" value="${esc(en.init)}" title="Initiative">
                <input type="text" data-bt="name" data-idx="${i}" value="${esc(en.name)}" placeholder="Combatant">
                <button class="del" data-action="bt-del" data-idx="${i}" title="Remove">&times;</button>
              </div>`).join("")}
          </div>` : `<p class="empty">No battle raging. Add combatants to begin.</p>`}
        <div class="row battle-row battle-add">
          <input type="number" inputmode="numeric" class="narrow" id="bt-init" placeholder="Init">
          <input type="text" id="bt-name" placeholder="Add combatant (PC or foe)&hellip;">
          <button class="btn small" data-action="bt-add">Add</button>
        </div>
        ${entries.length ? `<button class="btn small danger" data-action="bt-end">End battle &amp; clear</button>` : ""}
        <p class="ref-meta">Players see this order on the home page.</p>
      </section>`;
  }

  function paintTools() {
    const active = document.activeElement;
    if (active && toolsEl.contains(active) && active.matches("input")) return; // don't clobber typing
    toolsEl.innerHTML = lightCardHtml(party) + battleEditorHtml();
    wasLit = (party.lightUntil || 0) > Date.now();
  }

  function cardHtml(slug, c) {
    const info = casterInfo(c.class);
    const total = c.gear.reduce((s, g) => s + (Number(g.slots) || 0) * (Number(g.quantity) || 1), 0);
    const cap = freeToCarry(c.stats.str);
    const subtitle = [c.title, `Lvl ${c.level}`, c.ancestry, c.class].filter(Boolean).join(" · ");
    const atks = c.attacks.filter((a) => a.name).map((a) => {
      const t = a.stat ? fmtMod(abilityMod(c.stats[a.stat]) + (parseInt(a.bonus, 10) || 0)) : (a.bonus || "");
      return `<li>${esc(a.name)} <span class="dim">${esc(t)}${a.damage ? ", " + esc(a.damage) : ""}</span></li>`;
    }).join("");
    const spellsL = c.talentsAndSpells.filter((t) => t.name && t.type === "spell").map((t) =>
      `<li>${esc(t.name)}${t.tier ? ` <span class="dim">T${esc(t.tier)}</span>` : ""}</li>`).join("");
    const talentsL = c.talentsAndSpells.filter((t) => t.name && t.type !== "spell").map((t) =>
      `<li>${esc(t.name)}</li>`).join("");
    const hpLow = c.hp.max > 0 && c.hp.current <= Math.ceil(c.hp.max / 2);
    return `
      <h3><a href="#/c/${encodeURIComponent(slug)}">${esc(c.name || slug)}</a></h3>
      <p class="dm-sub">${esc(subtitle)}</p>
      <div class="dm-vitals">
        <div class="dm-hp ${hpLow ? "low" : ""}">
          <button class="bump" data-d="-1">&minus;</button>
          <span class="dm-hp-val">${esc(c.hp.current)}<span class="dim">/${esc(c.hp.max)}</span> HP</span>
          <button class="bump" data-d="1">+</button>
        </div>
        <span class="dm-ac">AC ${esc(c.ac)}</span>
        <span class="dim">Luck ${esc(c.luck || 0)}</span>
        <span class="dim">XP ${esc(c.xp)}</span>
      </div>
      <div class="dm-stats">
        ${ABILITIES.map((a) => `<span><b>${a.toUpperCase()}</b> ${esc(c.stats[a])} (${fmtMod(abilityMod(c.stats[a]))})</span>`).join("")}
      </div>
      ${info ? `<p class="dm-cast">Casts with ${info.label} ${fmtMod(abilityMod(c.stats[info.ability]))}</p>` : ""}
      ${atks ? `<h4>Weapons</h4><ul>${atks}</ul>` : ""}
      ${spellsL ? `<h4>Spells</h4><ul>${spellsL}</ul>` : ""}
      ${talentsL ? `<h4>Talents</h4><ul>${talentsL}</ul>` : ""}
      <p class="dm-foot dim">Gear ${total}/${cap} slots · ${esc(c.coins.gp)} gp ${esc(c.coins.sp)} sp ${esc(c.coins.cp)} cp</p>`;
  }

  function paint(chars) {
    party = partyOf(chars);
    paintTools();
    applyNpcRemote(chars);
    const entries = Object.entries(chars)
      .filter(([slug]) => !isMetaSlug(slug))
      .map(([slug, data]) => [slug, normalizeChar(slug, data)])
      .filter(([, c]) => c.active !== false)
      .sort((a, b) => (a[1].name || a[0]).localeCompare(b[1].name || b[0]));
    for (const k of Object.keys(state)) delete state[k];
    for (const [slug, c] of entries) state[slug] = c;

    grid.innerHTML = entries.length
      ? entries.map(([slug]) => `<div class="dm-card card" data-slug="${esc(slug)}"></div>`).join("")
      : `<p class="empty">No active characters.</p>`;
    for (const [slug, c] of entries) {
      grid.querySelector(`.dm-card[data-slug="${CSS.escape(slug)}"]`).innerHTML = cardHtml(slug, c);
    }
  }

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("button.bump");
    if (!btn) return;
    const slug = btn.closest(".dm-card").dataset.slug;
    const c = state[slug];
    if (!c) return;
    c.hp.current = (Number(c.hp.current) || 0) + Number(btn.dataset.d);
    store.save(slug, c);
    btn.closest(".dm-card").innerHTML = cardHtml(slug, c);
  });

  /* ----- NPC manager (below the party — the party stays on top) ----- */

  const npcArea = document.getElementById("npc-area");
  let npcDoc = defaultNpcs();
  let lastNpcJson = JSON.stringify(npcDoc);
  let npcDirty = false;
  let npcTimer = null;
  const npcOpen = new Set();       // expanded card ids
  let monsterTemplates = null;

  fetch("data/monsters.json").then((r) => r.json()).then((m) => {
    monsterTemplates = m;
    paintNpcs(true);
  }).catch((err) => console.error("Monster templates failed to load:", err));

  function blankNpc() {
    return {
      id: "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: "", disposition: "neutral", description: "",
      level: 1, alignment: "", ac: 10, armor_type: "", movement: "near",
      hp: { current: 1, max: 1 }, attack: "",
      stats: { str: "+0", dex: "+0", con: "+0", int: "+0", wis: "+0", cha: "+0" },
      actions: [],
    };
  }

  function npcFromMonster(m) {
    return {
      ...blankNpc(), name: m.name, description: m.description, level: m.level,
      alignment: m.alignment, ac: m.ac, armor_type: m.armor_type || "", movement: m.movement,
      hp: { current: m.hp, max: m.hp }, attack: m.attack,
      stats: { ...m.stats }, actions: (m.actions || []).map((a) => ({ ...a })),
    };
  }

  const DISPOSITIONS = [["friendly", "Friendly"], ["neutral", "Neutral"], ["hostile", "Hostile"]];

  function applyNpcRemote(chars) {
    if (npcDirty) return;
    const fresh = npcsOf(chars);
    const j = JSON.stringify(fresh);
    if (j === lastNpcJson) return;
    npcDoc = fresh;
    lastNpcJson = j;
    paintNpcs();
  }

  function npcSaveNow() {
    npcDirty = false;
    clearTimeout(npcTimer);
    lastNpcJson = JSON.stringify(npcDoc);
    store.save(NPCS_SLUG, npcDoc);
  }

  function npcSaveSoon() {
    npcDirty = true;
    clearTimeout(npcTimer);
    npcTimer = setTimeout(npcSaveNow, 600);
  }
  cleanups.push(() => { clearTimeout(npcTimer); if (npcDirty) npcSaveNow(); });

  function npcCardHtml(n, i) {
    const open = npcOpen.has(n.id);
    const dispOpts = DISPOSITIONS.map(([v, l]) =>
      `<option value="${v}" ${n.disposition === v ? "selected" : ""}>${l}</option>`).join("");
    const actionRows = (n.actions || []).map((a, j) => `
      <div class="row npc-action-row">
        <input type="text" placeholder="Ability name" data-npath="npcs.${i}.actions.${j}.name" value="${esc(a.name)}">
        <button class="del" data-action="npc-del-action" data-idx="${i}" data-j="${j}" title="Remove">&times;</button>
        <textarea class="notes" rows="2" placeholder="What it does" data-npath="npcs.${i}.actions.${j}.description">${esc(a.description)}</textarea>
      </div>`).join("");
    const hpLow = n.hp.max > 0 && n.hp.current <= Math.ceil(n.hp.max / 2);
    return `
      <div class="npc-card ${esc(n.disposition)}">
        <div class="npc-head">
          <button class="npc-toggle" data-action="npc-toggle" data-id="${esc(n.id)}" title="Details">${open ? "&#9662;" : "&#9656;"}</button>
          <input class="npc-name" type="text" placeholder="Name" data-npath="npcs.${i}.name" value="${esc(n.name)}">
          <button class="del" data-action="npc-del" data-idx="${i}" title="Remove">&times;</button>
        </div>
        <div class="npc-quick">
          <span class="pill">LV ${esc(n.level)}</span>
          <label class="npc-mini">AC <input type="number" inputmode="numeric" data-npath="npcs.${i}.ac" value="${esc(n.ac)}"></label>
          <span class="dm-hp ${hpLow ? "low" : ""}">
            <button class="bump" data-action="npc-hp" data-idx="${i}" data-d="-1">&minus;</button>
            <input type="number" inputmode="numeric" class="npc-hp-in" data-npath="npcs.${i}.hp.current" value="${esc(n.hp.current)}">
            <span class="hp-sep">/</span>
            <input type="number" inputmode="numeric" class="npc-hp-in" data-npath="npcs.${i}.hp.max" value="${esc(n.hp.max)}">
            <button class="bump" data-action="npc-hp" data-idx="${i}" data-d="1">+</button>
          </span>
          <select data-npath="npcs.${i}.disposition" data-role="disp" title="Disposition">${dispOpts}</select>
        </div>
        <div class="npc-body ${open ? "" : "hidden"}">
          <input type="text" class="notes" placeholder="Description / notes" data-npath="npcs.${i}.description" value="${esc(n.description)}">
          <div class="npc-grid">
            <label class="field"><span>Level</span><input type="number" inputmode="numeric" data-npath="npcs.${i}.level" data-num="1" value="${esc(n.level)}"></label>
            <label class="field"><span>Alignment</span><input type="text" data-npath="npcs.${i}.alignment" value="${esc(n.alignment)}"></label>
            <label class="field"><span>Movement</span><input type="text" data-npath="npcs.${i}.movement" value="${esc(n.movement)}"></label>
            <label class="field"><span>Armor</span><input type="text" data-npath="npcs.${i}.armor_type" value="${esc(n.armor_type)}"></label>
          </div>
          <label class="field npc-attack"><span>Attacks</span>
            <input type="text" placeholder="1 claw +2 (1d6)" data-npath="npcs.${i}.attack" value="${esc(n.attack)}"></label>
          <div class="npc-stats">
            ${ABILITIES.map((a) => `<label class="npc-stat"><span>${a.toUpperCase()}</span><input type="text" data-npath="npcs.${i}.stats.${a}" value="${esc(n.stats[a])}"></label>`).join("")}
          </div>
          <h4>Abilities</h4>
          ${actionRows || `<p class="empty">None.</p>`}
          <button class="btn add" data-action="npc-add-action" data-idx="${i}" data-id="${esc(n.id)}">+ Add ability</button>
        </div>
      </div>`;
  }

  function paintNpcs(force) {
    const active = document.activeElement;
    if (!force && active && npcArea.contains(active) && active.matches("input, select, textarea")) return;
    const npcs = npcDoc.npcs.map((n) => deepMerge(blankNpc(), n));
    npcDoc.npcs = npcs;
    const sections = DISPOSITIONS.map(([v, label]) => {
      const items = npcs.map((n, i) => [n, i]).filter(([n]) => (n.disposition || "neutral") === v);
      const emptyText = v === "hostile" ? "No foes at hand." : v === "friendly" ? "No allies recorded." : "No one of note.";
      return `
        <section class="card npc-section npc-${v}">
          <h2>${label} <span class="npc-count">${items.length}</span></h2>
          ${items.length ? items.map(([n, i]) => npcCardHtml(n, i)).join("") : `<p class="empty">${emptyText}</p>`}
          ${items.length ? `<button class="btn small danger npc-clear" data-action="npc-clear" data-disp="${v}">Clear all ${label.toLowerCase()}</button>` : ""}
        </section>`;
    }).join("");
    npcArea.innerHTML = `
      <section class="card npc-add-card">
        <h2>NPCs &amp; Foes</h2>
        <div class="npc-add-bar">
          <select id="npc-template">
            <option value="">Custom NPC (blank)</option>
            ${monsterTemplates ? monsterTemplates.map((x, i) => `<option value="${i}">${esc(x.name)} (LV ${esc(x.level)})</option>`).join("") : ""}
          </select>
          <select id="npc-disp">${DISPOSITIONS.map(([v, l]) => `<option value="${v}" ${v === "neutral" ? "selected" : ""}>${l}</option>`).join("")}</select>
          <button class="btn small" data-action="npc-add">+ Add NPC</button>
        </div>
        <p class="ref-meta">Pick a monster to use as a template — its stats copy in and stay fully editable — or add a blank Custom NPC.</p>
      </section>
      ${sections}`;
  }

  npcArea.addEventListener("input", (e) => {
    const path = e.target.dataset?.npath;
    if (!path) return;
    setPath(npcDoc, path, coerce(e.target));
    npcSaveSoon();
  });

  npcArea.addEventListener("change", (e) => {
    if (e.target.dataset?.role !== "disp") return;
    // value already applied by the input handler — move the card now
    e.target.blur();
    npcSaveNow();
    paintNpcs();
  });

  npcArea.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "npc-toggle") {
      const id = btn.dataset.id;
      if (npcOpen.has(id)) npcOpen.delete(id); else npcOpen.add(id);
      paintNpcs(true);
      return;
    }
    if (action === "npc-add") {
      const tpl = document.getElementById("npc-template").value;
      const npc = tpl === "" || !monsterTemplates ? blankNpc() : npcFromMonster(monsterTemplates[Number(tpl)]);
      npc.disposition = document.getElementById("npc-disp").value;
      if (npc.name) {
        const names = npcDoc.npcs.map((n) => n.name);
        const base = npc.name;
        let k = 2;
        while (names.includes(npc.name)) npc.name = `${base} ${k++}`;
      }
      npcOpen.add(npc.id);
      npcDoc.npcs.push(npc);
      npcSaveNow();
      paintNpcs(true);
      return;
    }
    if (action === "npc-hp") {
      const n = npcDoc.npcs[Number(btn.dataset.idx)];
      if (!n) return;
      n.hp.current = (Number(n.hp.current) || 0) + Number(btn.dataset.d);
      npcSaveNow();
      paintNpcs(true);
      return;
    }
    if (action === "npc-add-action") {
      const n = npcDoc.npcs[Number(btn.dataset.idx)];
      if (!n) return;
      n.actions.push({ name: "", description: "" });
      npcOpen.add(btn.dataset.id);
      npcSaveNow();
      paintNpcs(true);
      return;
    }
    if (action === "npc-del-action") {
      const n = npcDoc.npcs[Number(btn.dataset.idx)];
      if (!n) return;
      n.actions.splice(Number(btn.dataset.j), 1);
      npcSaveNow();
      paintNpcs(true);
      return;
    }
    if (action === "npc-del") {
      const i = Number(btn.dataset.idx);
      const name = (npcDoc.npcs[i]?.name || "").trim();
      if (name && !confirm(`Remove ${name}?`)) return;
      npcDoc.npcs.splice(i, 1);
      npcSaveNow();
      paintNpcs(true);
      return;
    }
    if (action === "npc-clear") {
      const disp = btn.dataset.disp;
      if (!confirm(`Clear ALL ${disp} NPCs?`)) return;
      npcDoc.npcs = npcDoc.npcs.filter((n) => (n.disposition || "neutral") !== disp);
      npcSaveNow();
      paintNpcs(true);
    }
  });

  paintNpcs(true);

  toolsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "light-1h") party.lightUntil = Date.now() + 3600_000;
    if (action === "light-snuff") party.lightUntil = 0;
    if (action === "bt-add") {
      const name = document.getElementById("bt-name").value.trim();
      const init = Number(document.getElementById("bt-init").value) || 0;
      if (!name) return;
      party.battle.entries.push({ name, init });
    }
    if (action === "bt-del") party.battle.entries.splice(Number(btn.dataset.idx), 1);
    if (action === "bt-end") {
      if (!confirm("End the battle and clear the initiative order?")) return;
      party.battle.entries = [];
    }
    store.save(PARTY_SLUG, party);
    if (document.activeElement) document.activeElement.blur();
    paintTools();
  });

  toolsEl.addEventListener("input", (e) => {
    const bt = e.target.dataset?.bt;
    if (!bt) return;
    const en = party.battle.entries[Number(e.target.dataset.idx)];
    if (!en) return;
    en[bt] = bt === "init" ? (Number(e.target.value) || 0) : e.target.value;
    store.save(PARTY_SLUG, party);
  });
  toolsEl.addEventListener("change", (e) => {
    if (e.target.dataset?.bt === "init") paintTools(); // re-sort once editing ends
  });

  const tick = setInterval(() => {
    const lit = (party.lightUntil || 0) > Date.now();
    if (lit !== wasLit) { paintTools(); return; }
    if (lit) {
      const el = toolsEl.querySelector(".light-count");
      if (el) el.textContent = fmtCountdown(party.lightUntil - Date.now());
    }
  }, 1000);
  cleanups.push(() => clearInterval(tick));

  cleanups.push(store.subscribeAll(paint));
}

/* ---------------- reference library ---------------- */

const refData = { spells: null, monsters: null, items: null, rules: null };
let refState = {
  tab: "spells", q: "",
  spellClass: "", spellTier: "", spellSource: "",
  monsterLevel: "", monsterSource: "",
  itemType: "", itemSource: "",
};

async function loadRefData() {
  if (refData.spells) return;
  const [spells, monsters, items, rules] = await Promise.all([
    fetch("data/spells.json").then((r) => r.json()),
    fetch("data/monsters.json").then((r) => r.json()),
    fetch("data/magic-items.json").then((r) => r.json()),
    fetch("data/rules-ref.json").then((r) => r.json()),
  ]);
  refData.spells = spells;
  refData.monsters = monsters;
  refData.items = items;
  refData.rules = rules;
}

function renderReference() {
  app.innerHTML = `
    <header class="sheet-head">
      <a class="back" href="#/">&larr; Company</a>
      <h1 class="dm-title">Reference</h1>
    </header>
    <div class="ref-tabs">
      <button class="tab" data-tab="spells">Spells</button>
      <button class="tab" data-tab="monsters">Monsters</button>
      <button class="tab" data-tab="items">Magic Items</button>
      <button class="tab" data-tab="rules">Rules</button>
    </div>
    <div class="ref-controls">
      <input type="search" id="ref-q" placeholder="Search&hellip;" value="${esc(refState.q)}">
      <span id="ref-filters"></span>
    </div>
    <p class="ref-count dim" id="ref-count"></p>
    <div id="ref-results"><p class="empty">Unrolling the scrolls&hellip;</p></div>`;

  const results = document.getElementById("ref-results");
  const qInput = document.getElementById("ref-q");
  const filtersEl = document.getElementById("ref-filters");
  const countEl = document.getElementById("ref-count");

  function setTabButtons() {
    document.querySelectorAll(".ref-tabs .tab").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === refState.tab));
  }

  const sourceSelect = (id, current, list) => {
    const sources = [...new Set(list.map((x) => x.source).filter(Boolean))].sort();
    if (sources.length < 2) return "";
    return `<select id="${id}">
      <option value="">All sources</option>
      ${sources.map((s) => `<option value="${esc(s)}" ${current === s ? "selected" : ""}>${esc(s)}</option>`).join("")}
    </select>`;
  };

  function renderFilters() {
    if (refState.tab === "spells") {
      const classes = [...new Set(refData.spells.flatMap((s) => s.classes))].sort();
      filtersEl.innerHTML = `
        <select id="f-class">
          <option value="">All classes</option>
          ${classes.map((c) => `<option value="${esc(c)}" ${refState.spellClass === c ? "selected" : ""}>${esc(c[0].toUpperCase() + c.slice(1))}</option>`).join("")}
        </select>
        <select id="f-tier">
          <option value="">All tiers</option>
          ${[1, 2, 3, 4, 5].map((t) => `<option value="${t}" ${refState.spellTier === String(t) ? "selected" : ""}>Tier ${t}</option>`).join("")}
        </select>
        ${sourceSelect("f-spell-source", refState.spellSource, refData.spells)}`;
    } else if (refState.tab === "monsters") {
      const levels = [...new Set(refData.monsters.map((m) => m.level))].sort((a, b) => a - b);
      filtersEl.innerHTML = `
        <select id="f-level">
          <option value="">All levels</option>
          ${levels.map((l) => `<option value="${l}" ${refState.monsterLevel === String(l) ? "selected" : ""}>Level ${l}</option>`).join("")}
        </select>
        ${sourceSelect("f-monster-source", refState.monsterSource, refData.monsters)}`;
    } else if (refState.tab === "items") {
      const types = [...new Set(refData.items.map((i) => i.item_type))].sort();
      filtersEl.innerHTML = `
        <select id="f-type">
          <option value="">All types</option>
          ${types.map((t) => `<option value="${esc(t)}" ${refState.itemType === t ? "selected" : ""}>${esc(t)}</option>`).join("")}
        </select>
        ${sourceSelect("f-item-source", refState.itemSource, refData.items)}`;
    } else {
      filtersEl.innerHTML = "";
    }
  }

  const srcPill = (s) => s && s !== "Core" ? ` <span class="pill alt">${esc(s)}</span>` : "";

  const spellCard = (s) => `
    <div class="ref-card card">
      <div class="ref-head"><h3>${esc(s.name)}</h3><span class="pills"><span class="pill">Tier ${esc(s.tier)}</span>${srcPill(s.source)}</span></div>
      <p class="ref-meta">${s.classes.map(esc).join(", ")} · DC ${esc(s.dc)} · Range: ${esc(s.range)} · Duration: ${esc(s.duration)}</p>
      <p>${md(s.description)}</p>
    </div>`;

  const monsterCard = (m) => `
    <div class="ref-card card">
      <div class="ref-head"><h3>${esc(m.name)}</h3><span class="pills"><span class="pill">Lvl ${esc(m.level)}</span>${srcPill(m.source)}</span></div>
      <p class="ref-desc"><em>${md(m.description)}</em></p>
      <p class="ref-meta">${esc(m.alignment)} · AC ${esc(m.ac)}${m.armor_type ? " (" + esc(m.armor_type) + ")" : ""} · HP ${esc(m.hp)} · MV ${esc(m.movement)}</p>
      <p class="ref-meta"><b>ATK</b> ${esc(m.attack)}</p>
      <p class="ref-meta">${ABILITIES.map((a) => `${a.toUpperCase()} ${esc(m.stats[a])}`).join(" · ")}</p>
      ${(m.actions || []).map((a) => `<p><b>${esc(a.name)}.</b> ${md(a.description)}</p>`).join("")}
    </div>`;

  const itemCard = (i) => `
    <div class="ref-card card">
      <div class="ref-head"><h3>${esc(i.name)}</h3><span class="pills"><span class="pill">${esc(i.item_type)}</span>${srcPill(i.source)}</span></div>
      <p class="ref-desc"><em>${md(i.description)}</em></p>
      ${i.Bonus ? `<p><b>Bonus.</b> ${md(i.Bonus)}</p>` : ""}
      ${i.Benefit ? `<p><b>Benefit.</b> ${md(i.Benefit)}</p>` : ""}
      ${i.Curse ? `<p><b>Curse.</b> ${md(i.Curse)}</p>` : ""}
      ${i.Personality ? `<p><b>Personality.</b> ${md(i.Personality)}</p>` : ""}
    </div>`;

  function rulesHtml(q) {
    const R = refData.rules;
    const match = (txt) => !q || txt.toLowerCase().includes(q);
    let count = 0;
    const sections = R.sections.map((sec) => {
      const entries = sec.entries.filter((e) => match(e.name + " " + e.text));
      if (!entries.length) return "";
      count += entries.length;
      return `<div class="ref-card card">
        <h3>${esc(sec.title)}</h3>
        ${entries.map((e) => `<p><b>${esc(e.name)}.</b> ${esc(e.text)}</p>`).join("")}
      </div>`;
    }).join("");
    const table = (title, rows, cols, headers) => {
      const filtered = rows.filter((r) => match(cols.map((c) => r[c]).join(" ")));
      if (!filtered.length) return "";
      count += filtered.length;
      return `<div class="ref-card card">
        <h3>${esc(title)}</h3>
        <table class="ref-table">
          <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
          <tbody>${filtered.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
        ${title === "Weapons" ? `<p class="ref-meta">${esc(R.weaponKey)}</p>` : ""}
      </div>`;
    };
    const html = sections
      + table("Weapons", R.weapons, ["name", "cost", "range", "damage", "properties"], ["Weapon", "Cost", "Range", "Damage", "Properties"])
      + table("Armor", R.armor, ["name", "cost", "slots", "ac", "properties"], ["Armor", "Cost", "Slots", "AC", "Properties"])
      + table("Basic Gear", R.gear, ["name", "cost", "slots"], ["Item", "Cost", "Slots"]);
    return { html: html || `<p class="empty">No matches.</p>`, count };
  }

  function refresh() {
    const q = refState.q.trim().toLowerCase();
    if (refState.tab === "rules") {
      const { html, count } = rulesHtml(q);
      countEl.textContent = `${count} entr${count === 1 ? "y" : "ies"}`;
      results.innerHTML = html;
      return;
    }
    let list, card;
    if (refState.tab === "spells") {
      list = refData.spells.filter((s) =>
        (!refState.spellClass || s.classes.includes(refState.spellClass)) &&
        (!refState.spellTier || String(s.tier) === refState.spellTier) &&
        (!refState.spellSource || s.source === refState.spellSource) &&
        (!q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)));
      card = spellCard;
    } else if (refState.tab === "monsters") {
      list = refData.monsters.filter((m) =>
        (!refState.monsterLevel || String(m.level) === refState.monsterLevel) &&
        (!refState.monsterSource || m.source === refState.monsterSource) &&
        (!q || m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q) ||
          m.attack.toLowerCase().includes(q) ||
          (m.actions || []).some((a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))));
      card = monsterCard;
    } else {
      list = refData.items.filter((i) =>
        (!refState.itemType || i.item_type === refState.itemType) &&
        (!refState.itemSource || i.source === refState.itemSource) &&
        (!q || i.name.toLowerCase().includes(q) ||
          [i.description, i.Benefit, i.Bonus, i.Curse, i.Personality].some((f) => f && f.toLowerCase().includes(q))));
      card = itemCard;
    }
    countEl.textContent = `${list.length} result${list.length === 1 ? "" : "s"}`;
    results.innerHTML = list.length ? list.map(card).join("") : `<p class="empty">No matches.</p>`;
  }

  document.querySelector(".ref-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    refState.tab = btn.dataset.tab;
    setTabButtons();
    renderFilters();
    refresh();
  });

  qInput.addEventListener("input", () => { refState.q = qInput.value; refresh(); });

  filtersEl.addEventListener("change", (e) => {
    const id = e.target.id;
    if (id === "f-class") refState.spellClass = e.target.value;
    if (id === "f-tier") refState.spellTier = e.target.value;
    if (id === "f-spell-source") refState.spellSource = e.target.value;
    if (id === "f-level") refState.monsterLevel = e.target.value;
    if (id === "f-monster-source") refState.monsterSource = e.target.value;
    if (id === "f-type") refState.itemType = e.target.value;
    if (id === "f-item-source") refState.itemSource = e.target.value;
    refresh();
  });

  loadRefData().then(() => {
    setTabButtons();
    renderFilters();
    refresh();
  }).catch((err) => {
    console.error("Failed to load reference data:", err);
    results.innerHTML = `<p class="empty">Could not load reference data. Check that the data/ folder deployed alongside the app.</p>`;
  });
}

/* ---------------- boot ---------------- */

window.addEventListener("hashchange", route);
initStore().then(route);
