const keyboardFrequencyMap =
{
  '90': 261.625565300598634,  // Z - C
  '83': 277.182630976872096,  // S - C#
  '88': 293.664767917407560,  // X - D
  '68': 311.126983722080910,  // D - D#
  '67': 329.627556912869929,  // C - E
  '86': 349.228231433003884,  // V - F
  '71': 369.994422711634398,  // G - F#
  '66': 391.995435981749294,  // B - G
  '72': 415.304697579945138,  // H - G#
  '78': 440.000000000000000,  // N - A
  '74': 466.163761518089916,  // J - A#
  '77': 493.883301256124111,  // M - B

  '81': 523.251130601197269,  // Q - C
  '50': 554.365261953744192,  // 2 - C#
  '87': 587.329535834815120,  // W - D
  '51': 622.253967444161821,  // 3 - D#
  '69': 659.255113825739859,  // E - E
  '82': 698.456462866007768,  // R - F
  '53': 739.988845423268797,  // 5 - F#
  '84': 783.990871963498588,  // T - G
  '54': 830.609395159890277,  // 6 - G#
  '89': 880.000000000000000,  // Y - A
  '55': 932.327523036179832,  // 7 - A#
  '85': 987.766602512248223   // U - B
};

let audioCtx = null;
let globalGain = null;

let analyserNode = null;
let analyserDataArray = null;

let activeNotes = {};

let statusText = null;
let waveformSelect = null;
let polyphonySelect = null;

let meterBarInner = null;
let peakNumber = null;

const ADSR =
{
  attackSeconds: 0.010,
  decaySeconds: 0.060,
  sustainLevel: 0.55,
  releaseSeconds: 0.140
};

document.addEventListener('DOMContentLoaded', function ()
{
  statusText = document.getElementById('statusText');
  waveformSelect = document.getElementById('waveformSelect');
  polyphonySelect = document.getElementById('polyphonySelect');

  meterBarInner = document.getElementById('meterBarInner');
  peakNumber = document.getElementById('peakNumber');

  window.addEventListener('keydown', keyDown, false);
  window.addEventListener('keyup', keyUp, false);

  hookKeyboardUI();
  setStatus('idle');
});


function ensureAudioReady()
{
  initAudioIfNeeded();

  if (audioCtx && audioCtx.state === 'suspended')
  {
    audioCtx.resume();
  }
}

function initAudioIfNeeded()
{
  if (audioCtx)
  {
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  window.audioCtx = audioCtx;

  globalGain = audioCtx.createGain();
  globalGain.gain.setValueAtTime(0.55, audioCtx.currentTime);

  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 2048;
  analyserDataArray = new Uint8Array(analyserNode.fftSize);

  globalGain.connect(analyserNode);
  analyserNode.connect(audioCtx.destination);

  startPeakMeterLoop();
}

function keyDown(event)
{
  if (event.repeat)
  {
    return;
  }

  const keyCode = (event.detail || event.which).toString();

  if (!keyboardFrequencyMap[keyCode])
  {
    return;
  }


  ensureAudioReady();

  if (!audioCtx)
  {
    return;
  }

  if (activeNotes[keyCode])
  {
    return;
  }

  enforcePolyphonyLimit();
  playNote(keyCode);
  setKeyActiveVisual(keyCode, true);
  setStatus('audio started');
}

function keyUp(event)
{
  const keyCode = (event.detail || event.which).toString();

  if (!keyboardFrequencyMap[keyCode])
  {
    return;
  }

  if (!audioCtx)
  {
    return;
  }

  releaseNote(keyCode);
  setKeyActiveVisual(keyCode, false);
}

function playNote(keyCode)
{
  if (!audioCtx || !globalGain)
  {
    return;
  }

  const now = audioCtx.currentTime;

  const osc = audioCtx.createOscillator();
  osc.frequency.setValueAtTime(keyboardFrequencyMap[keyCode], now);
  osc.type = getSelectedWaveform();

  const gainNode = audioCtx.createGain();

  const maxVoices = getPolyphonyLimit();
  const baseNoteGain = 0.65;
  const scaledNoteGain = baseNoteGain / Math.max(1, maxVoices);

  gainNode.gain.setValueAtTime(0.0001, now);

  const attackEnd = now + ADSR.attackSeconds;
  const decayEnd = attackEnd + ADSR.decaySeconds;

  gainNode.gain.exponentialRampToValueAtTime(Math.max(0.0001, scaledNoteGain), attackEnd);
  gainNode.gain.exponentialRampToValueAtTime(Math.max(0.0001, scaledNoteGain * ADSR.sustainLevel), decayEnd);

  osc.connect(gainNode);
  gainNode.connect(globalGain);

  osc.start();

  activeNotes[keyCode] =
  {
    osc: osc,
    gain: gainNode,
    startTime: now,
    releaseTimer: null
  };

  applyBackgroundColorFromFrequency(keyboardFrequencyMap[keyCode]);
}

function releaseNote(keyCode)
{
  if (!activeNotes[keyCode])
  {
    return;
  }

  const noteObj = activeNotes[keyCode];
  const now = audioCtx.currentTime;

  noteObj.gain.gain.cancelScheduledValues(now);

  const currentValue = Math.max(0.0001, noteObj.gain.gain.value);
  noteObj.gain.gain.setValueAtTime(currentValue, now);

  noteObj.gain.gain.exponentialRampToValueAtTime(0.0001, now + ADSR.releaseSeconds);

  const stopDelayMs = Math.ceil((ADSR.releaseSeconds + 0.02) * 1000);

  noteObj.releaseTimer = window.setTimeout(function ()
  {
    safeStopAndCleanup(keyCode);
  }, stopDelayMs);
}

function safeStopAndCleanup(keyCode)
{
  if (!activeNotes[keyCode])
  {
    return;
  }

  const noteObj = activeNotes[keyCode];

  try { noteObj.osc.stop(); } catch (e) { }
  try { noteObj.osc.disconnect(); } catch (e) { }
  try { noteObj.gain.disconnect(); } catch (e) { }

  if (noteObj.releaseTimer)
  {
    window.clearTimeout(noteObj.releaseTimer);
    noteObj.releaseTimer = null;
  }

  delete activeNotes[keyCode];
}

function getPolyphonyLimit()
{
  if (!polyphonySelect)
  {
    return 2;
  }

  const val = parseInt(polyphonySelect.value, 10);

  if (isNaN(val))
  {
    return 2;
  }

  return Math.max(1, val);
}

function enforcePolyphonyLimit()
{
  const limit = getPolyphonyLimit();
  const keys = Object.keys(activeNotes);

  if (keys.length < limit)
  {
    return;
  }

  let oldestKey = keys[0];
  let oldestTime = activeNotes[oldestKey].startTime;

  for (let i = 1; i < keys.length; i++)
  {
    const k = keys[i];

    if (activeNotes[k].startTime < oldestTime)
    {
      oldestTime = activeNotes[k].startTime;
      oldestKey = k;
    }
  }

  releaseNote(oldestKey);
}

function getSelectedWaveform()
{
  if (!waveformSelect)
  {
    return 'sine';
  }

  const val = waveformSelect.value;
  return val ? val : 'sine';
}

function hookKeyboardUI()
{
  const keyboardDiv = document.getElementById('keyboard');

  if (!keyboardDiv)
  {
    return;
  }

  const keyDivs = keyboardDiv.querySelectorAll('.key');

  for (let i = 0; i < keyDivs.length; i++)
  {
    const div = keyDivs[i];

    div.addEventListener('mousedown', function ()
    {
      ensureAudioReady();

      const code = div.getAttribute('data-code');

      if (code && keyboardFrequencyMap[code] && !activeNotes[code])
      {
        enforcePolyphonyLimit();
        playNote(code);
        setKeyActiveVisual(code, true);
        setStatus('audio started');
      }
    });

    div.addEventListener('mouseup', function ()
    {
      const code = div.getAttribute('data-code');

      if (code)
      {
        releaseNote(code);
        setKeyActiveVisual(code, false);
      }
    });

    div.addEventListener('mouseleave', function ()
    {
      const code = div.getAttribute('data-code');

      if (code)
      {
        releaseNote(code);
        setKeyActiveVisual(code, false);
      }
    });

    div.addEventListener('touchstart', function (e)
    {
      e.preventDefault();

      ensureAudioReady();

      const code = div.getAttribute('data-code');

      if (code && keyboardFrequencyMap[code] && !activeNotes[code])
      {
        enforcePolyphonyLimit();
        playNote(code);
        setKeyActiveVisual(code, true);
        setStatus('audio started');
      }
    }, { passive: false });

    div.addEventListener('touchend', function (e)
    {
      e.preventDefault();

      const code = div.getAttribute('data-code');

      if (code)
      {
        releaseNote(code);
        setKeyActiveVisual(code, false);
      }
    }, { passive: false });
  }
}

function setKeyActiveVisual(keyCode, isActive)
{
  const selector = `.key[data-code="${keyCode}"]`;
  const div = document.querySelector(selector);

  if (!div)
  {
    return;
  }

  if (isActive)
  {
    div.classList.add('active');
  }
  else
  {
    div.classList.remove('active');
  }
}

function setStatus(text)
{
  if (!statusText)
  {
    return;
  }

  statusText.textContent = 'Status: ' + text;
}

function applyBackgroundColorFromFrequency(freq)
{
  const hue = (freq % 1000) / 1000 * 360;
  document.body.style.backgroundColor = `hsl(${hue}, 70%, 35%)`;
}

function startPeakMeterLoop()
{
  if (!analyserNode || !analyserDataArray)
  {
    return;
  }

  function tick()
  {
    if (!audioCtx || !analyserNode)
    {
      window.requestAnimationFrame(tick);
      return;
    }

    analyserNode.getByteTimeDomainData(analyserDataArray);

    let peak = 0.0;

    for (let i = 0; i < analyserDataArray.length; i++)
    {
      const v = (analyserDataArray[i] - 128) / 128.0;
      const absV = Math.abs(v);

      if (absV > peak)
      {
        peak = absV;
      }
    }

    if (peakNumber)
    {
      peakNumber.textContent = peak.toFixed(3);
    }

    if (meterBarInner)
    {
      const percent = Math.min(100, Math.max(0, peak * 100));
      meterBarInner.style.width = percent.toFixed(1) + '%';
    }

    window.requestAnimationFrame(tick);
  }

  window.requestAnimationFrame(tick);
}
