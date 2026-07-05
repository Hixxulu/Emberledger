// The five starting PCs, seeded on first run. The roster itself is dynamic:
// characters can be added, buried, and revived from the app.
export const DEFAULT_PARTY = [
  { slug: "cassandra_rein", name: "Cassandra Rein" },
  { slug: "zrock_the_abandoned", name: "Zrock the Abandoned" },
  { slug: "bloodbrand_the_exiled", name: "Bloodbrand the Exiled" },
  { slug: "aelirion_velas", name: "Aelirion Velas" },
  { slug: "elune_the_darkborn", name: "Elune the Darkborn" },
];

export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];

export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "character";
}

// Score 1-3 => -4, 4-5 => -3, 6-7 => -2, 8-9 => -1, 10-11 => 0,
// 12-13 => +1, 14-15 => +2, 16-17 => +3, 18+ => +4
export function abilityMod(score) {
  const s = Number(score) || 0;
  if (s <= 3) return -4;
  if (s <= 5) return -3;
  if (s <= 7) return -2;
  if (s <= 9) return -1;
  if (s <= 11) return 0;
  if (s <= 13) return 1;
  if (s <= 15) return 2;
  if (s <= 17) return 3;
  return 4;
}

export function fmtMod(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}

// Free to carry: gear slots equal to STR score or 10, whichever is higher.
export function freeToCarry(str) {
  return Math.max(10, Number(str) || 0);
}

// Spells known by [tier1..tier5] per character level.
// wizard/priest verified against the Shadowdark core rulebook (V4);
// witch and Knight of St. Ydris verified against Cursed Scroll 1: Diablerie.
export const SPELLS_KNOWN = {
  wizard: {
    1: [3, 0, 0, 0, 0], 2: [4, 0, 0, 0, 0], 3: [4, 1, 0, 0, 0], 4: [4, 2, 0, 0, 0],
    5: [4, 2, 1, 0, 0], 6: [4, 3, 2, 0, 0], 7: [4, 3, 2, 1, 0], 8: [4, 4, 2, 2, 0],
    9: [4, 4, 3, 2, 1], 10: [4, 4, 4, 2, 2],
  },
  priest: {
    1: [2, 0, 0, 0, 0], 2: [3, 0, 0, 0, 0], 3: [3, 1, 0, 0, 0], 4: [3, 2, 0, 0, 0],
    5: [3, 2, 1, 0, 0], 6: [3, 2, 2, 0, 0], 7: [3, 3, 2, 1, 0], 8: [3, 3, 2, 2, 0],
    9: [3, 3, 2, 2, 1], 10: [3, 3, 3, 2, 2],
  },
  witch: {
    1: [3, 0, 0, 0, 0], 2: [4, 0, 0, 0, 0], 3: [4, 1, 0, 0, 0], 4: [4, 2, 0, 0, 0],
    5: [4, 2, 1, 0, 0], 6: [4, 3, 2, 0, 0], 7: [4, 3, 2, 1, 0], 8: [4, 4, 2, 2, 0],
    9: [4, 4, 3, 2, 1], 10: [4, 4, 4, 2, 2],
  },
  knight: {
    1: [0, 0, 0, 0, 0], 2: [0, 0, 0, 0, 0], 3: [1, 0, 0, 0, 0], 4: [2, 0, 0, 0, 0],
    5: [3, 0, 0, 0, 0], 6: [3, 1, 0, 0, 0], 7: [3, 2, 0, 0, 0], 8: [3, 3, 0, 0, 0],
    9: [3, 3, 1, 0, 0], 10: [3, 3, 2, 0, 0],
  },
};

// Wizard casts with INT, priest with WIS, witch and Knight of St. Ydris
// with CHA (witch spell list). Substring match so "Elf Wizard" still counts.
export function casterInfo(className) {
  const c = String(className || "").toLowerCase();
  if (c.includes("wizard")) return { type: "wizard", ability: "int", label: "INT" };
  if (c.includes("priest")) return { type: "priest", ability: "wis", label: "WIS" };
  if (c.includes("witch")) return { type: "witch", ability: "cha", label: "CHA" };
  if (c.includes("ydris") || c.includes("knight")) return { type: "knight", ability: "cha", label: "CHA" };
  return null;
}

export function spellsKnownAtLevel(type, level) {
  const lvl = Math.min(10, Math.max(1, Number(level) || 1));
  return SPELLS_KNOWN[type][lvl];
}

// Standard gear for the sheet's quick-add picker: name, slots per item, cost.
export const GEAR_CATALOG = [
  { name: "Torch", slots: 1, cost: "5 sp" },
  { name: "Rations (3)", slots: 1, cost: "5 sp" },
  { name: "Rope, 60'", slots: 1, cost: "1 gp" },
  { name: "Backpack", slots: 0, cost: "2 gp" },
  { name: "Flint and steel", slots: 1, cost: "5 sp" },
  { name: "Iron spikes (10)", slots: 1, cost: "1 gp" },
  { name: "Grappling hook", slots: 1, cost: "1 gp" },
  { name: "Lantern", slots: 1, cost: "5 gp" },
  { name: "Oil, flask", slots: 1, cost: "5 sp" },
  { name: "Arrows (20)", slots: 1, cost: "1 gp" },
  { name: "Crossbow bolts (20)", slots: 1, cost: "1 gp" },
  { name: "Caltrops (one bag)", slots: 1, cost: "5 sp" },
  { name: "Crowbar", slots: 1, cost: "5 sp" },
  { name: "Flask or bottle", slots: 1, cost: "3 sp" },
  { name: "Mirror", slots: 1, cost: "10 gp" },
  { name: "Pole", slots: 1, cost: "5 sp" },
  { name: "Leather armor", slots: 1, cost: "10 gp" },
  { name: "Chainmail", slots: 2, cost: "60 gp" },
  { name: "Plate mail", slots: 3, cost: "130 gp" },
  { name: "Shield", slots: 1, cost: "10 gp" },
  { name: "Dagger", slots: 1, cost: "1 gp" },
  { name: "Shortsword", slots: 1, cost: "7 gp" },
  { name: "Longsword", slots: 1, cost: "9 gp" },
  { name: "Bastard sword", slots: 2, cost: "10 gp" },
  { name: "Greatsword", slots: 2, cost: "12 gp" },
  { name: "Greataxe", slots: 2, cost: "10 gp" },
  { name: "Warhammer", slots: 1, cost: "10 gp" },
  { name: "Mace", slots: 1, cost: "5 gp" },
  { name: "Club", slots: 1, cost: "5 cp" },
  { name: "Staff", slots: 1, cost: "5 sp" },
  { name: "Spear", slots: 1, cost: "5 sp" },
  { name: "Javelin", slots: 1, cost: "5 sp" },
  { name: "Shortbow", slots: 1, cost: "6 gp" },
  { name: "Longbow", slots: 1, cost: "8 gp" },
  { name: "Crossbow", slots: 1, cost: "8 gp" },
];

// Crawling kit: 7 gp, 7 slots.
export const CRAWLING_KIT = [
  { name: "Backpack", slots: 0, quantity: 1 },
  { name: "Flint and steel", slots: 1, quantity: 1 },
  { name: "Torch", slots: 1, quantity: 2 },
  { name: "Rations (3)", slots: 1, quantity: 1 },
  { name: "Iron spikes (10)", slots: 1, quantity: 1 },
  { name: "Grappling hook", slots: 1, quantity: 1 },
  { name: "Rope, 60'", slots: 1, quantity: 1 },
];

export function defaultCharacter(name) {
  return {
    name: name || "",
    active: true,
    ancestry: "",
    class: "",
    title: "",
    alignment: "",
    background: "",
    deity: "",
    stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    hp: { current: 0, max: 0 },
    ac: 10,
    luck: 0,
    xp: 0,
    level: 1,
    gear: [],
    coins: { gp: 0, sp: 0, cp: 0 },
    attacks: [],
    talentsAndSpells: [],
  };
}
