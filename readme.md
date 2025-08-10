Kitab — Quran Audio Recognizer (UI Prototype)
============================================

A modern, startup‑style Quran "Shazam-like" recognition UI built with semantic HTML, modern CSS, and vanilla JS. Premium animations, accessibility, and a cool bland tech palette.

What’s inside
- Massive hero recording button with idle breathing, ripple on press, and morphing states (mic → stop → spinner)
- Live sound-wave visualization (Web Audio API) during recording
- Subtle Islamic geometric background and ambient particles
- Elegant status transitions and Arabic typewriter effect
- Polished results card and graceful error states
- Optional: Arabic speech recognition via Web Speech API and Hacklub AI integration

How to run
1. Open `index.html` directly in your browser. No build required.
2. Click the central button:
   - Idle → Listening (requests microphone)
   - Listening → Processing (stops capture and shows loading)
   - Processing → Results (dummy verse)
   - Results → Idle (tap again or use Try Again)

Notes
- This is a UI/interaction prototype. Recognition logic is mocked with sample verses.
- Animations favor transforms and opacity for 60fps performance and respect `prefers-reduced-motion`.
- Fonts default to system sans with Inter as a progressive enhancement.

Speech Recognition (optional)
- The app uses the browser’s Web Speech API if available (Chrome recommended). Arabic locale: `ar-SA`.
- Start/stop recording also starts/stops speech recognition. The transcript is sent to the Hacklub endpoint if configured.

Hack Club AI (built-in, no key)
- Uses `https://ai.hackclub.com/chat/completions` directly; no key required.
- Returns JSON describing the best‑match verse. Example expected JSON:
  ```json
  { "surah": "Al-Fatihah", "ayah": 1, "arabic": "...", "translation": "..." }
  ```

Tech
- HTML, CSS (custom properties, `clamp()`, container queries), vanilla JS
- Web Audio API for real-time visualization

License
MIT


