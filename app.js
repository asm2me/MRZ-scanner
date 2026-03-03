(function () {
    /* ── DOM ──────────────────────────────────────────────────────────────── */
    const video          = document.getElementById('video');
    const canvas         = document.getElementById('canvas');
    const overlay        = document.getElementById('overlay');
    const message        = document.getElementById('message');
    const permTip        = document.getElementById('perm-tip');
    const focusControls  = document.getElementById('focus-controls');
    const focusModeSelect= document.getElementById('focus-mode-select');
    const focusDistRow   = document.getElementById('focus-dist-row');
    const focusRange     = document.getElementById('focus-range');
    const focusVal       = document.getElementById('focus-val');
    const ocrPreview     = document.getElementById('ocr-preview');
    const ocrText        = document.getElementById('ocr-text');
    const ocrLines       = document.getElementById('ocr-lines');
    const ocrFields      = document.getElementById('ocr-fields');
    const ctx            = canvas.getContext('2d');
    const ovCtx          = overlay.getContext('2d');

    /* ── Passport guide proportions (TD-3: 125 mm × 88 mm) ───────────────── */
    const P = {
        xFrac : 0.04,
        wFrac : 0.92,
        get hFrac() { return this.wFrac * (88 / 125); },
        get yFrac()  { return 0.5 - this.hFrac / 2; },
        mrzFrac: 0.27,   // MRZ = bottom 27 % of passport height
    };

    /* ── Overlay ──────────────────────────────────────────────────────────── */
    function drawOverlay() {
        const W = overlay.width, H = overlay.height;
        if (!W || !H) return;

        const px = P.xFrac * W, py = P.yFrac * H;
        const pw = P.wFrac * W, ph = P.hFrac * H;
        const mrzH = P.mrzFrac * ph, mrzY = py + ph - mrzH;

        ovCtx.clearRect(0, 0, W, H);

        // dark vignette outside the passport cutout
        ovCtx.fillStyle = 'rgba(0,0,0,0.55)';
        ovCtx.beginPath();
        ovCtx.rect(0, 0, W, H);
        ovCtx.rect(px, py, pw, ph);
        ovCtx.fill('evenodd');

        // MRZ highlight band
        ovCtx.fillStyle = 'rgba(0,180,255,0.18)';
        ovCtx.fillRect(px, mrzY, pw, mrzH);

        // dashed separator above MRZ
        ovCtx.save();
        ovCtx.setLineDash([6, 4]);
        ovCtx.strokeStyle = 'rgba(0,180,255,0.75)';
        ovCtx.lineWidth = 1.5;
        ovCtx.beginPath();
        ovCtx.moveTo(px, mrzY);
        ovCtx.lineTo(px + pw, mrzY);
        ovCtx.stroke();
        ovCtx.restore();

        // passport border
        ovCtx.strokeStyle = 'rgba(255,255,255,0.7)';
        ovCtx.lineWidth = 1.5;
        ovCtx.strokeRect(px, py, pw, ph);

        // corner brackets
        const bLen = Math.min(pw, ph) * 0.075;
        ovCtx.strokeStyle = '#00b4ff';
        ovCtx.lineWidth = 3;
        ovCtx.lineCap = 'square';
        [[px, py, 1, 1], [px + pw, py, -1, 1], [px, py + ph, 1, -1], [px + pw, py + ph, -1, -1]]
            .forEach(([cx, cy, dx, dy]) => {
                ovCtx.beginPath();
                ovCtx.moveTo(cx + dx * bLen, cy);
                ovCtx.lineTo(cx, cy);
                ovCtx.lineTo(cx, cy + dy * bLen);
                ovCtx.stroke();
            });

        // "MRZ" label
        ovCtx.font = `bold ${Math.max(11, pw * 0.028)}px monospace`;
        ovCtx.textAlign = 'center';
        ovCtx.textBaseline = 'middle';
        ovCtx.fillStyle = 'rgba(0,180,255,0.9)';
        ovCtx.fillText('MRZ', px + pw / 2, mrzY + mrzH / 2);

        // instruction above frame
        ovCtx.font = `${Math.max(11, W * 0.024)}px sans-serif`;
        ovCtx.fillStyle = 'rgba(255,255,255,0.85)';
        ovCtx.textBaseline = 'bottom';
        ovCtx.fillText('Align passport within the guide', W / 2, py - 8);
    }

    function resizeOverlay() {
        overlay.width  = video.offsetWidth  || 320;
        overlay.height = video.offsetHeight || 240;
        drawOverlay();
    }

    /* ── MRZ strip capture ────────────────────────────────────────────────── */
    // Crops the MRZ band from the live video frame and scales it up 3× for OCR.
    // No binarization: Tesseract's mrz model handles colour/greyscale natively.
    function captureMRZStrip() {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const W = canvas.width, H = canvas.height;

        const py   = P.yFrac  * H;
        const ph   = P.hFrac  * H;
        const mrzH = P.mrzFrac * ph;
        const mrzY = py + ph - mrzH;

        // Add 25 % vertical padding so slight vertical misalignment is tolerated
        const padH = mrzH * 0.25;
        const sy   = Math.max(0, Math.floor(mrzY - padH));
        const sh   = Math.min(H - sy, Math.ceil(mrzH + padH * 2));

        const src = document.createElement('canvas');
        src.width  = W;
        src.height = sh;
        src.getContext('2d').putImageData(ctx.getImageData(0, sy, W, sh), 0, 0);

        // 3× upscale — larger glyphs improve Tesseract classification accuracy
        const SCALE = 3;
        const dst   = document.createElement('canvas');
        dst.width   = W * SCALE;
        dst.height  = sh * SCALE;
        const dCtx  = dst.getContext('2d');
        dCtx.imageSmoothingEnabled  = true;
        dCtx.imageSmoothingQuality  = 'high';
        dCtx.drawImage(src, 0, 0, dst.width, dst.height);

        // Mirror to the debug preview canvas
        ocrPreview.width  = dst.width;
        ocrPreview.height = dst.height;
        ocrPreview.getContext('2d').drawImage(dst, 0, 0);

        return dst;
    }

    /* ── Tesseract worker ─────────────────────────────────────────────────── */
    let worker = null;

    async function initWorker() {
        worker = await Tesseract.createWorker('eng', 1, {
            logger: m => {
                if (m.status === 'loading tesseract core')
                    message.textContent = 'Loading OCR engine…';
                if (m.status === 'loading language traineddata')
                    message.textContent = 'Loading OCR model…';
            },
        });
        await worker.setParameters({
            tessedit_pageseg_mode: '6',   // single uniform block of text
        });
    }

    /* ── Line cleaning ────────────────────────────────────────────────────── */
    // Maps common OCR misreads of '<' back to '<', then strips everything else.
    function cleanLine(raw) {
        return raw
            .toUpperCase()
            .replace(/[\s\-_«»(){}\[\]|\\\/.,;:'"]/g, '<')
            .replace(/[^A-Z0-9<]/g, '');
    }

    /* ── Debug fields table ───────────────────────────────────────────────── */
    function showDebugFields(parsed) {
        if (!parsed || !parsed.fields) { ocrFields.style.display = 'none'; return; }
        const LABELS = {
            documentCode: 'Doc type', issuer: 'Issuer', surname: 'Surname',
            givenNames: 'Given names', passportNumber: 'Doc number',
            nationality: 'Nationality', birthDate: 'Birth date',
            sex: 'Sex', expiryDate: 'Expiry', personalNumber: 'Personal no.',
        };
        const rows = Object.entries(parsed.fields)
            .filter(([, v]) => v)
            .map(([k, v]) => `<tr><td>${LABELS[k] || k}</td><td>${v}</td></tr>`)
            .join('');
        const status = parsed.valid
            ? '<tr><td colspan="2" style="color:#4ade80;padding-bottom:4px">✓ Valid checksum</td></tr>'
            : '<tr><td colspan="2" style="color:#f87171;padding-bottom:4px">✗ Checksum invalid</td></tr>';
        ocrFields.innerHTML = `<table><tbody>${status}${rows}</tbody></table>`;
        ocrFields.style.display = 'block';
    }

    /* ── MRZ recognition ──────────────────────────────────────────────────── */
    async function recognizeMRZ() {
        if (!worker) return null;

        const strip = captureMRZStrip();
        const imgData = strip.getContext('2d').getImageData(0, 0, strip.width, strip.height);
        const { data: { text } } = await worker.recognize(imgData);

        ocrText.textContent = text || '(empty)';
        console.log('[MRZ raw]', JSON.stringify(text));

        const lines = text
            .split(/[\r\n]+/)
            .map(cleanLine)
            .filter(l => l.length >= 20);

        if (ocrLines) ocrLines.textContent = lines.length
            ? lines.join('\n')
            : '(no candidate lines found)';

        let best = null;

        for (let i = 0; i < lines.length; i++) {
            // TD-3 passport: 2 lines × 44 chars
            if (i + 1 < lines.length) {
                const g2 = [lines[i].slice(0, 44), lines[i + 1].slice(0, 44)];
                if (g2[0].length >= 35 && g2[1].length >= 35) {
                    try {
                        const r = MRZ.parse(g2);
                        if (r) { if (!best) best = r; if (r.valid) { best = r; break; } }
                    } catch (e) {}
                }
            }
            // TD-1 ID card: 3 lines × 30 chars
            if (i + 2 < lines.length) {
                const g3 = [
                    lines[i    ].slice(0, 30),
                    lines[i + 1].slice(0, 30),
                    lines[i + 2].slice(0, 30),
                ];
                if (g3[0].length >= 24) {
                    try {
                        const r = MRZ.parse(g3);
                        if (r) { if (!best) best = r; if (r.valid) { best = r; break; } }
                    } catch (e) {}
                }
            }
        }

        showDebugFields(best);
        return (best && best.valid) ? best : null;
    }

    /* ── Beep ─────────────────────────────────────────────────────────────── */
    let _audioCtx = null;
    function getAudioCtx() {
        if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        return _audioCtx;
    }
    document.addEventListener('pointerdown', () => {
        const ac = getAudioCtx();
        if (ac.state === 'suspended') ac.resume();
    });
    function playBeep() {
        try {
            const ac = getAudioCtx();
            if (ac.state === 'suspended') { ac.resume(); return; }
            const o = ac.createOscillator();
            o.frequency.value = 1000;
            o.connect(ac.destination);
            o.start();
            o.stop(ac.currentTime + 0.2);
        } catch (e) {}
    }

    /* ── Scan loop ────────────────────────────────────────────────────────── */
    let lastScan = 0, busy = false;

    async function scanFrame() {
        const now = Date.now();
        if (!busy && now - lastScan > 800) {
            lastScan = now;
            busy = true;
            if (worker) message.textContent = 'Scanning…';
            try {
                const parsed = await recognizeMRZ();
                if (parsed && parsed.valid) {
                    message.textContent = 'MRZ detected — redirecting…';
                    playBeep();
                    const params = new URLSearchParams();
                    for (const k in parsed.fields) params.set(k, parsed.fields[k]);
                    window.location.href = 'result.html?' + params.toString();
                    return;
                } else {
                    message.textContent = worker
                        ? 'No valid MRZ found — align passport with the guide'
                        : 'Initializing OCR engine…';
                }
            } catch (e) {
                console.error(e);
                message.textContent = 'OCR error: ' + (e?.message || String(e));
            }
            busy = false;
        }
        requestAnimationFrame(scanFrame);
    }

    /* ── Focus controls ───────────────────────────────────────────────────── */
    let videoTrack = null;
    const MODE_LABELS = { continuous: 'Auto', locked: 'Lock', manual: 'Manual' };

    async function applyFocusMode(mode) {
        if (!videoTrack) return;
        try {
            await videoTrack.applyConstraints({ advanced: [{ focusMode: mode }] });
            focusDistRow.style.display = mode === 'manual' ? 'flex' : 'none';
        } catch (e) { console.warn('focusMode constraint failed:', e); }
    }

    async function applyFocusDistance(value) {
        if (!videoTrack) return;
        try {
            await videoTrack.applyConstraints({
                advanced: [{ focusMode: 'manual', focusDistance: value }],
            });
        } catch (e) { console.warn('focusDistance constraint failed:', e); }
    }

    function setupFocusControls(caps) {
        const supportedModes = caps.focusMode || [];
        const wantedOrder = ['continuous', 'locked', 'manual'];
        const available = wantedOrder.filter(m => supportedModes.includes(m));
        if (available.length < 2) return;

        available.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = MODE_LABELS[m];
            focusModeSelect.appendChild(opt);
        });

        if (available.includes('manual') && caps.focusDistance) {
            const fd = caps.focusDistance;
            focusRange.min  = fd.min;
            focusRange.max  = fd.max;
            focusRange.step = fd.step || (fd.max - fd.min) / 100;
            const savedDist = parseFloat(localStorage.getItem('focusDistance'));
            const initDist  = (savedDist >= fd.min && savedDist <= fd.max) ? savedDist : fd.max;
            focusRange.value     = initDist;
            focusVal.textContent = initDist.toFixed(2) + ' m';
            focusRange.addEventListener('input', () => {
                const v = parseFloat(focusRange.value);
                focusVal.textContent = v.toFixed(2) + ' m';
                localStorage.setItem('focusDistance', v);
                if (focusModeSelect.value !== 'manual') {
                    focusModeSelect.value = 'manual';
                    localStorage.setItem('focusMode', 'manual');
                    focusDistRow.style.display = 'flex';
                }
                applyFocusDistance(v);
            });
        } else if (available.includes('manual')) {
            const manualOpt = focusModeSelect.querySelector('[value="manual"]');
            if (manualOpt) manualOpt.remove();
        }

        focusModeSelect.addEventListener('change', () => {
            const mode = focusModeSelect.value;
            localStorage.setItem('focusMode', mode);
            applyFocusMode(mode);
        });

        const saved = localStorage.getItem('focusMode');
        if (saved && available.includes(saved)) {
            focusModeSelect.value = saved;
            applyFocusMode(saved);
            if (saved === 'manual' && caps.focusDistance) {
                const fd   = caps.focusDistance;
                const dist = parseFloat(localStorage.getItem('focusDistance'));
                if (dist >= fd.min && dist <= fd.max) applyFocusDistance(dist);
            }
        }

        focusControls.style.display = 'flex';
    }

    /* ── Camera ───────────────────────────────────────────────────────────── */
    async function getCameraPermissionState() {
        if (!navigator.permissions) return 'unknown';
        try {
            const s = await navigator.permissions.query({ name: 'camera' });
            return s.state;
        } catch (e) { return 'unknown'; }
    }

    async function startCamera() {
        const permState = await getCameraPermissionState();
        if (permState === 'denied') {
            message.textContent = 'Camera blocked. Open browser Settings → Privacy → Camera and allow this site.';
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
            });
            if (permState === 'prompt') {
                permTip.textContent =
                    'Tip: click the camera icon in the address bar and choose "Always allow" to skip this prompt next time.';
                permTip.style.display = 'block';
                setTimeout(() => { permTip.style.display = 'none'; }, 10000);
            }
            video.srcObject = stream;
            videoTrack = stream.getVideoTracks()[0];
            const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
            setupFocusControls(caps);
            video.addEventListener('loadedmetadata', () => {
                canvas.width  = video.videoWidth;
                canvas.height = video.videoHeight;
                resizeOverlay();
                requestAnimationFrame(scanFrame);
            });
        } catch (err) {
            if (err.name === 'NotAllowedError') {
                message.textContent = 'Camera access denied. Click the camera icon in the address bar to allow it.';
            } else {
                message.textContent = 'Camera error: ' + err.message;
            }
        }
    }

    /* ── Boot ─────────────────────────────────────────────────────────────── */
    new ResizeObserver(resizeOverlay).observe(video);
    window.addEventListener('resize', resizeOverlay);

    startCamera();
    initWorker().then(() => {
        if (message.textContent === 'Initializing…') {
            message.textContent = 'Align passport within the guide';
        }
    }).catch(e => {
        console.error('Worker init failed:', e);
        message.textContent = 'OCR init error: ' + e.message;
    });
})();
