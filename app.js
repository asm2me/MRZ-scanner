(function(){
    const video = document.getElementById('video');
    const canvas = document.getElementById('canvas');
    const message = document.getElementById('message');
    const ctx = canvas.getContext('2d');

    async function startCamera() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
            video.srcObject = stream;
            video.addEventListener('loadedmetadata', () => {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                requestAnimationFrame(scanFrame);
            });
        } catch (err) {
            message.textContent = 'Error accessing camera: ' + err.message;
        }
    }

    async function recognizeMRZ() {
        // capture current frame
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/png');
        // run OCR on full frame, later we'll try to find MRZ lines
        const { data: { text } } = await Tesseract.recognize(dataUrl, 'eng', {
            logger: m => {
                // optionally show progress
            }
        });
        // clean up text: MRZ uses only A-Z0-9< and two or three lines
        const candidate = text.replace(/[\r]/g, '\n');
        const lines = candidate.split(/\n+/).map(l => l.trim()).filter(l => l.length > 0);
        // Try to find contiguous lines of length 44 or 36 etc.
        for (let i = 0; i < lines.length; i++) {
            // check for three-line passports (44 chars per line)
            if (lines[i].length >= 40) {
                const segment = lines.slice(i, i + 3).map(l => l.replace(/[^A-Z0-9<]/g, ''));
                if (segment.length === 3) {
                    try {
                        const parsed = MRZ.parse(segment);
                        if (parsed && parsed.valid) {
                            return parsed;
                        }
                    } catch (e) {
                        // ignore parsing errors
                    }
                }
            }
        }
        return null;
    }

    let lastScan = 0;
    async function scanFrame() {
        const now = Date.now();
        if (now - lastScan > 1000) {
            lastScan = now;
            try {
                const parsed = await recognizeMRZ();
                if (parsed && parsed.valid) {
                    message.textContent = 'MRZ detected, redirecting...';
                    const data = parsed.fields;
                    const params = new URLSearchParams();
                    for (const key in data) {
                        params.set(key, data[key]);
                    }
                    window.location.href = 'result.html?' + params.toString();
                    return;
                }
            } catch (e) {
                console.error(e);
            }
        }
        requestAnimationFrame(scanFrame);
    }

    startCamera();
})();