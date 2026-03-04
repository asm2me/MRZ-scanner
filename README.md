# MRZ-PASSPORT

This simple web application uses the webcam to scan the Machine Readable Zone (MRZ) of a passport or ID document. When a valid MRZ is detected, it navigates to a result page and fills in the form fields with the extracted data.

## How it works

1. **index.html** opens the camera and starts capturing frames.
2. **Tesseract.js** performs OCR on the bottom portion of each frame and/or the built-in `mrz` image parser.
3. The **mrz** library parses the MRZ text and ensures all checksums are valid (`result.valid === true`).
4. When a full, checksum‑correct MRZ is read a short beep (like a barcode reader) is played and the app navigates to **result.html** with the extracted data.
5. **result.html** reads the query parameters and populates a form with the passport information.

## Running locally

**⚠️ You must serve the files over HTTP — do not open `index.html` directly from the filesystem.**
Browsers block WASM loading inside web workers when the page is loaded via `file://`, which breaks the OCR engine.

Pick any option:

**Option 1 — Node.js (npx, no install needed)**
```powershell
npx serve .
# then visit http://localhost:3000
```

**Option 2 — Node.js http-server**
```powershell
npx http-server . -p 8000
# then visit http://localhost:8000
```

**Option 3 — Python (if available)**
```powershell
python -m http.server 8000
# then visit http://localhost:8000
```

**Option 4 — VS Code**
Install the [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) extension, right-click `index.html` → "Open with Live Server".

Allow camera access when prompted; the page will start scanning automatically.

⚠️ For best results, hold the passport MRZ area clear and well-lit. Scanning may take a few seconds.

## Files

- `index.html` – main scanner UI and script inclusion
- `app.js` – camera handling, OCR, MRZ parsing, and redirection logic
- `result.html` – display page with populated fields

Feel free to extend, style, or embed this logic into your own application.
