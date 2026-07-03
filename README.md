# Vermis — Shadowdark Party Tracker

A single-page web app for a Shadowdark RPG party, themed after Plastiboo's
*Vermis* guidebooks (aged parchment, blackletter, crimson and marsh-green).
Each player opens the same URL on any phone or tablet, picks their character,
and edits their sheet; the DM gets a view of the whole company at once.
Character data lives in Firebase Firestore and syncs live between devices.
A searchable reference library of spells, monsters, magic items, and core
rules is bundled in.

No build step, no framework, no login. Plain HTML/CSS/JS, hosted on GitHub Pages.

## Layout

```
index.html            app shell + Google Fonts + attribution footer
css/styles.css        Vermis theme
js/app.js             views, routing, live sync, roster management
js/rules.js           modifier table, spells-known tables, gear catalog
js/firebase-config.js YOUR Firebase config goes here (placeholders now)
data/spells.json      131 spells (Core + Cursed Scroll 1 witch spells)
data/monsters.json    257 monsters (Core + Cursed Scroll 1)
data/magic-items.json 117 items (Core + Cursed Scroll 1 trinkets)
data/rules-ref.json   rules quick reference + weapons/armor/gear tables
```

Until a real Firebase config is pasted in, the app runs in **device-only mode**:
fully functional, but data saves to the browser's localStorage and does not
sync between devices. A banner says so.

## Characters

- The roster is **dynamic**: add new adventurers from the home page, mark a
  character as fallen from the bottom of their sheet, revive or permanently
  delete them from **The Fallen** section on the home page.
- The DM view and the character list show only **active** characters.
- On first run the app seeds the five starting PCs (Cassandra Rein, Zrock the
  Abandoned, Bloodbrand the Exiled, Aelirion Velas, Elune the Darkborn).
- Spellcaster sheets know the class progressions: **wizard** (INT), **priest**
  (WIS), **witch** and **Knight of St. Ydris** (CHA, witch spell list).
  Tables verified against the core rulebook V4 and Cursed Scroll 1.
- The gear section has a quick-add picker for standard equipment (with slot
  costs) and a one-tap crawling kit.

## One-time setup

### 1. Firebase (cloud sync)

1. Go to [firebase.google.com](https://firebase.google.com), create a project
   (any name, Analytics not needed).
2. In the project: **Build > Firestore Database > Create database**, test mode.
3. **Project settings (gear icon) > General > Your apps > Web (`</>`)**.
   Register the app; copy the `firebaseConfig` values into
   [js/firebase-config.js](js/firebase-config.js). The config is an
   identifier, not a secret — safe to commit.
4. **Firestore > Rules** — because characters can now be added and removed,
   the rules allow the whole `characters` collection:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /characters/{slug} {
         allow read, write: if true;
       }
     }
   }
   ```

   Anyone with the URL can edit the party. That is the intended model for a
   private group link; for a light deterrent set `APP_PASSCODE` in
   `js/firebase-config.js` (a UI gate only — the Firestore rules are the real
   boundary, so don't share the URL beyond the table).

### 2. GitHub Pages (hosting)

1. Create a GitHub repository and push the app files
   (`index.html`, `css/`, `js/`, `data/`, `.nojekyll`). **Do not push**
   `Shadowdark-Core/`, `Shadowdark-Zines/`, or `Vermis/` — those are
   copyrighted books.
2. Repo **Settings > Pages > Source: Deploy from a branch**, branch `main`,
   folder `/ (root)`.
3. The app appears at `https://<user>.github.io/<repo>/`. Share that URL.

## Views

- `#/` — active characters, add new, The Fallen (revive/delete)
- `#/c/<slug>` — a character sheet (live-synced, autosaves ~0.7s after typing stops)
- `#/dm` — all active sheets in a compact grid, with quick HP +/− buttons
- `#/ref` — spells / monsters / magic items / rules quick reference, with
  search plus class, tier, level, type, and source filters (works offline
  once loaded)

## Reference data & license

Core spell, monster, and magic item JSON comes from
[dickloraine/shadowdark-resources](https://github.com/dickloraine/shadowdark-resources).
Witch spells, Gloaming monsters, and diabolical trinkets were transcribed from
*Cursed Scroll 1: Diablerie*. The Shadowdark RPG Third-Party License designates
spells, monsters, and magic items as reusable; the required attribution line is
in the app footer. The rules tab is a terse paraphrase of game procedures, not
rulebook text. Do not add the Shadowdark logo or wordmark to the app. The
visual theme is an homage to *Vermis* (Plastiboo / Hollow Press) — no imagery
from the book is included.

## Local development

`.claude/serve.ps1` is a tiny PowerShell static server for local testing
(`powershell -File .claude/serve.ps1`, then http://localhost:8321). The
deployed site is purely static files.
