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

// iOSのAutoPlay制限を解除するためのAudioContext
var _voiceAC = null;
function _getVoiceAC() {
  if (!_voiceAC) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (AC) _voiceAC = new AC();
  }
  return _voiceAC;
}

// 最初のユーザー操作でAudioContextをresumeしておく
function _unlockAudio() {
  var ac = _getVoiceAC();
  if (ac && ac.state === 'suspended') {
    ac.resume();
  }
  // 一度解除したらリスナー不要
  document.removeEventListener('touchstart', _unlockAudio, true);
  document.removeEventListener('touchend',   _unlockAudio, true);
  document.removeEventListener('pointerdown',_unlockAudio, true);
}
document.addEventListener('touchstart',  _unlockAudio, true);
document.addEventListener('touchend',    _unlockAudio, true);
document.addEventListener('pointerdown', _unlockAudio, true);

function playVoice(scene) {
  if (!VOICE_SCENES[scene] || !VOICE_SCENES[scene].length) return;
  var ids = VOICE_SCENES[scene];
  var id  = ids[Math.floor(Math.random() * ids.length)];
  var src = VOICE_FILES[id];
  if (!src) return;

  // AudioContextがsuspendedなら先にresumeしてから再生
  var ac = _getVoiceAC();
  var doPlay = function() {
    try {
      var a = new Audio(src);
      a.volume = 0.9;
      a.play().catch(function(){});
    } catch(e) {}
  };

  if (ac && ac.state === 'suspended') {
    ac.resume().then(doPlay).catch(doPlay);
  } else {
    doPlay();
  }
}
