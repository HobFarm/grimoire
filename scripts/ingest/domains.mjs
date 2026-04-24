/**
 * Domain configurations for Wikipedia-based vocabulary extraction.
 * Each domain defines Wikipedia page titles, valid collection slugs,
 * and provenance metadata.
 */

// Collections that appear across most domains for visual vocabulary
const VISUAL_COLLECTIONS = [
  'environment', 'environment-props', 'environment-atmosphere',
  'clothing', 'clothing-accessories', 'clothing-footwear',
  'colors', 'styles', 'style-medium', 'nature',
  'features-body', 'lighting', 'composition',
];

export const DOMAINS = {
  mesoamerican: {
    label: 'Mesoamerican art, architecture, and material culture',
    tag: 'mesoamerican',
    source_app: 'wiki-mesoamerican',
    pages: [
      'Aztec_art',
      'Maya_ceramics',
      'Mesoamerican_architecture',
      'Olmec_art',
      'Quetzalcoatl',
      'Aztec_calendar_stone',
      'Maya_textiles',
      'Mesoamerican_writing_systems',
    ],
    collections: VISUAL_COLLECTIONS,
  },

  african: {
    label: 'African art, textiles, and visual culture',
    tag: 'african',
    source_app: 'wiki-african',
    pages: [
      'African_art',
      'Yoruba_art',
      'Kente_cloth',
      'Benin_Bronzes',
      'Maasai_people',
      'Dogon_people',
      'Ndebele_house_painting',
      'Adinkra_symbols',
    ],
    collections: VISUAL_COLLECTIONS,
  },

  botanical: {
    label: 'Botanical and scientific illustration techniques',
    tag: 'botanical',
    source_app: 'wiki-botanical',
    pages: [
      'Botanical_illustration',
      'Ernst_Haeckel',
      'Maria_Sibylla_Merian',
      'Copperplate_engraving',
      'Stipple_engraving',
      'Scientific_illustration',
      'Herbarium',
      'Natural_history_illustration',
    ],
    collections: VISUAL_COLLECTIONS,
  },

  'kustom-kulture': {
    label: 'Kustom Kulture, hot rod, and lowrider visual culture',
    tag: 'kustom-kulture',
    source_app: 'wiki-kustom-kulture',
    pages: [
      'Kustom_kulture',
      'Ed_Roth',
      'Von_Dutch',
      'Rat_Fink',
      'Lowrider',
      'Pinstriping',
      'Custom_car',
    ],
    collections: VISUAL_COLLECTIONS,
  },

  psychedelic: {
    label: 'Psychedelic art, concert posters, and Op art',
    tag: 'psychedelic',
    source_app: 'wiki-psychedelic',
    pages: [
      'Psychedelic_art',
      'Wes_Wilson',
      'Victor_Moscoso',
      'Peter_Max',
      'Op_art',
      'Art_Nouveau',
      'Concert_poster',
      'Liquid_light_show',
    ],
    collections: VISUAL_COLLECTIONS,
  },

  'prelinger-americana': {
    label: 'Mid-century Americana, Googie, Streamline Moderne',
    tag: 'prelinger-americana',
    source_app: 'wiki-prelinger',
    pages: [
      'Prelinger_Archives',
      'Googie_architecture',
      'Streamline_Moderne',
      'Atomic_Age_(design)',
      'Mid-century_modern',
      'Drive-in_theater',
      'Diner',
      'Suburbia',
    ],
    collections: VISUAL_COLLECTIONS,
  },

  'victorian-engraving': {
    label: 'Victorian and Edwardian visual culture and decorative arts',
    tag: 'victorian-engraving',
    source_app: 'wiki-victorian',
    pages: [
      'Victorian_era',
      'Wood_engraving',
      'Chromolithography',
      'Victorian_decorative_arts',
      'Arts_and_Crafts_movement',
    ],
    collections: VISUAL_COLLECTIONS,
  },
};
