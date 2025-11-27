// scripts/update-xzone-token.js
// npm install playwright

const { chromium } = require('playwright');

async function main() {
  const XZONE_EMAIL    = process.env.XZONE_EMAIL;
  const XZONE_PASSWORD = process.env.XZONE_PASSWORD;
  const XZONE_BOARD_URL = process.env.XZONE_BOARD_URL;
  const WEBHOOK_URL = process.env.WEBHOOK_URL;
  const TOKEN_UPDATE_SECRET = process.env.TOKEN_UPDATE_SECRET || 'abc123';

  if (!XZONE_EMAIL || !XZONE_PASSWORD || !XZONE_BOARD_URL || !WEBHOOK_URL) {
    throw new Error(
      'Fehlende ENV Variablen. Benötigt: XZONE_EMAIL, XZONE_PASSWORD, XZONE_BOARD_URL, WEBHOOK_URL'
    );
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let capturedToken = null;

  // 1) Listener: fängt den Authorization-Header ab, sobald /social-media/... aufgerufen wird
  page.on('request', (request) => {
    const url = request.url();
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
    console.log('[INFO] Öffne Login-Seite...');
    await page.goto('https://exportarts.zone/login', {
      waitUntil: 'networkidle',
      timeout: 120_000
    });

    // TODO: Falls Login-Feld-Selektoren abweichen, hier anpassen
    await page.fill('input[type="email"]', XZONE_EMAIL);
    await page.fill('input[type="password"]', XZONE_PASSWORD);
    await page.click('button[type="submit"]');

    // Auf Redirect / Dashboard warten
    await page.waitForLoadState('networkidle', { timeout: 120_000 });

    console.log('[INFO] Öffne Board:', XZONE_BOARD_URL);
    await page.goto(XZONE_BOARD_URL, {
      waitUntil: 'networkidle',
      timeout: 120_000
    });

    // 2) Warten, bis mindestens ein /social-media/ Request gelaufen ist und Token abgegriffen wurde
    for (let i = 0; i < 20 && !capturedToken; i++) {
      await page.waitForTimeout(1000);
    }

    if (!capturedToken) {
      throw new Error('Kein Bearer-Token gefunden. Prüfe Board-URL, Login und Selektoren.');
    }

    console.log('[INFO] Schicke Token an Webhook...');

    // 3) Token direkt aus dem Browser-Kontext an Apps Script Webhook senden
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

    if (result.status < 200 || result.status >= 300) {
      throw new Error('Webhook-Fehler: ' + result.body);
    }

    console.log('[SUCCESS] XZONE_TOKEN wurde via Webhook aktualisiert.');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
