#!/usr/bin/env node
/**
 * parse-exemplars.mjs
 * Reads 8 exemplar files, parses slot fills, builds frequency map,
 * generates SQL that inserts into exemplars table with atom lookups.
 *
 * Usage: node parse-exemplars.mjs
 * Output: exemplar-import.sql (execute with wrangler d1 execute)
 */
import { readFileSync, writeFileSync } from 'fs';

const DATA_ROOT = 'notes/data';

// Shared character block: 17 CSV fields, index 13 (breasts) skipped
const CHAR_SLOTS = [
  'archetype', 'height', 'build', 'face_shape', 'skin_tone',
  'hair_color', 'eye_color', 'nose', 'lips', 'chin',
  'hair_length', 'hair_texture', 'hairstyle',
  null, // breasts
  'earring_type', 'lip_color', 'lip_finish'
];
const CHAR_LEN = CHAR_SLOTS.length; // 17

function normalize(val) {
  return val
    .trim()
    .replace(/^\[\[/, '').replace(/\]\]$/, '') // strip [[Curved Nose]]
    .toLowerCase();
}

function splitFields(line) {
  return line.split(',').map(s => s.trim());
}

function parseCharBlock(fields, startIdx) {
  const result = {};
  for (let i = 0; i < CHAR_LEN && (startIdx + i) < fields.length; i++) {
    if (CHAR_SLOTS[i]) {
      result[CHAR_SLOTS[i]] = normalize(fields[startIdx + i]);
    }
  }
  return result;
}

// ---- Per-template parsers ----

function parseCharacterPortrait(fields) {
  // 0..16: char block, 17+: scene (join remaining)
  const slots = parseCharBlock(fields, 0);
  if (fields.length > CHAR_LEN) {
    slots.scene = normalize(fields.slice(CHAR_LEN).join(', '));
  }
  return slots;
}

function parseHistoricalPortrait(fields) {
  // Parse from end: last field = outfit, then 17 char, rest = style prefix
  if (fields.length < CHAR_LEN + 2) return null;
  const charStart = fields.length - 1 - CHAR_LEN;

  const slots = {};
  slots.outfit = normalize(fields.slice(fields.length - 1).join(', '));
  Object.assign(slots, parseCharBlock(fields, charStart));

  // Style prefix: variable length (8-9+ fields before char block)
  if (charStart > 0) slots.style = normalize(fields[0]);
  if (charStart > 1) slots.mood = normalize(fields[1]);
  if (charStart > 2) slots.artist = normalize(fields[2]);
  if (charStart > 3) slots.trait = normalize(fields[3]);
  if (charStart > 4) slots.technique = normalize(fields[4]);
  if (charStart > 5) slots.substyle = normalize(fields[5]);
  return slots;
}

function parseScifiPortrait(fields) {
  // 0: scifi outfit, 1..17: char, 18+: setting
  if (fields.length < CHAR_LEN + 1) return null;
  const slots = { scifi_outfit: normalize(fields[0]) };
  Object.assign(slots, parseCharBlock(fields, 1));
  if (fields.length > CHAR_LEN + 1) {
    slots.setting = normalize(fields.slice(CHAR_LEN + 1).join(', '));
  }
  return slots;
}

function parseSurrealisticPortrait(fields) {
  // Parse from end: last field = art_style, then 17 char, then surreal_setting, then "portrait"
  if (fields.length < CHAR_LEN + 3) return null;
  const charStart = fields.length - 1 - CHAR_LEN;

  const slots = {};
  slots.art_style = normalize(fields[fields.length - 1]);
  Object.assign(slots, parseCharBlock(fields, charStart));

  // fields[1..charStart-1] = surreal setting (skip field[0] = "portrait")
  if (charStart > 1) {
    slots.surreal_setting = normalize(fields.slice(1, charStart).join(', '));
  }
  return slots;
}

function parseMasterComposition(line) {
  // Special: character block is inside parentheses
  const openParen = line.indexOf('(');
  const closeParen = line.lastIndexOf(')');
  if (openParen === -1 || closeParen === -1 || closeParen <= openParen) return null;

  const prefix = line.substring(0, openParen).trim().replace(/,\s*$/, '');
  const charBlock = line.substring(openParen + 1, closeParen);
  const suffix = line.substring(closeParen + 1).trim().replace(/^,\s*/, '');

  const charFields = splitFields(charBlock);
  const suffixFields = splitFields(suffix);

  const slots = {};
  slots.quality_prefix = normalize(prefix);
  Object.assign(slots, parseCharBlock(charFields, 0));

  if (suffixFields.length > 0) slots.art_style = normalize(suffixFields[0]);
  if (suffixFields.length > 1) slots.mood = normalize(suffixFields[1]);
  if (suffixFields.length > 2) slots.pose = normalize(suffixFields[2]);
  // suffixFields[3] = pose2, skip
  if (suffixFields.length > 4) slots.color_scheme = normalize(suffixFields[4]);
  if (suffixFields.length > 5) slots.effect = normalize(suffixFields[5]);
  return slots;
}

function parseArmorPortrait(fields) {
  // 0+1: quality prefix (2 parts), 2: armor type, 3..19: char, 20+: setting
  if (fields.length < 3 + CHAR_LEN) return null;
  const slots = {};
  slots.quality_prefix = normalize(fields.slice(0, 2).join(', '));
  slots.armor_type = normalize(fields[2]);
  Object.assign(slots, parseCharBlock(fields, 3));
  if (fields.length > 3 + CHAR_LEN) {
    slots.setting = normalize(fields.slice(3 + CHAR_LEN).join(', '));
  }
  return slots;
}

function parseHobbyPortrait(fields) {
  // 0: "portrait" (skip), 1: activity, 2..18: char
  if (fields.length < 2 + CHAR_LEN) return null;
  const slots = { activity: normalize(fields[1]) };
  Object.assign(slots, parseCharBlock(fields, 2));
  return slots;
}

function parseAccessoryPortrait(fields) {
  // 0: material, 1: accessory, 2..18: char, 19+: outfit
  if (fields.length < 2 + CHAR_LEN) return null;
  const slots = {
    material: normalize(fields[0]),
    accessory: normalize(fields[1]),
  };
  Object.assign(slots, parseCharBlock(fields, 2));
  if (fields.length > 2 + CHAR_LEN) {
    slots.outfit = normalize(fields.slice(2 + CHAR_LEN).join(', '));
  }
  return slots;
}

// ---- Template definitions ----

const TEMPLATES = [
  {
    id: 'inc_character_portrait',
    slug: 'character-portrait',
    file: 'Character/physical_appearance_image.txt',
    source: 'physical_appearance_image.txt',
    parse: (line) => parseCharacterPortrait(splitFields(line)),
  },
  {
    id: 'inc_historical_portrait',
    slug: 'historical-portrait',
    file: 'Art/fine_art_female_image.txt',
    source: 'fine_art_female_image.txt',
    parse: (line) => parseHistoricalPortrait(splitFields(line)),
  },
  {
    id: 'inc_scifi_portrait',
    slug: 'scifi-portrait',
    file: 'Scenes/scifi_outfit_image.txt',
    source: 'scifi_outfit_image.txt',
    parse: (line) => parseScifiPortrait(splitFields(line)),
  },
  {
    id: 'inc_surrealistic_portrait',
    slug: 'surrealistic-portrait',
    file: 'Art/surrealistic_portrait_image.txt',
    source: 'surrealistic_portrait_image.txt',
    parse: (line) => parseSurrealisticPortrait(splitFields(line)),
  },
  {
    id: 'inc_master_composition',
    slug: 'master-composition',
    file: 'Scenes/master_composition_image.txt',
    source: 'master_composition_image.txt',
    parse: (line) => parseMasterComposition(line), // gets raw line
  },
  {
    id: 'inc_armor_portrait',
    slug: 'armor-portrait',
    file: 'Scenes/masterpiece_medieval_armor_portrait_image.txt',
    source: 'masterpiece_medieval_armor_portrait_image.txt',
    parse: (line) => parseArmorPortrait(splitFields(line)),
  },
  {
    id: 'inc_hobby_portrait',
    slug: 'hobby-portrait',
    file: 'Scenes/hobby_activity_portrait_image.txt',
    source: 'hobby_activity_portrait_image.txt',
    parse: (line) => parseHobbyPortrait(splitFields(line)),
  },
  {
    id: 'inc_accessory_portrait',
    slug: 'accessory-portrait',
    file: 'Character/accessory_combination_image.txt',
    source: 'accessory_combination_image.txt',
    parse: (line) => parseAccessoryPortrait(splitFields(line)),
  },
];

// ---- Main ----

const freqMap = new Map(); // "inc_id|slot|text" -> {inc_id, slot_name, text_lower, freq, source}
const stats = { totalLines: 0, parsedLines: 0, skippedLines: 0 };
const templateStats = {};

for (const tmpl of TEMPLATES) {
  const filePath = `${DATA_ROOT}/${tmpl.file}`;
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (e) {
    console.error(`SKIP: cannot read ${filePath}: ${e.message}`);
    continue;
  }

  const lines = content.split('\n').filter(l => l.trim().length > 0);
  let parsed = 0;
  let slotCounts = {};

  for (const line of lines) {
    stats.totalLines++;
    const slots = tmpl.parse(line);
    if (!slots) {
      stats.skippedLines++;
      continue;
    }
    parsed++;
    stats.parsedLines++;

    for (const [slotName, value] of Object.entries(slots)) {
      if (!value || value.length < 2) continue;

      const key = `${tmpl.id}|${slotName}|${value}`;
      const existing = freqMap.get(key);
      if (existing) {
        existing.freq++;
      } else {
        freqMap.set(key, {
          inc_id: tmpl.id,
          slot_name: slotName,
          text_lower: value,
          freq: 1,
          source: tmpl.source,
        });
      }
      slotCounts[slotName] = (slotCounts[slotName] || 0) + 1;
    }
  }

  templateStats[tmpl.slug] = { lines: lines.length, parsed, slots: slotCounts };
  console.log(`${tmpl.slug}: ${lines.length} lines, ${parsed} parsed, ${Object.keys(slotCounts).length} slot types`);
}

// ---- Generate SQL ----

function escapeSql(s) {
  return s.replace(/'/g, "''");
}

const sqlLines = [
  '-- Exemplar import generated by parse-exemplars.mjs',
  `-- ${new Date().toISOString()}`,
  `-- ${freqMap.size} unique (incantation, slot, atom) combinations`,
  '',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_exemplars_unique ON exemplars(incantation_id, slot_name, atom_id);',
  '',
];

for (const entry of freqMap.values()) {
  sqlLines.push(
    `INSERT OR IGNORE INTO exemplars (id, incantation_id, slot_name, atom_id, frequency, source_file)` +
    ` SELECT lower(hex(randomblob(8))), '${escapeSql(entry.inc_id)}', '${escapeSql(entry.slot_name)}',` +
    ` id, ${entry.freq}, '${escapeSql(entry.source)}'` +
    ` FROM atoms WHERE text_lower = '${escapeSql(entry.text_lower)}' LIMIT 1;`
  );
}

writeFileSync('exemplar-import.sql', sqlLines.join('\n'));

console.log(`\n--- Summary ---`);
console.log(`Total lines: ${stats.totalLines}`);
console.log(`Parsed: ${stats.parsedLines}`);
console.log(`Skipped: ${stats.skippedLines}`);
console.log(`Unique exemplar entries: ${freqMap.size}`);
console.log(`SQL written to exemplar-import.sql`);

// Print per-template slot breakdown
for (const [slug, s] of Object.entries(templateStats)) {
  const uniquePerSlot = {};
  for (const [key, entry] of freqMap) {
    if (key.startsWith(TEMPLATES.find(t => t.slug === slug)?.id + '|')) {
      const slot = entry.slot_name;
      uniquePerSlot[slot] = (uniquePerSlot[slot] || 0) + 1;
    }
  }
  console.log(`\n${slug} (${s.parsed}/${s.lines} lines):`);
  for (const [slot, count] of Object.entries(uniquePerSlot).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${slot}: ${count} unique values`);
  }
}
