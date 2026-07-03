import { firebaseConfig, APP_PASSCODE } from "./firebase-config.js";
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
  if (Object.keys(chars).length > 0) return;
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
      <p class="sub">Lost dungeons &amp; forbidden woods &mdash; a Shadowdark party tracker</p>
    </header>
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

  function paint(chars) {
    latest = chars;
    maybeSeed(chars);
    const entries = Object.entries(chars).map(([slug, data]) => [slug, normalizeChar(slug, data)])
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

  document.getElementById("new-char").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("new-char-name").value.trim();
    if (!name) return;
    let slug = slugify(name);
    while (latest[slug]) slug += "_ii";
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

function renderSheet(slug) {
  let char = defaultCharacter("");
  let dirty = false;       // local edits not yet written
  let saveTimer = null;
  let loaded = false;
  let exists = false;

  app.innerHTML = `
    ${modeBanner()}
    <header class="sheet-head">
      <a class="back" href="#/">&larr; Company</a>
      <span id="save-status" class="save-status"></span>
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

  function attacksRows() {
    if (!char.attacks.length) return `<p class="empty">No attacks yet.</p>`;
    return char.attacks.map((a, i) => `
      <div class="row attack-row">
        <input type="text" placeholder="Name" data-path="attacks.${i}.name" value="${esc(a.name)}">
        <input type="text" placeholder="+0" class="narrow" data-path="attacks.${i}.bonus" value="${esc(a.bonus)}">
        <input type="text" placeholder="1d6" class="narrow" data-path="attacks.${i}.damage" value="${esc(a.damage)}">
        <button class="del" data-action="del" data-list="attacks" data-idx="${i}" title="Remove">&times;</button>
      </div>`).join("");
  }

  function gearRows() {
    if (!char.gear.length) return `<p class="empty">Empty-handed in the dark.</p>`;
    return char.gear.map((g, i) => `
      <div class="row gear-row">
        <input type="text" placeholder="Item" data-path="gear.${i}.name" value="${esc(g.name)}">
        <input type="number" inputmode="decimal" step="any" min="0" class="narrow" title="Slots each"
          data-path="gear.${i}.slots" value="${esc(g.slots)}">
        <input type="number" inputmode="numeric" min="1" class="narrow" title="Quantity"
          data-path="gear.${i}.quantity" value="${esc(g.quantity)}">
        <button class="del" data-action="del" data-list="gear" data-idx="${i}" title="Remove">&times;</button>
      </div>`).join("");
  }

  function talentRows() {
    if (!char.talentsAndSpells.length) return `<p class="empty">Nothing recorded yet.</p>`;
    const tierOpts = (sel) => ["", 1, 2, 3, 4, 5].map((t) =>
      `<option value="${t}" ${String(sel ?? "") === String(t) ? "selected" : ""}>${t === "" ? "Tier –" : "Tier " + t}</option>`).join("");
    return char.talentsAndSpells.map((t, i) => `
      <div class="row talent-row">
        <input type="text" placeholder="Name" data-path="talentsAndSpells.${i}.name" value="${esc(t.name)}">
        <select data-path="talentsAndSpells.${i}.type">
          <option value="talent" ${t.type !== "spell" ? "selected" : ""}>Talent</option>
          <option value="spell" ${t.type === "spell" ? "selected" : ""}>Spell</option>
        </select>
        <select data-path="talentsAndSpells.${i}.tier" data-num="1" ${t.type !== "spell" ? "disabled" : ""}>
          ${tierOpts(t.tier)}
        </select>
        <button class="del" data-action="del" data-list="talentsAndSpells" data-idx="${i}" title="Remove">&times;</button>
        <input type="text" class="notes" placeholder="Notes" data-path="talentsAndSpells.${i}.notes" value="${esc(t.notes)}">
      </div>`).join("");
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

  function render() {
    const s = char.stats;
    const total = gearTotal();
    const cap = freeToCarry(s.str);
    const gearOptions = GEAR_CATALOG.map((g, i) =>
      `<option value="${i}">${esc(g.name)} — ${esc(g.cost)}, ${g.slots} slot${g.slots === 1 ? "" : "s"}</option>`).join("");
    sheet.innerHTML = `
      <input class="name-input" type="text" data-path="name" value="${esc(char.name)}" placeholder="Character name">

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
          <div class="vital-row">
            ${numField("AC", "ac", char.ac, 'min="0"')}
            ${numField("Level", "level", char.level, 'min="1" max="10"')}
            ${numField("XP", "xp", char.xp, 'min="0"')}
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Attacks</h2>
        <div class="row head-row"><span>Name</span><span class="narrow">Bonus</span><span class="narrow">Damage</span><span class="del-spacer"></span></div>
        <div id="attacks-list">${attacksRows()}</div>
        <button class="btn add" data-action="add" data-list="attacks">+ Add attack</button>
      </section>

      <section class="card">
        <h2>Gear <span class="gear-total ${total > cap ? "warn" : ""}" id="gear-total">${total} / ${cap} slots</span></h2>
        <div class="row head-row"><span>Item</span><span class="narrow">Slots</span><span class="narrow">Qty</span><span class="del-spacer"></span></div>
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

      <section class="card">
        <h2>Talents &amp; Spells</h2>
        <div id="cast-block">${spellcastingBlock()}</div>
        <div id="talents-list">${talentRows()}</div>
        <button class="btn add" data-action="add" data-list="talentsAndSpells">+ Add talent / spell</button>
      </section>

      <section class="grave-tools">
        ${char.active !== false
          ? `<button class="btn danger" data-action="bury">&dagger; Mark as fallen</button>`
          : `<div class="banner red">This character lies among the fallen.</div>
             <button class="btn" data-action="revive">Return to the living</button>`}
      </section>`;
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
    const editing = active && sheet.contains(active) && (active.matches("input, select"));
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
    if (pending) return;          // echo of our own write
    if (data) exists = true;
    if (dirty) return;            // don't clobber in-flight local edits
    if (!data && !exists && loaded) return; // deleted elsewhere; keep local view
    applyRemote(data);
    if (statusEl.textContent.startsWith("Loading")) setStatus("");
  });
  cleanups.push(unsub, () => { clearTimeout(saveTimer); if (dirty) doSave(); });

  /* ----- events (delegated) ----- */

  sheet.addEventListener("input", (e) => {
    const path = e.target.dataset?.path;
    if (!path) return;
    setPath(char, path, coerce(e.target));
    // switching an entry to "talent" clears its tier
    if (path.endsWith(".type")) {
      const idx = path.split(".")[1];
      const row = e.target.closest(".talent-row");
      const tierSel = row?.querySelector("select[data-path$='.tier']");
      if (tierSel) {
        tierSel.disabled = e.target.value !== "spell";
        if (e.target.value !== "spell") { tierSel.value = ""; setPath(char, `talentsAndSpells.${idx}.tier`, ""); }
      }
    }
    updateDerived();
    scheduleSave();
  });

  sheet.addEventListener("change", (e) => {
    if (e.target.id !== "gear-picker") return;
    const idx = e.target.value;
    if (idx === "") return;
    const g = GEAR_CATALOG[Number(idx)];
    char.gear.push({ name: g.name, slots: g.slots, quantity: 1 });
    render();
    updateDerived();
    scheduleSave();
  });

  sheet.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "hp") {
      char.hp.current = (Number(char.hp.current) || 0) + Number(btn.dataset.d);
      const el = sheet.querySelector('[data-path="hp.current"]');
      if (el) el.value = char.hp.current;
      scheduleSave();
      return;
    }
    if (action === "add") {
      const list = btn.dataset.list;
      if (list === "attacks") char.attacks.push({ name: "", bonus: "", damage: "" });
      if (list === "gear") char.gear.push({ name: "", slots: 1, quantity: 1 });
      if (list === "talentsAndSpells") char.talentsAndSpells.push({ name: "", type: "talent", tier: "", notes: "" });
      render();
      updateDerived();
      scheduleSave();
      const rows = document.getElementById(`${list === "talentsAndSpells" ? "talents" : list}-list`).querySelectorAll(".row:not(.head-row)");
      rows[rows.length - 1]?.querySelector("input")?.focus();
      return;
    }
    if (action === "kit") {
      char.gear.push(...CRAWLING_KIT.map((g) => ({ ...g })));
      render();
      updateDerived();
      scheduleSave();
      return;
    }
    if (action === "del") {
      char[btn.dataset.list].splice(Number(btn.dataset.idx), 1);
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
  app.innerHTML = `
    ${modeBanner()}
    <header class="sheet-head">
      <a class="back" href="#/">&larr; Company</a>
      <h1 class="dm-title">DM View</h1>
    </header>
    <div class="dm-grid" id="dm-grid"><p class="empty">Consulting the ledger&hellip;</p></div>`;

  const grid = document.getElementById("dm-grid");
  const state = {}; // slug -> normalized char

  function cardHtml(slug, c) {
    const info = casterInfo(c.class);
    const total = c.gear.reduce((s, g) => s + (Number(g.slots) || 0) * (Number(g.quantity) || 1), 0);
    const cap = freeToCarry(c.stats.str);
    const subtitle = [c.title, `Lvl ${c.level}`, c.ancestry, c.class].filter(Boolean).join(" · ");
    const atks = c.attacks.filter((a) => a.name).map((a) =>
      `<li>${esc(a.name)} <span class="dim">${esc(a.bonus)}${a.damage ? ", " + esc(a.damage) : ""}</span></li>`).join("");
    const talents = c.talentsAndSpells.filter((t) => t.name).map((t) =>
      `<li>${esc(t.name)}${t.type === "spell" ? ` <span class="dim">(spell${t.tier ? " T" + esc(t.tier) : ""})</span>` : ""}</li>`).join("");
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
        <span class="dim">XP ${esc(c.xp)}</span>
      </div>
      <div class="dm-stats">
        ${ABILITIES.map((a) => `<span><b>${a.toUpperCase()}</b> ${esc(c.stats[a])} (${fmtMod(abilityMod(c.stats[a]))})</span>`).join("")}
      </div>
      ${info ? `<p class="dm-cast">Casts with ${info.label} ${fmtMod(abilityMod(c.stats[info.ability]))}</p>` : ""}
      ${atks ? `<h4>Attacks</h4><ul>${atks}</ul>` : ""}
      ${talents ? `<h4>Talents &amp; Spells</h4><ul>${talents}</ul>` : ""}
      <p class="dm-foot dim">Gear ${total}/${cap} slots · ${esc(c.coins.gp)} gp ${esc(c.coins.sp)} sp ${esc(c.coins.cp)} cp</p>`;
  }

  function paint(chars) {
    const entries = Object.entries(chars).map(([slug, data]) => [slug, normalizeChar(slug, data)])
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
