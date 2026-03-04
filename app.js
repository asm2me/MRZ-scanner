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

    /* ── Overlay ──────────────────────────────────────────────────────────── */
    function drawOverlay() {
        const W = overlay.width, H = overlay.height;
        if (!W || !H) return;
        ovCtx.clearRect(0, 0, W, H);

        // corner brackets — indicate scanning the whole view
        const m = 14, bLen = Math.min(W, H) * 0.07;
        ovCtx.strokeStyle = '#00b4ff';
        ovCtx.lineWidth   = 3;
        ovCtx.lineCap     = 'square';
        [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]]
            .forEach(([cx, cy, dx, dy]) => {
                ovCtx.beginPath();
                ovCtx.moveTo(cx + dx * bLen, cy);
                ovCtx.lineTo(cx, cy);
                ovCtx.lineTo(cx, cy + dy * bLen);
                ovCtx.stroke();
            });

        // instruction
        ovCtx.font         = `${Math.max(11, W * 0.022)}px sans-serif`;
        ovCtx.textAlign    = 'center';
        ovCtx.textBaseline = 'bottom';
        ovCtx.fillStyle    = 'rgba(255,255,255,0.85)';
        ovCtx.fillText('Point camera at passport MRZ — scanning whole view', W / 2, H - m);
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

    /* ── MRZ-rectangle locator (gradient-energy, skew-tolerant) ─────────── */
    // Uses squared horizontal Sobel gradient + box blur to build an "edge
    // energy" map.  MRZ text has uniquely high density of vertical strokes
    // spanning the full page width — this lights up as a bright band in the
    // energy map regardless of lighting or binarisation threshold.
    // Skew estimation is done only on the detected region for the polygon.
    // Returns {x1,y1,x2,y2, corners, skewAngle} or null.
    function findMRZRect() {
        const vW = video.videoWidth, vH = video.videoHeight;
        const tScale = Math.min(1, 480 / vW);
        const tW = Math.round(vW * tScale), tH = Math.round(vH * tScale);

        const tc = document.createElement('canvas');
        tc.width = tW; tc.height = tH;
        const tCtx = tc.getContext('2d');
        tCtx.drawImage(video, 0, 0, tW, tH);
        const d = tCtx.getImageData(0, 0, tW, tH).data;

        // Grayscale
        const gray = new Float32Array(tW * tH);
        for (let i = 0; i < gray.length; i++) {
            const j = i * 4;
            gray[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
        }

        // ── 1. Squared horizontal Sobel gradient ──
        // Highlights vertical edges (character strokes). Squaring emphasises
        // strong edges and makes everything positive.
        const gx2 = new Float32Array(tW * tH);
        for (let y = 0; y < tH; y++) {
            const off = y * tW;
            for (let x = 1; x < tW - 1; x++) {
                const g = gray[off + x + 1] - gray[off + x - 1];
                gx2[off + x] = g * g;
            }
        }

        // ── 2. Horizontal box blur (merge character strokes into bands) ──
        const hR = Math.max(5, Math.round(tW * 0.04));
        const hBlur = new Float32Array(tW * tH);
        const hPfx = new Float64Array(tW + 1);
        for (let y = 0; y < tH; y++) {
            const off = y * tW;
            hPfx[0] = 0;
            for (let x = 0; x < tW; x++) hPfx[x + 1] = hPfx[x] + gx2[off + x];
            for (let x = 0; x < tW; x++) {
                const l = Math.max(0, x - hR), r = Math.min(tW - 1, x + hR);
                hBlur[off + x] = (hPfx[r + 1] - hPfx[l]) / (r - l + 1);
            }
        }

        // ── 3. Vertical box blur (merge the 2–3 MRZ text lines) ──
        const vR = Math.max(2, Math.round(tH * 0.025));
        const energy = new Float32Array(tW * tH);
        const vPfx = new Float64Array(tH + 1);
        for (let x = 0; x < tW; x++) {
            vPfx[0] = 0;
            for (let y = 0; y < tH; y++) vPfx[y + 1] = vPfx[y] + hBlur[y * tW + x];
            for (let y = 0; y < tH; y++) {
                const t = Math.max(0, y - vR), b = Math.min(tH - 1, y + vR);
                energy[y * tW + x] = (vPfx[b + 1] - vPfx[t]) / (b - t + 1);
            }
        }

        // ── 4. Row scoring: mean energy × spread ──
        const rowMean = new Float32Array(tH);
        let globalMax = 0;
        for (let y = 0; y < tH; y++) {
            let s = 0;
            for (let x = 0; x < tW; x++) s += energy[y * tW + x];
            rowMean[y] = s / tW;
            if (rowMean[y] > globalMax) globalMax = rowMean[y];
        }
        if (globalMax === 0) return null;

        // Spread: fraction of columns above 25 % of global max energy.
        // MRZ rows have high energy spanning nearly the full width.
        const spreadTh = globalMax * 0.25;
        const rowScore = new Float32Array(tH);
        for (let y = 0; y < tH; y++) {
            let above = 0;
            for (let x = 0; x < tW; x++) if (energy[y * tW + x] > spreadTh) above++;
            rowScore[y] = (rowMean[y] / globalMax) * (above / tW);
        }

        // Smooth
        const smooth = new Float32Array(tH);
        for (let y = 0; y < tH; y++) {
            let s = 0, n = 0;
            for (let dy = -4; dy <= 4; dy++) {
                const yy = y + dy;
                if (yy >= 0 && yy < tH) { s += rowScore[yy]; n++; }
            }
            smooth[y] = s / n;
        }

        // ── 5. Find best band in bottom 60 % ──
        const searchY = Math.floor(tH * 0.40);
        const maxBandH = Math.round(tH * 0.25);

        let maxSmooth = 0;
        for (let y = searchY; y < tH; y++)
            if (smooth[y] > maxSmooth) maxSmooth = smooth[y];
        if (maxSmooth === 0) return null;

        const bandTh = maxSmooth * 0.30;
        let bestY1 = -1, bestY2 = -1, bestScore = 0;
        let runY1 = -1, runScore = 0;

        for (let y = searchY; y <= tH; y++) {
            if (y < tH && smooth[y] >= bandTh) {
                if (runY1 < 0) { runY1 = y; runScore = 0; }
                runScore += smooth[y];
            } else if (runY1 >= 0) {
                const bh = y - runY1;
                if (runScore > bestScore && bh <= maxBandH && bh >= 3) {
                    bestScore = runScore;
                    bestY1 = runY1;
                    bestY2 = y - 1;
                }
                runY1 = -1;
            }
        }

        if (bestY1 < 0) return null;

        // ── 6. X-bounds (columns within band above 10 % of max energy) ──
        const bandH = bestY2 - bestY1 + 1;
        const colE = new Float32Array(tW);
        for (let x = 0; x < tW; x++) {
            let s = 0;
            for (let y = bestY1; y <= bestY2; y++) s += energy[y * tW + x];
            colE[x] = s / bandH;
        }
        const colTh = globalMax * 0.10;
        let tx1 = 0, tx2 = tW - 1;
        for (let x = 0; x < tW; x++)       if (colE[x] >= colTh) { tx1 = x; break; }
        for (let x = tW - 1; x >= 0; x--)  if (colE[x] >= colTh) { tx2 = x; break; }

        const regionW = tx2 - tx1 + 1;
        if (regionW < 10 || bandH < 3) return null;

        // ── 7. Skew estimation on detected region for polygon ──
        // Binarise just the detected region using local mean threshold
        let graySum = 0;
        for (let y = bestY1; y <= bestY2; y++)
            for (let x = tx1; x <= tx2; x++)
                graySum += gray[y * tW + x];
        const regionMean = graySum / (regionW * bandH);

        const regionBin = new Uint8Array(regionW * bandH);
        for (let ry = 0; ry < bandH; ry++)
            for (let rx = 0; rx < regionW; rx++)
                regionBin[ry * regionW + rx] =
                    gray[(bestY1 + ry) * tW + (tx1 + rx)] < regionMean - 10 ? 1 : 0;

        // Projection-profile skew estimation on the region
        const step = Math.max(1, Math.round(regionW / 120));
        const sw = Math.ceil(regionW / step), sh = Math.ceil(bandH / step);
        const sg = new Uint8Array(sw * sh);
        for (let sy = 0; sy < sh; sy++)
            for (let sx = 0; sx < sw; sx++)
                sg[sy * sw + sx] = regionBin[(sy * step) * regionW + sx * step];

        const pcx = sw / 2, pcy = sh / 2, pLen = sw + sh;
        let bestAngle = 0, bestVar = -1;
        for (let deg = -15; deg <= 15; deg += 1) {
            const rad = deg * Math.PI / 180;
            const cosA = Math.cos(rad), sinA = Math.sin(rad);
            const proj = new Int32Array(pLen);
            for (let py = 0; py < sh; py++)
                for (let px = 0; px < sw; px++)
                    if (sg[py * sw + px]) {
                        const ry = Math.round(-(px - pcx) * sinA + (py - pcy) * cosA + pcy);
                        if (ry >= 0 && ry < pLen) proj[ry]++;
                    }
            let sum = 0, sum2 = 0;
            for (let i = 0; i < sh; i++) { sum += proj[i]; sum2 += proj[i] * proj[i]; }
            const v = sum2 - (sum * sum) / sh;
            if (v > bestVar) { bestVar = v; bestAngle = deg; }
        }
        const skewAngle = bestAngle;

        // ── 8. Build rotated polygon corners ──
        const invScale = 1 / tScale;
        const cx = (tx1 + tx2) / 2, cy = (bestY1 + bestY2) / 2;
        const hw = regionW / 2, hh = bandH / 2;
        const rad = skewAngle * Math.PI / 180;
        const cosR = Math.cos(rad), sinR = Math.sin(rad);

        // Rectangle corners rotated by skewAngle around the region centre
        const localCorners = [
            { x: -hw, y: -hh }, { x: hw, y: -hh },
            { x: hw, y: hh },  { x: -hw, y: hh },
        ];

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const videoCorners = localCorners.map(p => {
            // CW rotation: x' = x*cos - y*sin,  y' = x*sin + y*cos
            const rx = (p.x * cosR - p.y * sinR + cx) * invScale;
            const ry = (p.x * sinR + p.y * cosR + cy) * invScale;
            if (rx < minX) minX = rx;
            if (rx > maxX) maxX = rx;
            if (ry < minY) minY = ry;
            if (ry > maxY) maxY = ry;
            return { x: Math.round(rx), y: Math.round(ry) };
        });

        return {
            x1: Math.max(0, Math.round(minX)),
            y1: Math.max(0, Math.round(minY)),
            x2: Math.min(vW - 1, Math.round(maxX)),
            y2: Math.min(vH - 1, Math.round(maxY)),
            corners: videoCorners,
            skewAngle,
        };
    }

    /* ── Draw MRZ region on overlay ───────────────────────────────────────── */
    function drawMRZRect(rect) {
        const vW = video.videoWidth, vH = video.videoHeight;
        if (!vW || !vH) return;
        const sx = overlay.width / vW, sy = overlay.height / vH;

        if (rect.corners && rect.corners.length === 4) {
            ovCtx.beginPath();
            ovCtx.moveTo(rect.corners[0].x * sx, rect.corners[0].y * sy);
            for (let i = 1; i < 4; i++)
                ovCtx.lineTo(rect.corners[i].x * sx, rect.corners[i].y * sy);
            ovCtx.closePath();
            ovCtx.strokeStyle = '#00ff88';
            ovCtx.lineWidth   = 2;
            ovCtx.lineJoin    = 'round';
            ovCtx.stroke();
            ovCtx.fillStyle = 'rgba(0, 255, 136, 0.08)';
            ovCtx.fill();
        } else {
            const rx = rect.x1 * sx, ry = rect.y1 * sy;
            const rw = (rect.x2 - rect.x1) * sx, rh = (rect.y2 - rect.y1) * sy;
            ovCtx.strokeStyle = '#00ff88';
            ovCtx.lineWidth   = 2;
            ovCtx.lineJoin    = 'round';
            ovCtx.strokeRect(rx, ry, rw, rh);
            ovCtx.fillStyle = 'rgba(0, 255, 136, 0.08)';
            ovCtx.fillRect(rx, ry, rw, rh);
        }
    }

    /* ── MRZ-region capture ────────────────────────────────────────────────── */
    // Detects the MRZ rectangle, marks it on the overlay, then crops, upscales,
    // adaptive-thresholds, and skew-corrects the region before handing to Tesseract.
    function captureFrame() {
        const vW = video.videoWidth, vH = video.videoHeight;
        if (!vW || !vH) return null;

        // Detect the MRZ rectangle (x + y bounds)
        const rect = findMRZRect();
        lastMRZRect = rect;

        // Redraw overlay brackets, then mark the detected rectangle
        drawOverlay();
        if (rect) drawMRZRect(rect);

        let vx1, vy1, vx2, vy2;
        if (rect) {
            const bw = rect.x2 - rect.x1 + 1, bh = rect.y2 - rect.y1 + 1;
            const padX = Math.round(bw * 0.05);
            const padY = Math.round(bh * 0.1);
            vx1 = Math.max(0, rect.x1 - padX);
            vy1 = Math.max(0, rect.y1 - padY);
            vx2 = Math.min(vW - 1, rect.x2 + padX);
            vy2 = Math.min(vH - 1, rect.y2 + padY);
        } else {
            vx1 = 0;
            vy1 = Math.floor(vH * 0.6);   // fallback: bottom 40 %
            vx2 = vW - 1;
            vy2 = vH - 1;
        }

        // Upscale crop — capped at 2048 px wide to limit memory
        const cropW = vx2 - vx1 + 1, cropH = vy2 - vy1 + 1;
        const scale = Math.min(2, 2048 / cropW);
        const dst = document.createElement('canvas');
        dst.width  = Math.round(cropW * scale);
        dst.height = Math.round(cropH * scale);
        const dCtx = dst.getContext('2d');
        dCtx.imageSmoothingEnabled = true;
        dCtx.imageSmoothingQuality = 'high';
        dCtx.drawImage(video, vx1, vy1, cropW, cropH, 0, 0, dst.width, dst.height);

        adaptiveThreshold(dst);
        const skew = estimateSkew(dst);
        const corrected = rotateCanvas(dst, skew);

        // Debug preview capped at 1280 px wide
        const ps = Math.min(1, 1280 / corrected.width);
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
            tessedit_pageseg_mode:    '6',  // single uniform text block; skew handled by rotateCanvas
            tessedit_char_whitelist:  'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',  // MRZ chars only → faster
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

    /* ── Color photo capture & enhancement ────────────────────────────────── */
    function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

    // Unsharp-mask sharpening via a 3×3 Laplacian blend
    function sharpenCanvas(canvas, ctx) {
        const W = canvas.width, H = canvas.height;
        const src = ctx.getImageData(0, 0, W, H);
        const dst = new ImageData(W, H);
        const s = src.data, d = dst.data;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                if (y === 0 || y === H - 1 || x === 0 || x === W - 1) {
                    d[i] = s[i]; d[i+1] = s[i+1]; d[i+2] = s[i+2]; d[i+3] = 255;
                    continue;
                }
                for (let c = 0; c < 3; c++) {
                    const v = 5 * s[i + c]
                        - s[i - W * 4 + c] - s[i + W * 4 + c]
                        - s[i - 4 + c]     - s[i + 4 + c];
                    d[i + c] = clamp255(v);
                }
                d[i + 3] = 255;
            }
        }
        ctx.putImageData(dst, 0, 0);
    }

    // Contrast + brightness boost, then sharpen
    function enhanceColor(canvas, ctx) {
        const W = canvas.width, H = canvas.height;
        const id = ctx.getImageData(0, 0, W, H);
        const d = id.data;
        const contrast = 1.18, brightness = 10;
        for (let i = 0; i < d.length; i += 4) {
            d[i]   = clamp255((d[i]   - 128) * contrast + 128 + brightness);
            d[i+1] = clamp255((d[i+1] - 128) * contrast + 128 + brightness);
            d[i+2] = clamp255((d[i+2] - 128) * contrast + 128 + brightness);
        }
        ctx.putImageData(id, 0, 0);
        sharpenCanvas(canvas, ctx);
    }

    // Grabs the current full-color video frame, scales it down, enhances it,
    // draws the detected MRZ rectangle on top, and returns a base64 JPEG string.
    function captureColorPhoto(mrzRect) {
        const vW = video.videoWidth, vH = video.videoHeight;
        if (!vW || !vH) return null;
        const scale = Math.min(1, 800 / vW);
        const cW = Math.round(vW * scale), cH = Math.round(vH * scale);
        const canvas = document.createElement('canvas');
        canvas.width = cW; canvas.height = cH;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(video, 0, 0, cW, cH);
        enhanceColor(canvas, ctx);

        // Draw MRZ region polygon on the captured photo
        if (mrzRect && mrzRect.corners && mrzRect.corners.length === 4) {
            ctx.beginPath();
            ctx.moveTo(mrzRect.corners[0].x * scale, mrzRect.corners[0].y * scale);
            for (let i = 1; i < 4; i++)
                ctx.lineTo(mrzRect.corners[i].x * scale, mrzRect.corners[i].y * scale);
            ctx.closePath();
            ctx.fillStyle = 'rgba(0, 255, 136, 0.15)';
            ctx.fill();
            ctx.strokeStyle = '#00ff88';
            ctx.lineWidth   = Math.max(2, cW * 0.004);
            ctx.lineJoin    = 'round';
            ctx.stroke();
            // "MRZ" label at top-left corner
            const fontSize = Math.max(10, cW * 0.018);
            ctx.font         = `bold ${fontSize}px sans-serif`;
            ctx.textBaseline = 'bottom';
            ctx.textAlign    = 'left';
            ctx.fillStyle    = '#00ff88';
            const topY = Math.min(...mrzRect.corners.map(c => c.y));
            const topX = mrzRect.corners.reduce((a, c) => c.y <= topY + 2 && c.x < a ? c.x : a, Infinity);
            ctx.fillText('MRZ', topX * scale + 4, topY * scale - 3);
        } else if (mrzRect) {
            const rx = mrzRect.x1 * scale, ry = mrzRect.y1 * scale;
            const rw = (mrzRect.x2 - mrzRect.x1) * scale;
            const rh = (mrzRect.y2 - mrzRect.y1) * scale;
            ctx.fillStyle = 'rgba(0, 255, 136, 0.15)';
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeStyle = '#00ff88';
            ctx.lineWidth   = Math.max(2, cW * 0.004);
            ctx.lineJoin    = 'round';
            ctx.strokeRect(rx, ry, rw, rh);
        }

        return canvas.toDataURL('image/jpeg', 0.88);
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
    let lastScan = 0, busy = false, lastMRZRect = null;

    async function scanFrame() {
        const now = Date.now();
        if (!busy && now - lastScan > 300) {
            lastScan = now;
            busy = true;
            if (worker) message.textContent = 'Scanning…';
            try {
                const parsed = await recognizeMRZ();
                if (parsed && parsed.valid) {
                    message.textContent = 'MRZ detected — redirecting…';
                    playBeep();
                    sessionStorage.setItem('mrzData', JSON.stringify({ fields: parsed.fields, valid: parsed.valid }));
                    const photo = captureColorPhoto(lastMRZRect);
                    if (photo) sessionStorage.setItem('personPhoto', photo);
                    setTimeout(() => { window.location.href = 'result.html'; }, 350);
                    return;
                } else {
                    message.textContent = worker
                        ? 'No valid MRZ found — hold passport steady in view'
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
                video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
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
