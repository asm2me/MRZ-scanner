(function () {
    /* ── DOM ──────────────────────────────────────────────────────────────── */
    const video          = document.getElementById('video');
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
        ovCtx.fillText('Align MRZ strip with the blue band below', W / 2, py - 8);
    }

    function resizeOverlay() {
        overlay.width  = video.offsetWidth  || 320;
        overlay.height = video.offsetHeight || 240;
        drawOverlay();
    }

    /* ── Adaptive threshold ────────────────────────────────────────────────── */
    // Converts the canvas to a B&W image using a local-mean threshold.
    // Eliminates lighting gradients and background clutter so Tesseract's
    // internal skew-correction (PSM=3 projection profile) works reliably.
    function adaptiveThreshold(canvas) {
        const W = canvas.width, H = canvas.height;
        const c2d = canvas.getContext('2d');
        const id = c2d.getImageData(0, 0, W, H);
        const d = id.data;

        // Grayscale
        const g = new Uint8Array(W * H);
        for (let i = 0; i < g.length; i++) {
            const j = i * 4;
            g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
        }

        // Integral image for O(1) local-mean lookup
        const W1 = W + 1;
        const ii = new Int32Array(W1 * (H + 1));
        for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++)
                ii[(y + 1) * W1 + (x + 1)] = g[y * W + x]
                    + ii[y * W1 + (x + 1)] + ii[(y + 1) * W1 + x] - ii[y * W1 + x];

        // Local threshold: pixel is "dark" if it is C levels below the local mean
        const half = 20, C = 12;  // wider window + stronger bias for camera images
        for (let y = 0; y < H; y++) {
            const y1 = Math.max(0, y - half), y2 = Math.min(H, y + half + 1);
            for (let x = 0; x < W; x++) {
                const x1 = Math.max(0, x - half), x2 = Math.min(W, x + half + 1);
                const area = (y2 - y1) * (x2 - x1);
                const s = ii[y2 * W1 + x2] - ii[y1 * W1 + x2]
                        - ii[y2 * W1 + x1] + ii[y1 * W1 + x1];
                const px = g[y * W + x] < (s / area) - C ? 0 : 255;
                const j = (y * W + x) * 4;
                d[j] = d[j + 1] = d[j + 2] = px; d[j + 3] = 255;
            }
        }
        c2d.putImageData(id, 0, 0);
    }

    /* ── Skew detection ────────────────────────────────────────────────────── */
    // Estimates the clockwise tilt of text rows in a B&W canvas.
    // Projection-profile approach: for each candidate angle, project dark pixels
    // onto the y-axis after a CCW rotation of that angle and measure row-sum
    // variance. The angle with maximum variance is the CW text-tilt angle.
    // Operates on a 4× downsampled copy for speed (~30 ms at 1080 p).
    function estimateSkew(bwCanvas) {
        const W = bwCanvas.width, H = bwCanvas.height;
        const d = bwCanvas.getContext('2d').getImageData(0, 0, W, H).data;

        const step = 4;
        const sw = Math.ceil(W / step), sh = Math.ceil(H / step);
        const g = new Uint8Array(sw * sh);
        for (let y = 0; y < sh; y++)
            for (let x = 0; x < sw; x++)
                g[y * sw + x] = d[((y * step) * W + x * step) * 4] < 128 ? 1 : 0;

        const cx = sw / 2, cy = sh / 2;
        const projLen = sw + sh;   // large enough for ±20° rotation
        let bestAngle = 0, bestVar = -1;

        for (let deg = -20; deg <= 20; deg += 1) {
            const rad = deg * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const proj = new Int32Array(projLen);
            for (let y = 0; y < sh; y++)
                for (let x = 0; x < sw; x++)
                    if (g[y * sw + x]) {
                        // CCW rotation by deg corrects CW tilt:
                        // new_y = -(x-cx)*sin + (y-cy)*cos + cy
                        const ry = Math.round(-(x - cx) * sin + (y - cy) * cos + cy);
                        if (ry >= 0 && ry < projLen) proj[ry]++;
                    }
            // Variance of projection = sharpness (max when text rows are horizontal)
            let sum = 0, sum2 = 0;
            for (let i = 0; i < sh; i++) { sum += proj[i]; sum2 += proj[i] * proj[i]; }
            const v = sum2 - (sum * sum) / sh;
            if (v > bestVar) { bestVar = v; bestAngle = deg; }
        }
        return bestAngle;
    }

    /* ── Canvas rotation ────────────────────────────────────────────────────── */
    // Rotates src CCW by cwAngle degrees, filling the expanded canvas with white.
    function rotateCanvas(src, cwAngle) {
        if (Math.abs(cwAngle) < 0.5) return src;
        const rad = cwAngle * Math.PI / 180;
        const W = src.width, H = src.height;
        const acos = Math.abs(Math.cos(rad)), asin = Math.abs(Math.sin(rad));
        const nW = Math.round(W * acos + H * asin);
        const nH = Math.round(W * asin + H * acos);
        const dst = document.createElement('canvas');
        dst.width = nW; dst.height = nH;
        const c = dst.getContext('2d');
        c.fillStyle = '#fff';
        c.fillRect(0, 0, nW, nH);
        c.translate(nW / 2, nH / 2);
        c.rotate(-rad);   // negative = CCW in canvas (corrects CW tilt)
        c.drawImage(src, -W / 2, -H / 2);
        return dst;
    }

    /* ── MRZ-region capture ────────────────────────────────────────────────── */
    // Crops to the MRZ band, 2× upscales, adaptive-thresholds, detects + corrects
    // skew via projection profile, then returns the clean B&W canvas for OCR.
    // 2× (not 3×) keeps pixel count low → fast PSM=6 OCR.
    function captureFrame() {
        const vW = video.videoWidth, vH = video.videoHeight;
        if (!vW || !vH) return null;

        // Guide-relative MRZ bounds in video-pixel space
        const gX = P.xFrac * vW;
        const gY = P.yFrac * vH;
        const gW = P.wFrac * vW;
        const gH = P.hFrac * vH;

        const mrzH = gH * P.mrzFrac;
        const padV = mrzH * 0.8;   // 80 % extra height above MRZ baseline for tilt tolerance
        const padH = gW * 0.03;    // 3 % extra width each side

        const cx = Math.max(0, Math.floor(gX - padH));
        const cy = Math.max(0, Math.floor(gY + gH - mrzH - padV));
        const cw = Math.min(vW - cx, Math.ceil(gW + padH * 2));
        const ch = Math.min(vH - cy, Math.ceil(mrzH + padV + mrzH * 0.1));

        // 2× upscale — sufficient glyph size, ~40 % fewer pixels than 3× → faster
        const scale = 2;
        const dst = document.createElement('canvas');
        dst.width  = Math.round(cw * scale);
        dst.height = Math.round(ch * scale);
        const dCtx = dst.getContext('2d');
        dCtx.imageSmoothingEnabled = true;
        dCtx.imageSmoothingQuality = 'high';
        dCtx.drawImage(video, cx, cy, cw, ch, 0, 0, dst.width, dst.height);

        adaptiveThreshold(dst);

        // Our own skew correction — more reliable than PSM=3 on a 2-line strip
        const skew = estimateSkew(dst);
        const corrected = rotateCanvas(dst, skew);

        // Debug preview capped at 640 px wide
        const ps = Math.min(1, 640 / corrected.width);
        ocrPreview.width  = Math.round(corrected.width  * ps);
        ocrPreview.height = Math.round(corrected.height * ps);
        ocrPreview.getContext('2d').drawImage(corrected, 0, 0, ocrPreview.width, ocrPreview.height);
        return corrected;
    }

    /* ── Tesseract worker ─────────────────────────────────────────────────── */
    let worker = null;

    async function initWorker() {
        // Use locally-hosted vendor files to avoid CDN CORB issues.
        // corePath must be an absolute URL so it resolves correctly from a blob worker.
        const base = new URL('.', window.location.href).href.replace(/\/$/, '');
        worker = await Tesseract.createWorker('eng', 1, {
            workerPath: base + '/vendor/worker.min.js',
            corePath:   base + '/vendor/core',
            langPath:   'https://tessdata.projectnaptha.com/4.0.0/',
            logger: m => {
                if (m.status === 'loading tesseract core')
                    message.textContent = 'Loading OCR engine…';
                if (m.status === 'loading language traineddata')
                    message.textContent = 'Loading OCR model…';
            },
        });
        await worker.setParameters({
            tessedit_pageseg_mode: '6',   // single uniform text block — faster; skew handled by rotateCanvas
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
            documentCode: 'Doc type', issuingState: 'Issuer', lastName: 'Surname',
            firstName: 'Given names', documentNumber: 'Doc number',
            nationality: 'Nationality', birthDate: 'Birth date',
            sex: 'Sex', expirationDate: 'Expiry', personalNumber: 'Personal no.',
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

        const strip = captureFrame();
        if (!strip) return null;
        const { data: { text } } = await worker.recognize(strip);

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
            const doBeep = () => {
                const o = ac.createOscillator();
                o.frequency.value = 1000;
                o.connect(ac.destination);
                o.start();
                o.stop(ac.currentTime + 0.2);
            };
            if (ac.state === 'suspended') ac.resume().then(doBeep).catch(() => {});
            else doBeep();
        } catch (e) {}
    }

    /* ── Scan loop ────────────────────────────────────────────────────────── */
    let lastScan = 0, busy = false;

    async function scanFrame() {
        const now = Date.now();
        if (!busy && now - lastScan > 500) {
            lastScan = now;
            busy = true;
            if (worker) message.textContent = 'Scanning…';
            try {
                const parsed = await recognizeMRZ();
                if (parsed && parsed.valid) {
                    message.textContent = 'MRZ detected — redirecting…';
                    playBeep();
                    sessionStorage.setItem('mrzData', JSON.stringify(parsed.fields));
                    setTimeout(() => { window.location.href = 'result.html'; }, 350);
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
                video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
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
