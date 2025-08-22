/*
  Quran Recognize UI — Premium interactions (جذر)
  - State machine: idle → listening → processing → results → idle
  - Web Audio API used to visualize live input (bars + ring scale)
  - CSS variables drive motion for 60fps animations
*/

(function () {
  const appRoot = document.getElementById('app');
  const recordButton = document.getElementById('recordButton');
  const statusLine = document.getElementById('statusLine');
  const arabicLine = document.getElementById('arabicLine');
  const resultCard = document.getElementById('resultCard');
  const surahBadge = document.getElementById('surahBadge');
  const ayahArabic = document.getElementById('ayahArabic');
  const ayahTranslation = document.getElementById('ayahTranslation');
  const tryAgainBtn = document.getElementById('tryAgainBtn');
  const readSurahBtn = document.getElementById('readSurahBtn');
  const playRecitationBtn = document.getElementById('playRecitationBtn');
  const waveform = document.getElementById('waveform');
  const particlesCanvas = document.getElementById('particles');

  const STATE = {
    IDLE: 'idle',
    LISTENING: 'listening',
    PROCESSING: 'processing',
    RESULTS: 'results',
    ERROR: 'error',
  };

  let currentState = STATE.IDLE;
  let audioContext = null;
  let mediaStream = null;
  let analyser = null;
  let animationFrameId = null;
  let particlesAnimationId = null;
  let particlesStarted = false;
  let recitationAudio = null;
  let stopSequentialPlayback = false;
  let lastResult = null;

  // Speech recognition (Web Speech API)
  let speechRecognition = null;
  let speechActive = false;
  let latestTranscript = '';
  // watchdog removed for stability

  // External identification API (Hack Club AI)
  const HACK_CLUB_COMPLETIONS_URL = 'https://ai.hackclub.com/chat/completions';

  // Quran corpus (loaded once for deterministic matching)
  let quranCorpus = null; // { surahs: [{ englishName, ayahs: [{ text }] }] }
  const QURAN_SOURCES = [
    'https://api.alquran.cloud/v1/quran/quran-simple',
    'https://api.alquran.cloud/v1/quran/quran-uthmani',
  ];

  const BAR_COUNT = 48; // responsive via CSS; driven with transforms
  const bars = [];

  // Build bars once for the waveform
  function buildWaveformBars() {
    waveform.innerHTML = '';
    bars.length = 0;
    for (let i = 0; i < BAR_COUNT; i += 1) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      waveform.appendChild(bar);
      bars.push(bar);
    }
  }

  function setState(next) {
    currentState = next;
    appRoot.setAttribute('data-state', next);
  }

  function setStatus(text) {
    statusLine.textContent = text;
    statusLine.classList.remove('enter');
    // retrigger fadeUp animation
    void statusLine.offsetWidth; // reflow to restart animation
    statusLine.classList.add('enter');
  }

  function rippleAt(evt) {
    const wrap = recordButton.querySelector('.ripple');
    const span = document.createElement('span');
    const rect = recordButton.getBoundingClientRect();
    const x = (evt.clientX || (rect.left + rect.width / 2)) - rect.left;
    const y = (evt.clientY || (rect.top + rect.height / 2)) - rect.top;
    span.style.left = `${x}px`;
    span.style.top = `${y}px`;
    wrap.appendChild(span);
    span.addEventListener('animationend', () => span.remove());
  }

  function typewriterArabic(text) {
    arabicLine.textContent = '';
    if (!text) return;
    let i = 0;
    const chars = [...text];
    const speed = 28; // ms per char
    const interval = setInterval(() => {
      arabicLine.textContent += chars[i];
      i += 1;
      if (i >= chars.length) clearInterval(interval);
    }, speed);
  }

  function isSpeechAvailable() {
    return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
  }

  function createSpeechRecognition(lang = 'ar-SA') {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = lang;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.continuous = true;
    return rec;
  }

  function startSpeech(preferredLang = 'ar-SA') {
    if (!isSpeechAvailable()) return Promise.reject(new Error('SpeechRecognition unsupported'));
    if (!speechRecognition) {
      speechRecognition = createSpeechRecognition(preferredLang);
      speechRecognition.onresult = (event) => {
        let interim = '';
        let finalText = latestTranscript;
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const res = event.results[i];
          if (res.isFinal) finalText += res[0].transcript;
          else interim += res[0].transcript;
        }
        latestTranscript = finalText;
        const live = (finalText + ' ' + interim).trim();
        arabicLine.textContent = live;
      };
      speechRecognition.onerror = (e) => {
        console.error('SpeechRecognition error', e);
      };
      speechRecognition.onend = () => {
        if (speechActive) {
          try { speechRecognition.start(); } catch (_) {}
        }
      };
    }
    latestTranscript = '';
    speechActive = true;
    try { speechRecognition.start(); } catch (_) {}
    return Promise.resolve();
  }

  function stopSpeech() {
    speechActive = false;
    if (speechRecognition) {
      try { speechRecognition.stop(); } catch (_) {}
    }
  }

  // Arabic normalization for robust matching
  function normalizeArabic(text) {
    if (!text) return '';
    return text
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '') // harakat & signs
      .replace(/[\u0610-\u061A\u06EE\u06EF]/g, '')
      .replace(/[\u0622\u0623\u0625]/g, '\u0627') // alif variations → alif
      .replace(/[\u0649]/g, '\u064A') // alif maqsura → ya
      .replace(/[\u0629]/g, '\u0647') // ta marbuta → ha (approx)
      .replace(/[^\u0600-\u06FF\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function loadQuranCorpus() {
    if (quranCorpus) return quranCorpus;
    for (const url of QURAN_SOURCES) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data && data.data && Array.isArray(data.data.surahs)) {
          quranCorpus = {
            surahs: data.data.surahs.map((s) => ({
              englishName: s.englishName || s.englishNameTranslation || '',
              nameArabic: s.name || '',
              ayahs: (s.ayahs || []).map((a) => ({ text: a.text || '' })),
            })),
          };
          console.log('[جذر] Quran corpus loaded from', url);
          return quranCorpus;
        }
      } catch (e) {
        console.warn('[جذر] Corpus load failed from', url, e);
      }
    }
    console.warn('[جذر] Quran corpus unavailable');
    return null;
  }

  function toTrigrams(s) {
    const arr = [];
    for (let i = 0; i < s.length - 2; i += 1) arr.push(s.slice(i, i + 3));
    return new Set(arr);
  }

  function jaccard(aSet, bSet) {
    let inter = 0;
    for (const x of aSet) if (bSet.has(x)) inter += 1;
    const union = aSet.size + bSet.size - inter || 1;
    return inter / union;
  }

  function buildCandidates(corpus) {
    const candidates = [];
    corpus.surahs.forEach((s, si) => {
      const arName = s.nameArabic || `سورة ${si + 1}`;
      for (let i = 0; i < s.ayahs.length; i += 1) {
        const t1 = s.ayahs[i].text || '';
        // single
        candidates.push({ surah: arName, ayah: i + 1, text: t1 });
        // pair
        if (i + 1 < s.ayahs.length) {
          const t2 = s.ayahs[i + 1].text || '';
          candidates.push({ surah: arName, ayahStart: i + 1, ayahEnd: i + 2, text: `${t1} ${t2}` });
        }
      }
    });
    return candidates;
  }

  async function identifyByCorpus(transcript) {
    const corpus = await loadQuranCorpus();
    if (!corpus) return null;
    const T = normalizeArabic(transcript);
    if (!T) return null;
    const tSet = toTrigrams(T);
    let best = null;
    const candidates = buildCandidates(corpus);
    for (const c of candidates) {
      const cNorm = normalizeArabic(c.text);
      if (!cNorm) continue;
      const cSet = toTrigrams(cNorm);
      const score = jaccard(tSet, cSet);
      if (!best || score > best.score) best = { ...c, score };
    }
    if (best && best.score >= 0.12) { // conservative threshold
          console.log('[جذر] Corpus match score:', best.score.toFixed(3), best);
      const base = { surah: best.surah, arabic: best.text, translation: '—' };
      if (best.ayah && !best.ayahEnd) return { ...base, ayah: best.ayah };
      if (best.ayahStart && best.ayahEnd) return { ...base, ayahStart: best.ayahStart, ayahEnd: best.ayahEnd };
      return base;
    }
    return null;
  }

  function easeVolume(v) {
    // Smoothed non-linear mapping for visual emphasis
    return Math.min(1.2, Math.pow(v, 0.6) * 1.4);
  }

  function startAudio() {
    if (audioContext) return Promise.resolve();
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    return navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((stream) => {
        mediaStream = stream;
        const source = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.85;
        source.connect(analyser);
      });
  }

  function stopAudio() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
    analyser = null;
  }

  function animateWaveform() {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);

    const loop = () => {
      analyser.getByteFrequencyData(data);
      // Compute overall level for ring scale
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) sum += data[i];
      const avg = sum / data.length / 255; // 0..1
      const level = easeVolume(avg);
      document.documentElement.style.setProperty('--ring-scale', level.toFixed(3));

      // Map frequency bins to bars symmetrically
      const step = Math.max(1, Math.floor(data.length / BAR_COUNT));
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const value = data[i * step] / 255; // 0..1
        const height = Math.max(0.08, Math.pow(value, 0.8));
        bars[i].style.transform = `scaleY(${height * 3.0})`;
        bars[i].style.opacity = String(0.65 + height * 0.35);
      }

      animationFrameId = requestAnimationFrame(loop);
    };
    animationFrameId = requestAnimationFrame(loop);
  }

  // Ambient particles (very lightweight)
  function startParticles() {
    if (particlesStarted) return; // guard
    particlesStarted = true;
    const ctx = particlesCanvas.getContext('2d');
    const DPR = Math.min(2, window.devicePixelRatio || 1);
    let width = 0;
    let height = 0;
    let particles = [];

    function resize() {
      width = particlesCanvas.clientWidth;
      height = particlesCanvas.clientHeight;
      particlesCanvas.width = Math.floor(width * DPR);
      particlesCanvas.height = Math.floor(height * DPR);
      ctx.scale(DPR, DPR);
      particles = createParticles();
    }

    function createParticles() {
      const count = Math.floor(Math.min(48, Math.max(24, (width * height) / (18000 * 16))));
      const arr = [];
      for (let i = 0; i < count; i += 1) {
        arr.push({
          x: Math.random() * width,
          y: Math.random() * height,
          r: Math.random() * 1.6 + 0.4,
          a: Math.random() * Math.PI * 2,
          s: 0.06 + Math.random() * 0.12, // speed
          o: 0.05 + Math.random() * 0.08, // opacity
        });
      }
      return arr;
    }

    function draw() {
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';
      particles.forEach((p) => {
        p.a += 0.002;
        p.x += Math.cos(p.a) * p.s;
        p.y += Math.sin(p.a) * p.s * 0.6;
        if (p.x < -10) p.x = width + 10; if (p.x > width + 10) p.x = -10;
        if (p.y < -10) p.y = height + 10; if (p.y > height + 10) p.y = -10;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${p.o})`;
        ctx.shadowColor = 'rgba(255,255,255,0.15)';
        ctx.shadowBlur = 6;
        ctx.fill();
        ctx.shadowBlur = 0;
      });
      particlesAnimationId = requestAnimationFrame(draw);
    }

    window.addEventListener('resize', resize);
    resize();
    draw();
  }

  function cancelAnimations() {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    if (particlesAnimationId) cancelAnimationFrame(particlesAnimationId);
    animationFrameId = null;
    particlesAnimationId = null;
  }

  function toIdle() {
    setState(STATE.IDLE);
    setStatus('TAP TO RECOGNIZE');
    typewriterArabic('');
    resultCard.hidden = true;
    document.documentElement.style.setProperty('--ring-scale', '1');
    bars.forEach((b) => { b.style.transform = 'scaleY(0.12)'; b.style.opacity = '0.7'; });
    stopRecitation();
  }

  function toListening() {
    setState(STATE.LISTENING);
    setStatus('LISTENING… TAP AGAIN TO STOP');
    typewriterArabic('');
    // Hide any previous results while capturing
    resultCard.hidden = true;
    latestTranscript = '';
    console.log('[جذر] Listening started');
    stopRecitation();
    startAudio()
      .then(() => {
        animateWaveform();
        return startSpeech('ar-SA');
      })
      .then(() => {
        if (!analyser && !isSpeechAvailable()) toError('Microphone or Speech not available');
      })
      .catch((err) => {
        console.error(err);
      });
  }

  async function toProcessing() {
    // Capture any live transcript before UI overwrites the Arabic line
    const liveBefore = (arabicLine.textContent || '').trim();

  setState(STATE.PROCESSING);
  setStatus('MATCHING RECITATION…');
  typewriterArabic(''); // Clear transcript line to prevent overlap
  arabicLine.textContent = '';

    // stop live capture while we "process"
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    stopAudio();
    stopSpeech();
    stopRecitation();

    // Give Web Speech API a brief grace period to flush final results
    await new Promise((resolve) => setTimeout(resolve, 350));

    const loading = 'Processing audio, finding verse…';
    let i = 0; statusLine.textContent = '';
    const step = () => {
      statusLine.textContent = loading.slice(0, i);
      i += 1;
      if (i <= loading.length) requestAnimationFrame(step);
    }; step();

    const transcriptFinal = (latestTranscript || '').trim();
    const transcriptFallback = transcriptFinal || liveBefore || '';
    console.log('[جذر] Processing transcript length:', transcriptFallback.length);

    // Require meaningful Arabic transcript (avoid accidental empty/noise)
    const normalized = normalizeArabic(transcriptFallback);
    if (!normalized || normalized.length < 6) {
      console.warn('[جذر] No transcript captured; showing error');
      toError('لم يتم التقاط صوت.');
      return;
    }

    // Dual-path: deterministic corpus matching, then AI fallback
    identifyByCorpus(transcriptFallback)
      .then((match) => match || identifySurahFromTranscript(transcriptFallback))
      .then((result) => {
        if (result) toResults(result); else toError('تعذر التعرف على الآية.');
      })
      .catch((err) => {
        console.error(err);
        toError('حدث خطأ أثناء التعرف.');
      });
  }

  function toResults(result) {
    setState(STATE.RESULTS);
    setStatus('RESULTS');
    lastResult = result;
    const label = formatAyahLabel(result);
    surahBadge.textContent = `${result.surah} • ${label}`;
    ayahArabic.textContent = result.arabic;
    ayahTranslation.textContent = result.translation;
    // Update Read Surah link (quran.com/<surah_number>)
    const surahNumber = mapSurahNameToNumber(result.surah);
    if (surahNumber) {
      readSurahBtn.href = `https://quran.com/${surahNumber}`;
      readSurahBtn.removeAttribute('hidden');
    } else {
      readSurahBtn.href = '#';
      readSurahBtn.setAttribute('hidden', '');
    }
    // Enable play button when we have a mappable surah and ayah info
    if (surahNumber && (result.ayah || result.ayahStart || (Array.isArray(result.ayahs) && result.ayahs.length))) {
      playRecitationBtn.removeAttribute('hidden');
      playRecitationBtn.disabled = false;
    } else {
      playRecitationBtn.setAttribute('hidden', '');
    }
    resultCard.hidden = false;
  }

  function toError(message) {
    setState(STATE.ERROR);
    setStatus('ERROR');
    typewriterArabic('حدث خطأ.');
    ayahArabic.textContent = '';
    ayahTranslation.textContent = message || 'Something went wrong.';
    surahBadge.textContent = '—';
    resultCard.hidden = false;
  }

  function generateDummyResult() {
    const samples = [
      {
        surah: 'Al-Fatihah', ayah: 1,
        arabic: 'بِسْمِ اللّٰهِ الرَّحْمٰنِ الرَّحِيْمِ',
        translation: 'In the name of Allah, the Entirely Merciful, the Especially Merciful.'
      },
      {
        surah: 'Al-Baqarah', ayah: 255,
        arabic: 'ٱللَّهُ لَآ إِلَـٰهَ إِلَّا هُوَ ٱلْحَىُّ ٱلْقَيُّومُ',
        translation: 'Allah—there is no deity except Him, the Ever-Living, the Sustainer of [all] existence.'
      },
      {
        surah: 'Al-Ikhlas', ayah: 1,
        arabic: 'قُلْ هُوَ اللَّهُ أَحَدٌ',
        translation: 'Say, "He is Allah, [who is] One,"'
      },
    ];
    return samples[Math.floor(Math.random() * samples.length)];
  }

  async function identifySurahFromTranscript(transcript) {
    // Ask Hack Club AI to return strict JSON only
    const systemPrompt = (
      'حدد السورة والآية من نص عربي للقرآن. أعد JSON فقط بالمفاتيح: "surah" (اسم السورة بالعربية)، ' +
      'وإما "ayah" (رقم واحد) أو نطاق باستخدام "ayahStart" و"ayahEnd" (أرقام). ' +
      'أدرج "arabic" (النص العربي المطابق؛ وإن كان نطاقًا فادمج الآيات) و"translation" (ترجمة إنجليزية). ' +
      'استخدم أسماء السور العربية القياسية (الفاتحة، البقرة، …، الناس). أعد كائن JSON فقط دون أي شرح.'
    );

    const body = {
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Transcript (Arabic):\n${transcript}\nRespond with JSON only.` },
      ],
    };

    console.log('[جذر] Hack Club AI request:', body);
    const resp = await fetch(HACK_CLUB_COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Hack Club AI ${resp.status}`);
    const data = await resp.json();
    const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    console.log('[جذر] Hack Club AI response content:', content);

    // Extract JSON from content (handles code fences)
    let jsonText = content;
    const match = content.match(/\{[\s\S]*\}/);
    if (match) jsonText = match[0];
    let parsed;
    try { parsed = JSON.parse(jsonText); } catch (_) { return null; }
    const surah = parsed.surah || parsed.chapter || '—';
    const ayah = Number(parsed.ayah || parsed.verse || 0) || 0;
    const ayahStart = Number(parsed.ayahStart || parsed.verseStart || 0) || 0;
    const ayahEnd = Number(parsed.ayahEnd || parsed.verseEnd || 0) || 0;
    const ayahs = Array.isArray(parsed.ayahs) ? parsed.ayahs.map((n) => Number(n)).filter(Boolean) : null;
    const base = {
      surah,
      arabic: parsed.arabic || transcript,
      translation: parsed.translation || '—',
    };
    if (ayahs && ayahs.length) return { ...base, ayahs };
    if (ayahStart && ayahEnd) return { ...base, ayahStart, ayahEnd };
    return { ...base, ayah };
  }

  function formatAyahLabel(result) {
    if (Array.isArray(result.ayahs) && result.ayahs.length) {
      const sorted = [...result.ayahs].sort((a, b) => a - b);
      if (sorted[0] && sorted[sorted.length - 1] && sorted.length > 1) {
        return `آيات ${sorted[0]}–${sorted[sorted.length - 1]}`;
      }
      return `آية ${sorted[0]}`;
    }
    if (result.ayahStart && result.ayahEnd) {
      return `آيات ${result.ayahStart}–${result.ayahEnd}`;
    }
    return `آية ${result.ayah || 0}`;
  }

  // Event wiring
  recordButton.addEventListener('pointerdown', (e) => {
    rippleAt(e);
  });

  recordButton.addEventListener('click', async () => {
    if (currentState === STATE.IDLE) {
      setState(STATE.LISTENING);
      recordButton.setAttribute('aria-pressed', 'true');
      toListening();
      return;
    }
    if (currentState === STATE.LISTENING) {
      recordButton.setAttribute('aria-pressed', 'false');
      toProcessing();
      return;
    }
    if (currentState === STATE.RESULTS || currentState === STATE.ERROR) {
      toIdle();
      return;
    }
  });

  tryAgainBtn.addEventListener('click', () => {
    toIdle();
  });

  // Simple recitation source using Quran.com CDN (Alafasy - 64kb)
  function buildRecitationUrl(surahNumber, ayahNumber) {
    const s = String(surahNumber).padStart(3, '0');
    const a = String(ayahNumber).padStart(3, '0');
    // CDN path pattern: https://cdn.islamic.network/quran/audio/64/ar.alafasy/001001.mp3 (surah+ayah combined)
    return `https://cdn.islamic.network/quran/audio/64/ar.alafasy/${s}${a}.mp3`;
  }

  function stopRecitation() {
    stopSequentialPlayback = true;
    if (recitationAudio) {
      try { recitationAudio.pause(); } catch (_) {}
      recitationAudio = null;
    }
  }

  async function playRecitationForResult() {
    const result = lastResult;
    if (!result) return;
    const surahNumber = mapSurahNameToNumber(result.surah);
    if (!surahNumber) return;
    stopSequentialPlayback = false;

    // Determine ayah set from structured result
    let ayahList = [];
    if (Array.isArray(result.ayahs) && result.ayahs.length) {
      ayahList = [...result.ayahs].sort((a, b) => a - b);
    } else if (result.ayahStart && result.ayahEnd) {
      for (let i = result.ayahStart; i <= result.ayahEnd; i += 1) ayahList.push(i);
    } else if (result.ayah) {
      ayahList = [Number(result.ayah)];
    }
    if (!ayahList.length) return;

    for (const ayahNumber of ayahList) {
      if (stopSequentialPlayback) break;
      const url = buildRecitationUrl(surahNumber, ayahNumber);
      console.log('[جذر] Playing recitation', url);
      recitationAudio = new Audio(url);
      try {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
          recitationAudio.addEventListener('ended', resolve, { once: true });
          recitationAudio.addEventListener('error', reject, { once: true });
          recitationAudio.play().catch(reject);
        });
      } catch (e) {
        console.warn('[جذر] Recitation playback failed', e);
        break;
      }
    }
  }

  playRecitationBtn.addEventListener('click', () => {
    stopRecitation();
    playRecitationForResult();
  });

  // Surah name to number mapping (Arabic preferred), tolerant to prefixes/diacritics
  const SURAH_ARABIC_LIST = [
    'الفاتحة','البقرة','آل عمران','النساء','المائدة','الأنعام','الأعراف','الأنفال','التوبة','يونس',
    'هود','يوسف','الرعد','إبراهيم','الحجر','النحل','الإسراء','الكهف','مريم','طه',
    'الأنبياء','الحج','المؤمنون','النور','الفرقان','الشعراء','النمل','القصص','العنكبوت','الروم',
    'لقمان','السجدة','الأحزاب','سبإ','فاطر','يس','الصافات','ص','الزمر','غافر',
    'فصلت','الشورى','الزخرف','الدخان','الجاثية','الأحقاف','محمد','الفتح','الحجرات','ق',
    'الذاريات','الطور','النجم','القمر','الرحمن','الواقعة','الحديد','المجادلة','الحشر','الممتحنة',
    'الصف','الجمعة','المنافقون','التغابن','الطلاق','التحريم','الملك','القلم','الحاقة','المعارج',
    'نوح','الجن','المزمل','المدثر','القيامة','الإنسان','المرسلات','النبإ','النازعات','عبس',
    'التكوير','الإنفطار','المطففين','الإنشقاق','البروج','الطارق','الأعلى','الغاشية','الفجر','البلد',
    'الشمس','الليل','الضحى','الشرح','التين','العلق','القدر','البينة','الزلزلة','العاديات',
    'القارعة','التكاثر','العصر','الهمزة','الفيل','قريش','الماعون','الكوثر','الكافرون','النصر',
    'المسد','الإخلاص','الفلق','الناس'
  ];

  function normalizeSurahNameForMatch(name) {
    let s = normalizeArabic(name || '');
    s = s.replace(/^سوره?\s+/i, ''); // strip سورة prefix (with or without taa)
    return s;
  }

  const ARABIC_NORM_TO_NUM = new Map(
    SURAH_ARABIC_LIST.map((n, i) => [normalizeSurahNameForMatch(n), i + 1])
  );

  function mapSurahNameToNumber(surahName) {
    if (!surahName) return 0;
    const norm = normalizeSurahNameForMatch(surahName.trim());
    let num = ARABIC_NORM_TO_NUM.get(norm);
    if (!num) {
      // Substring match to handle extra words like "سورة" or suffixes like "آية 7"
      for (const [key, value] of ARABIC_NORM_TO_NUM.entries()) {
        if (norm.includes(key)) { num = value; break; }
      }
    }
    if (num) return num;
    // Fallback: common English names
    const englishToNum = new Map([
      ['Al-Fatihah',1],['Al-Baqarah',2],['Ali "Imran',3],['An-Nisa',4],['Al-Ma\'idah',5],['Al-An\'am',6],['Al-A\'raf',7],['Al-Anfal',8],['At-Tawbah',9],['Yunus',10],
      ['Hud',11],['Yusuf',12],['Ar-Ra\'d',13],['Ibrahim',14],['Al-Hijr',15],['An-Nahl',16],['Al-Isra',17],['Al-Kahf',18],['Maryam',19],['Ta-Ha',20],
      ['Al-Anbiya',21],['Al-Hajj',22],['Al-Mu\'minun',23],['An-Nur',24],['Al-Furqan',25],['Ash-Shu\'ara',26],['An-Naml',27],['Al-Qasas',28],['Al-\'Ankabut',29],['Ar-Rum',30],
      ['Luqman',31],['As-Sajdah',32],['Al-Ahzab',33],['Saba',34],['Fatir',35],['Ya-Sin',36],['As-Saffat',37],['Sad',38],['Az-Zumar',39],['Ghafir',40],
      ['Fussilat',41],['Ash-Shuraa',42],['Az-Zukhruf',43],['Ad-Dukhan',44],['Al-Jathiyah',45],['Al-Ahqaf',46],['Muhammad',47],['Al-Fath',48],['Al-Hujurat',49],['Qaf',50],
      ['Adh-Dhariyat',51],['At-Tur',52],['An-Najm',53],['Al-Qamar',54],['Ar-Rahman',55],['Al-Waqi\'ah',56],['Al-Hadid',57],['Al-Mujadila',58],['Al-Hashr',59],['Al-Mumtahanah',60],
      ['As-Saff',61],['Al-Jumu\'ah',62],['Al-Munafiqun',63],['At-Taghabun',64],['At-Talaq',65],['At-Tahrim',66],['Al-Mulk',67],['Al-Qalam',68],['Al-Haqqah',69],['Al-Ma\'arij',70],
      ['Nuh',71],['Al-Jinn',72],['Al-Muzzammil',73],['Al-Muddaththir',74],['Al-Qiyamah',75],['Al-Insan',76],['Al-Mursalat',77],['An-Naba',78],['An-Nazi\'at',79],['Abasa',80],
      ['At-Takwir',81],['Al-Infitar',82],['Al-Mutaffifin',83],['Al-Inshiqaq',84],['Al-Buruj',85],['At-Tariq',86],['Al-A\'la',87],['Al-Ghashiyah',88],['Al-Fajr',89],['Al-Balad',90],
      ['Ash-Shams',91],['Al-Layl',92],['Ad-Duha',93],['Ash-Sharh',94],['At-Tin',95],['Al-\'Alaq',96],['Al-Qadr',97],['Al-Bayyinah',98],['Az-Zalzalah',99],['Al-\'Adiyat',100],
      ['Al-Qari\'ah',101],['At-Takathur',102],['Al-\'Asr',103],['Al-Humazah',104],['Al-Fil',105],['Quraysh',106],['Al-Ma\'un',107],['Al-Kawthar',108],['Al-Kafirun',109],['An-Nasr',110],
      ['Al-Masad',111],['Al-Ikhlas',112],['Al-Falaq',113],['An-Nas',114]
    ]);
    const en = surahName.trim();
    if (englishToNum.get(en)) return englishToNum.get(en);
    // Substring English match
    for (const [k, v] of englishToNum.entries()) {
      if (en.toLowerCase().includes(k.toLowerCase())) return v;
    }
    return 0;
  }

  // Init
  function init() {
    buildWaveformBars();
    startParticles();
    toIdle();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimations();
      if (currentState === STATE.LISTENING) stopAudio();
      if (recitationAudio) { try { recitationAudio.pause(); } catch (_) {} }
    } else {
      if (currentState === STATE.LISTENING && !animationFrameId) animateWaveform();
      if (!particlesAnimationId) startParticles();
    }
  });

  window.addEventListener('resize', () => {
    // Keep bars modestly reset on resize
    bars.forEach((b) => { b.style.transform = 'scaleY(0.12)'; });
  });

  init();
})();


