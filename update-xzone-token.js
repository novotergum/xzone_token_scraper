// update-xzone-token.js
// npm install playwright

const { chromium } = require('playwright');

// TODO: am besten per Umgebungsvariablen setzen
const XZONE_EMAIL    = process.env.XZONE_EMAIL    || 'DEINE_MAIL@DOMAIN.DE';
const XZONE_PASSWORD = process.env.XZONE_PASSWORD || 'DEIN_PASSWORT';

// X-Zone Board-URL, die die /social-media-Calls triggert
const XZONE_BOARD_URL = 'https://exportarts.zone/boards/989474f7-cae7-47b3-9f9d-885fc074788f';

// Dein Apps Script Webhook
const WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbwmulD2cSh4E_4IOXYfOoHW2QiOM4kwi4jij67xa-AZKjeSNUrt7k_UyjS2g5166gd3/exec';

// Muss zu TOKEN_UPDATE_SECRET in den Script Properties passen
const TOKEN_UPDATE_SECRET = 'abc123';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let capturedToken = null;

  // 1) Listener: fängt den Authorization-Header ab
  page.on('request', (request) => {
    const url = request.url();
    // Hier ggf. noch feiner filtern (reach, reachBy, views etc.)
    if (url.includes('/social-media/')) {
      const headers = request.headers();
      const auth = headers['authorization'] || headers['Authorization'];
      if (auth && auth.startsWith('Bearer ')) {
        capturedToken = auth.substring('Bearer '.length);
        console.log('[INFO] Bearer-Token abgefangen, Länge:', capturedToken.length);
      }
    }
  });

  try {
    // 2) Login in X-Zone
    console.log('[INFO] Öffne Login-Seite...');
    await page.goto('https://exportarts.zone/login', { waitUntil: 'networkidle' });

    // TODO: Diese Selektoren an das echte Login-Formular anpassen
    await page.fill('input[type="email"]', XZONE_EMAIL);
    await page.fill('input[type="password"]', XZONE_PASSWORD);
    await page.click('button[type="submit"]');

    // Auf Redirect / Dashboard warten
    await page.waitForLoadState('networkidle');

    // 3) Board aufrufen, damit die Social-Media-API-Calls abgeschickt werden
    console.log('[INFO] Öffne Board:', XZONE_BOARD_URL);
    await page.goto(XZONE_BOARD_URL, { waitUntil: 'networkidle' });

    // 4) Kurz warten, bis erste /social-media-Anfragen kommen
    for (let i = 0; i < 15 && !capturedToken; i++) {
      await page.waitForTimeout(1000);
    }

    if (!capturedToken) {
      throw new Error('Kein Bearer-Token gefunden. Selektoren/URL prüfen.');
    }

    // 5) Token per fetch aus dem Browser an den Apps-Script-Webhook schicken
    console.log('[INFO] Schicke Token an Webhook...');

    const result = await page.evaluate(
      async (webhookUrl, token, secret) => {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, secret })
        });
        const text = await res.text();
        return { status: res.status, body: text };
      },
      WEBHOOK_URL,
      capturedToken,
      TOKEN_UPDATE_SECRET
    );

    console.log('[INFO] Webhook-Response-Status:', result.status);
    console.log('[INFO] Webhook-Response-Body:', result.body);

  } catch (err) {
    console.error('[ERROR]', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
