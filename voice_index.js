var VOICE_FILES = VOICE_FILES || {};
const VOICE_SCENES = {
  "enter":   ["v00","v01","v21"],
  "discard": ["v02","v03","v04","v05"],
  "pon":     ["v06","v07","v08","v09"],
  "riichi":  ["v10","v11","v22"],
  "ron":     ["v12","v13"],
  "tsumo":   ["v14","v23"],
  "reveal":  ["v15","v16","v17","v24","v25"],
  "oppturn": ["v18","v19","v20"]
};

function playVoice(scene) {
  if (!VOICE_SCENES[scene] || !VOICE_SCENES[scene].length) return;
  const ids = VOICE_SCENES[scene];
  const id = ids[Math.floor(Math.random() * ids.length)];
  const src = VOICE_FILES[id];
  if (!src) return;
  try {
    const a = new Audio(src);
    a.volume = 0.9;
    a.play().catch(()=>{});
  } catch(e) {}
}
