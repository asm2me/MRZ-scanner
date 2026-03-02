(function () {
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

    // ── Passport layout (fractions of displayed/video dimensions) ───────────
    // TD-3 passport: 125 mm × 88 mm → aspect ratio 125/88
    const P = {
        xFrac : 0.04,
        wFrac : 0.92,
        get hFrac() { return this.wFrac * (88 / 125); },
        get yFrac()  { return 0.5 - this.hFrac / 2; },
        // MRZ zone — 27 % of passport height gives a comfortable buffer
        mrzFrac: 0.27,
    };

    // ── Overlay drawing ─────────────────────────────────────────────────────
    function drawOverlay() {
        const W = overlay.width;
        const H = overlay.height;
        if (!W || !H) return;

        const px   = P.xFrac  * W;
        const py   = P.yFrac  * H;
        const pw   = P.wFrac  * W;
        const ph   = P.hFrac  * H;
        const mrzH = P.mrzFrac * ph;
        const mrzY = py + ph - mrzH;

        ovCtx.clearRect(0, 0, W, H);

        // Dark vignette outside the passport cutout
        ovCtx.fillStyle = 'rgba(0,0,0,0.55)';
        ovCtx.beginPath();
        ovCtx.rect(0, 0, W, H);
        ovCtx.rect(px, py, pw, ph);  // counter-clockwise hole
        ovCtx.fill('evenodd');

        // MRZ highlight band
        ovCtx.fillStyle = 'rgba(0,180,255,0.18)';
        ovCtx.fillRect(px, mrzY, pw, mrzH);

        // Dashed separator above MRZ
        ovCtx.save();
        ovCtx.setLineDash([6, 4]);
        ovCtx.strokeStyle = 'rgba(0,180,255,0.75)';
        ovCtx.lineWidth = 1.5;
        ovCtx.beginPath();
        ovCtx.moveTo(px, mrzY);
        ovCtx.lineTo(px + pw, mrzY);
        ovCtx.stroke();
        ovCtx.restore();

        // Passport border
        ovCtx.strokeStyle = 'rgba(255,255,255,0.7)';
        ovCtx.lineWidth = 1.5;
        ovCtx.strokeRect(px, py, pw, ph);

        // Corner brackets
        const bLen = Math.min(pw, ph) * 0.075;
        ovCtx.strokeStyle = '#00b4ff';
        ovCtx.lineWidth = 3;
        ovCtx.lineCap = 'square';
        [[px,      py,      1,  1],
         [px + pw, py,     -1,  1],
         [px,      py + ph, 1, -1],
         [px + pw, py + ph,-1, -1]].forEach(([cx, cy, dx, dy]) => {
            ovCtx.beginPath();
            ovCtx.moveTo(cx + dx * bLen, cy);
            ovCtx.lineTo(cx, cy);
            ovCtx.lineTo(cx, cy + dy * bLen);
            ovCtx.stroke();
        });

        // "MRZ" label centred in the MRZ band
        const fs = Math.max(11, pw * 0.028);
        ovCtx.font = `bold ${fs}px monospace`;
        ovCtx.textAlign = 'center';
        ovCtx.textBaseline = 'middle';
        ovCtx.fillStyle = 'rgba(0,180,255,0.9)';
        ovCtx.fillText('MRZ', px + pw / 2, mrzY + mrzH / 2);

        // Instruction above passport frame
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

    // ── OCR crop: full camera frame so the document can be placed anywhere ───
    function cropFrame() {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const W = canvas.width, H = canvas.height;
        return { imgData: ctx.getImageData(0, 0, W, H), w: W, h: H };
    }

    // ── Image preprocessing: Otsu binarization + 4× upscale ────────────────
    // Otsu's method finds the optimal threshold that maximises between-class
    // variance → gives crisp black text / white background for Tesseract.
    function otsuBinarize(dCtx, w, h) {
        const id   = dCtx.getImageData(0, 0, w, h);
        const d    = id.data;
        const n    = w * h;
        const gray = new Uint8Array(n);
        const hist = new Int32Array(256);

        for (let i = 0; i < n; i++) {
            const j = i * 4;
            gray[i] = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) | 0;
            hist[gray[i]]++;
        }

        let sum = 0;
        for (let i = 0; i < 256; i++) sum += i * hist[i];

        let wB = 0, sumB = 0, maxVar = 0, thresh = 128;
        for (let t = 0; t < 256; t++) {
            wB += hist[t];
            if (!wB) continue;
            const wF = n - wB;
            if (!wF) break;
            sumB += t * hist[t];
            const mB = sumB / wB;
            const mF = (sum - sumB) / wF;
            const v  = wB * wF * (mB - mF) ** 2;
            if (v > maxVar) { maxVar = v; thresh = t; }
        }

        // Dark text (≤ threshold) → black; light background → white
        let blackCount = 0;
        for (let i = 0; i < n; i++) {
            const val = gray[i] <= thresh ? 0 : 255;
            const j   = i * 4;
            d[j] = d[j + 1] = d[j + 2] = val;
            d[j + 3] = 255;
            if (val === 0) blackCount++;
        }
        // If the majority is black the passport has a dark background —
        // Tesseract needs black text on white, so invert.
        if (blackCount > n * 0.5) {
            for (let i = 0; i < n; i++) {
                const j = i * 4;
                d[j] = d[j + 1] = d[j + 2] = d[j] === 0 ? 255 : 0;
            }
        }
        dCtx.putImageData(id, 0, 0);
    }

    // ── Tilt detection (projection-profile, ±10° at 1° steps) ───────────────
    // Works on a small downscaled copy for speed, returns degrees to correct.
    function estimateTilt(binaryCanvas) {
        const W = binaryCanvas.width, H = binaryCanvas.height;
        const SW = Math.min(W, 200), SH = Math.round(H * SW / W);

        const tmp  = document.createElement('canvas');
        tmp.width  = SW; tmp.height = SH;
        const tc   = tmp.getContext('2d');
        tc.imageSmoothingEnabled = false;
        tc.drawImage(binaryCanvas, 0, 0, SW, SH);

        const d   = tc.getImageData(0, 0, SW, SH).data;
        const bin = new Uint8Array(SW * SH);
        let darkCount = 0;
        for (let i = 0; i < SW * SH; i++) {
            bin[i] = d[i * 4] < 128 ? 1 : 0;
            darkCount += bin[i];
        }
        if (darkCount < SW * SH * 0.01) return 0; // not enough ink to judge

        const cx = SW / 2, cy = SH / 2;
        let bestAngle = 0, bestScore = -Infinity;
        const profileLen = SH * 3;

        for (let a = -10; a <= 10; a++) {
            const rad = a * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const profile = new Float32Array(profileLen);

            for (let y = 0; y < SH; y++) {
                for (let x = 0; x < SW; x++) {
                    if (bin[y * SW + x]) {
                        const ry = Math.round((y - cy) * cos - (x - cx) * sin + cy) + SH;
                        if (ry >= 0 && ry < profileLen) profile[ry]++;
                    }
                }
            }

            let mean = 0;
            for (const v of profile) mean += v;
            mean /= profileLen;
            let score = 0;
            for (const v of profile) score += (v - mean) ** 2;

            if (score > bestScore) { bestScore = score; bestAngle = a; }
        }
        return bestAngle;
    }

    // Rotate canvas by angleDeg to level the text lines.
    function deskew(srcCanvas, angleDeg) {
        if (Math.abs(angleDeg) < 1) return srcCanvas;
        const w = srcCanvas.width, h = srcCanvas.height;
        const dst = document.createElement('canvas');
        dst.width = w; dst.height = h;
        const dc  = dst.getContext('2d');
        dc.fillStyle = 'white';
        dc.fillRect(0, 0, w, h);
        dc.save();
        dc.translate(w / 2, h / 2);
        dc.rotate(-angleDeg * Math.PI / 180);
        dc.drawImage(srcCanvas, -w / 2, -h / 2);
        dc.restore();
        return dst;
    }

    function toDataURL({ imgData, w, h }) {
        const src = document.createElement('canvas');
        src.width = w; src.height = h;
        src.getContext('2d').putImageData(imgData, 0, 0);

        // 1.5× upscale — the full frame is already large; a modest boost helps
        // Tesseract without making the image unwieldy.
        // Bilinear + 1 px blur before binarization smooths sensor noise
        // so Otsu finds a clean text/background boundary.
        const scale = 1.5;
        const dst   = document.createElement('canvas');
        dst.width   = w * scale;
        dst.height  = h * scale;
        const dCtx  = dst.getContext('2d');
        dCtx.imageSmoothingEnabled = true;
        dCtx.imageSmoothingQuality = 'high';
        dCtx.filter = 'blur(1px)';
        dCtx.drawImage(src, 0, 0, dst.width, dst.height);
        dCtx.filter = 'none';

        otsuBinarize(dCtx, dst.width, dst.height);

        // Detect tilt and straighten before OCR
        const tilt      = estimateTilt(dst);
        const corrected = deskew(dst, tilt);

        // Mirror result to the debug preview canvas
        ocrPreview.width  = corrected.width;
        ocrPreview.height = corrected.height;
        ocrPreview.getContext('2d').drawImage(corrected, 0, 0);

        return corrected.toDataURL('image/png');
    }

    // ── Tesseract worker (persistent, initialised once) ──────────────────────
    let worker = null;

    async function initWorker() {
        worker = await Tesseract.createWorker('eng');
        await worker.setParameters({
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
            // PSM 11 = sparse text — finds text anywhere in the full frame
            tessedit_pageseg_mode: '11',
        });
    }

    // ── Line cleaning: replace common OCR artefacts of '<' rather than delete─
    function cleanLine(raw) {
        return raw
            .toUpperCase()
            // Chars that Tesseract commonly returns instead of '<'
            .replace(/[\s\-_«»(){}\[\]|\\\/.,;:'"]/g, '<')
            .replace(/[^A-Z0-9<]/g, '');  // remove anything else
    }

    // ── Debug: show parsed fields table ─────────────────────────────────────
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

    // ── MRZ recognition ──────────────────────────────────────────────────────
    async function recognizeMRZ() {
        if (!worker) return null;

        const crop    = cropFrame();
        const dataUrl = toDataURL(crop);
        const { data: { text } } = await worker.recognize(dataUrl);

        ocrText.textContent = text || '(empty)';
        console.log('[MRZ OCR raw]', JSON.stringify(text));

        const lines = text
            .split(/[\r\n]+/)
            .map(cleanLine)
            .filter(l => l.length >= 20);

        if (ocrLines) ocrLines.textContent = lines.length
            ? lines.join('\n')
            : '(no candidate lines found)';

        let bestResult = null;

        for (let i = 0; i < lines.length; i++) {
            // TD-3 passport: 2 lines × 44 chars
            if (i + 1 < lines.length) {
                const g2 = [lines[i].slice(0, 44), lines[i + 1].slice(0, 44)];
                if (g2[0].length >= 35 && g2[1].length >= 35) {
                    try {
                        const r = MRZ.parse(g2);
                        if (r) { if (!bestResult) bestResult = r; if (r.valid) { bestResult = r; break; } }
                    } catch (e) {}
                }
            }
            // TD-1 ID card: 3 lines × 30 chars
            if (i + 2 < lines.length) {
                const g3 = [lines[i].slice(0, 30), lines[i + 1].slice(0, 30), lines[i + 2].slice(0, 30)];
                if (g3[0].length >= 24) {
                    try {
                        const r = MRZ.parse(g3);
                        if (r) { if (!bestResult) bestResult = r; if (r.valid) { bestResult = r; break; } }
                    } catch (e) {}
                }
            }
        }

        showDebugFields(bestResult);
        return (bestResult && bestResult.valid) ? bestResult : null;
    }

    // ── Beep on successful scan ──────────────────────────────────────────────
    // A single shared AudioContext avoids the autoplay-policy issue: once the
    // user interacts with the page it is resumed and stays alive.
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

    // ── Scan loop ────────────────────────────────────────────────────────────
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
                        ? 'No valid MRZ found — point camera at the passport'
                        : 'Initializing OCR engine…';
                }
            } catch (e) {
                console.error(e);
                message.textContent = 'No valid MRZ found — point camera at the passport';
            }
            busy = false;
        }
        requestAnimationFrame(scanFrame);
    }

    // ── Focus controls ───────────────────────────────────────────────────────
    let videoTrack = null;

    const MODE_LABELS = { continuous: 'Auto', locked: 'Lock', manual: 'Manual' };

    async function applyFocusMode(mode) {
        if (!videoTrack) return;
        try {
            await videoTrack.applyConstraints({ advanced: [{ focusMode: mode }] });
            focusDistRow.style.display = mode === 'manual' ? 'flex' : 'none';
        } catch (e) {
            console.warn('focusMode constraint failed:', e);
        }
    }

    async function applyFocusDistance(value) {
        if (!videoTrack) return;
        try {
            await videoTrack.applyConstraints({
                advanced: [{ focusMode: 'manual', focusDistance: value }],
            });
        } catch (e) {
            console.warn('focusDistance constraint failed:', e);
        }
    }

    function setupFocusControls(caps) {
        // Build mode options from what the camera actually supports
        const supportedModes = caps.focusMode || [];
        const wantedOrder = ['continuous', 'locked', 'manual'];
        const available = wantedOrder.filter(m => supportedModes.includes(m));
        if (available.length < 2) return; // nothing useful to show

        available.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = MODE_LABELS[m];
            focusModeSelect.appendChild(opt);
        });

        // Distance slider — only if camera exposes focusDistance range
        if (available.includes('manual') && caps.focusDistance) {
            const fd = caps.focusDistance;
            focusRange.min  = fd.min;
            focusRange.max  = fd.max;
            focusRange.step = fd.step || (fd.max - fd.min) / 100;

            // Restore saved distance or default to infinity (fd.max)
            const savedDist = parseFloat(localStorage.getItem('focusDistance'));
            const initDist  = (savedDist >= fd.min && savedDist <= fd.max) ? savedDist : fd.max;
            focusRange.value        = initDist;
            focusVal.textContent    = initDist.toFixed(2) + ' m';

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
            // manual mode supported but no distance range — remove the option
            const manualOpt = focusModeSelect.querySelector('[value="manual"]');
            if (manualOpt) manualOpt.remove();
        }

        focusModeSelect.addEventListener('change', () => {
            const mode = focusModeSelect.value;
            localStorage.setItem('focusMode', mode);
            applyFocusMode(mode);
        });

        // Restore last-used focus mode (and distance when manual)
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

    // ── Camera permission + start ────────────────────────────────────────────
    async function getCameraPermissionState() {
        if (!navigator.permissions) return 'unknown';
        try {
            const s = await navigator.permissions.query({ name: 'camera' });
            return s.state; // 'granted' | 'prompt' | 'denied'
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

            // Show a one-time tip the first time the user is prompted
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

    // ── Boot ─────────────────────────────────────────────────────────────────
    new ResizeObserver(resizeOverlay).observe(video);
    window.addEventListener('resize', resizeOverlay);

    // Start camera and OCR init in parallel
    startCamera();
    initWorker().then(() => {
        if (message.textContent === 'Initializing…') {
            message.textContent = 'Align passport within the guide';
        }
    });
})();
