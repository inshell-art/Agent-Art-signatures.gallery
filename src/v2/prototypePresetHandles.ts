/** Exact `const presets` inputs from the prototype v1.0.0 release.
 * Preserve case: it affects the formal renderer's output. These are visual
 * test inputs, not verified account identities or claims of participation. */
export const PROTOTYPE_PRESET_SOURCE_URL = "https://github.com/inshell-art/agent-art-Signature-prototype/blob/1e1dab4ec093261006feb7879c109413c0b3ac6d/src/text-seeded-bezier-line.html#L256-L267";

export const PROTOTYPE_PRESET_HANDLES = [
  "grok", "erikswahn", "yanlucasmigone", "philmo_mu", "MegaDeFi", "starlight_ai", "alexgrama", "nptacek",
  "Naminami89493534", "RikOostenbroek", "solisolsoli", "menteprompt", "TheChuckTone", "tuukzs", "arstechnoid", "migumo27",
  "jackbutcher", "92digitalArt", "Otter805", "tylerxhobbs", "UnseenAspect", "goodside", "chilltulpa", "gurbakshchahal",
  "thesilvershed", "Synth_Taxon", "enigmatriz", "musicalnetta", "ALCrego_", "whoslord", "robottraphouse", "Flexi23",
  "unstonio", "AlphaVerse", "Zangetsu_Soul", "Sneha_9090", "Danielomo_", "LodMbeki", "CoinsH97044", "Angel4u_786",
  "Omme_82", "laidoungleon", "biology_toper", "teorikeslesme", "larsdegrauw", "Tworun44", "HUMU0Rn", "leizhang48284509",
  "iliyaskhanu", "0xCryptoWizzy", "jeffersszn", "Corpstoryhq", "Ahmad_lambo", "Aristide_REGAL", "bitbull112", "konkatouyaji",
  "MinishibaKaiser", "goxkingsley_", "aa200063", "bloomifyyy", "flowersplanettt", "WildTravele", "Robinvg11", "Sentient_Lumina",
  "Damivox_", "MdRifat298138", "Lasgfix", "IsraelMath88300", "GistHubz", "Mayadamjr", "urhelen0", "spenxer_sw",
  "0xRiker", "Cynics_Alpha", "inshell_art", "lqrmynwr", "JunB17892531", "AuraMetaX", "Usamadeen_001", "WaruPanofficial1",
] as const;

/** Match the prototype's `validPresets` filter: three source entries exceed
 * the formal 15-character limit. Do not truncate or invent replacement names. */
export const VALID_PROTOTYPE_PRESET_HANDLES = PROTOTYPE_PRESET_HANDLES.filter((handle) => /^[A-Za-z0-9_]{1,15}$/.test(handle));
