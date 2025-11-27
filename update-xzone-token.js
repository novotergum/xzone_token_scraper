// update-xzone-token.js
// Holt den aktuellen XZONE Bearer-Token aus dem Browser-Traffic
// und schreibt ihn per Webhook in dein Apps-Script (XZONE_TOKEN).

const { chromium } = require('playwright');

const {
  XZONE_EMAIL,
  XZONE_PASSWORD,
  XZONE_WEBHOOK_URL,
  XZONE_WEBHOOK_SECRET,  // optional, z.B. "abc123"
  XZONE_BOARD_URL,       // optional: konkrete Board-URL
  HEADLESS               // optional: "false" für sichtbaren Browser lokal
} = process.env;

// --- Basic Checks ---------------------------------------------------------

function assertEnv(name) {
  if (!process.env[name]) {
    console.error(`[ERROR] Umgebungsvariable ${name} fehlt.`);
    process.exit(1);
  }
}

assertEnv('XZONE_EMAIL');
assertEnv('XZONE_PASSWORD');
assertEnv('XZONE_WEBHOOK_URL');

const webhookUrl = XZONE_WEBHOOK_URL;
const webhookSecret = XZONE_WEBHOOK_SECRET || 'abc123';

// --- Helper: Token an Apps Script Webhook senden -------------------------

async function sendTokenToWebhook(token) {
  console.log('[INFO] Sende Token an Apps-Script-Webhook ...');

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      token,
      secret: webhookSecret
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `[ERROR] Webhook-Request fehlgeschlagen: ${res.status} ${res.statusText} – Body: ${text}`
    );
  }

  const json = await res.json().catch(() => null);
  console.log('[INFO] Webhook-Antwort:', json || '<kein JSON>');
}

// --- Hauptlogik ----------------------------------------------------------

async function run() {
  console.log('[INFO] Starte Chromium ...');
  const browser = await chromium.launch({
    headless: HEADLESS === 'false' ? false : true
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  let tokenFound = null;

  // Request-Listener: schnappt sich den Authorization-Header der XZONE-API
  page.on('request', async (request) => {
    try {
      const url = request.url();

      // Nur Requests zur XZONE-API ansehen
      if (!url.startsWith('https://exportarts-zone.nw.r.appspot.com/v1/boards/')) {
        return;
      }

      const headers = request.headers();
      const authHeader = headers['authorization'] || headers['Authorization'];

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return;
      }

      const token = authHeader.slice('Bearer '.length).trim();
      if (!token || tokenFound) {
        return;
      }

      tokenFound = token;
      console.log('[INFO] Bearer-Token im Request gefunden (gekürzt):', token.substring(0, 20) + '...');

      await sendTokenToWebhook(token);

      console.log('[INFO] Token erfolgreich aktualisiert. Browser wird geschlossen.');
      await browser.close();
      process.exit(0);
    } catch (err) {
      console.error('[ERROR] Fehler im Request-Handler:', err);
    }
  });

  // --- Login-Sequenz auf Auth0-Form --------------------------------------

  console.log('[INFO] Öffne Login-Seite ...');
  await page.goto('https://exportarts.zone/login', {
    waitUntil: 'networkidle',
    timeout: 120_000
  });

  // 1. Formular-Elemente finden (basierend auf deinem HTML)
  console.log('[INFO] Warte auf Login-Formular ...');
  await page.waitForSelector('input#username', { timeout: 60_000 });

  console.log('[INFO] Fülle Credentials ...');
  await page.fill('input#username', XZONE_EMAIL);
  await page.fill('input#password', XZONE_PASSWORD);

  // 2. Login abschicken und auf Redirect warten
  console.log('[INFO] Sende Login ab ...');
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 120_000 }),
    page.click('button[type="submit"][name="action"][value="default"]')
  ]);

  console.log('[INFO] Login ausgeführt, warte auf Dashboard ...');

  // Optional: explizit ein bestimmtes Board öffnen
  if (XZONE_BOARD_URL) {
    console.log('[INFO] Navigiere zu Board:', XZONE_BOARD_URL);
    await page.goto(XZONE_BOARD_URL, {
      waitUntil: 'networkidle',
      timeout: 120_000
    });
  }

  // Warte, bis die App ihre API Calls feuert
  console.log('[INFO] Warte auf API-Requests (max. 30 Sekunden) ...');
  await page.waitForTimeout(30_000);

  if (!tokenFound) {
    console.error('[ERROR] Kein Token gefunden. Mögliche Ursachen:');
    console.error('- Board lädt keine /social-media/ Requests (anderes Dashboard geöffnet?)');
    console.error('- URL der Login-Seite oder Selektoren haben sich geändert');
    console.error('- HEADLESS true und App lädt langsamer als 30 Sekunden');
    await browser.close();
    process.exit(1);
  }
}

// --- Start ----------------------------------------------------------------

run().catch((err) => {
  console.error('[FATAL] Unbehandelter Fehler:', err);
  process.exit(1);
});
