// scripts/update-xzone-token.js
// Holt den aktuellen XZONE Bearer-Token aus dem Browser-Traffic
// und schreibt ihn per Webhook in dein Apps-Script (XZONE_TOKEN).

const { chromium } = require('playwright');

const {
  XZONE_EMAIL,
  XZONE_PASSWORD,
  XZONE_BOARD_URL,       // z.B. https://exportarts.zone/boards/...
  WEBHOOK_URL,           // Apps-Script Webhook URL (Actions-env)
  TOKEN_UPDATE_SECRET,   // Secret für Apps Script (Actions-env)
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
assertEnv('WEBHOOK_URL');

const webhookUrl = WEBHOOK_URL;
const webhookSecret = TOKEN_UPDATE_SECRET || 'abc123';

// --- Helper: Token an Apps Script Webhook senden -------------------------

async function sendTokenToWebhook(token) {
  console.log('[INFO] Sende Token an Apps-Script-Webhook ...');

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
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

      if (!authHeader || !authHeader.startsWith('Bearer ')) return;

      const token = authHeader.slice('Bearer '.length).trim();
      if (!token || tokenFound) return;

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
    waitUntil: 'domcontentloaded',
    timeout: 120_000
  });
  await page.waitForLoadState('networkidle', { timeout: 120_000 });
  console.log('[INFO] URL nach goto():', page.url());

  // Auth0 leitet ggf. weiter, also kurz warten und aktuelle URL loggen
  await page.waitForTimeout(3000);
  console.log('[INFO] URL nach Redirect (falls vorhanden):', page.url());

  // Robuste Selektoren basierend auf deinem HTML-Snippet
  const emailSelector =
    '#username, input[name="username"], input[inputmode="email"], input[type="email"]';
  const passwordSelector =
    '#password, input[name="password"][type="password"], input[type="password"]';

  console.log('[INFO] Warte auf E-Mail-Feld ...');
  await page.waitForSelector(emailSelector, { timeout: 60_000 });

  console.log('[INFO] Fülle Credentials ...');
  await page.fill(emailSelector, XZONE_EMAIL);
  await page.fill(passwordSelector, XZONE_PASSWORD);

  // Submit-Button (laut HTML: button[type="submit"][name="action"][value="default"])
  const submitSelector =
    'button[type="submit"][name="action"][value="default"], button[type="submit"]';

  console.log('[INFO] Sende Login ab ...');
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 120_000 }),
    page.click(submitSelector)
  ]);

  console.log('[INFO] Login ausgeführt, aktuelle URL:', page.url());

  // Optional direkt auf ein bestimmtes Board springen
  if (XZONE_BOARD_URL) {
    console.log('[INFO] Navigiere zu Board:', XZONE_BOARD_URL);
    await page.goto(XZONE_BOARD_URL, {
      waitUntil: 'networkidle',
      timeout: 120_000
    });
    console.log('[INFO] Board-URL geladen:', page.url());
  }

  console.log('[INFO] Warte auf API-Requests (max. 30 Sekunden) ...');
  await page.waitForTimeout(30_000);

  if (!tokenFound) {
    console.error('[ERROR] Kein Token gefunden. Mögliche Ursachen:');
    console.error('- Das Board/Dashboard hat keine /social-media/-Requests ausgelöst.');
    console.error('- Login-Formular-Selektoren haben sich geändert.');
    console.error('- App lädt langsamer als 30 Sekunden (Timeout anpassen).');
    await browser.close();
    process.exit(1);
  }
}

// --- Start ----------------------------------------------------------------

run().catch((err) => {
  console.error('[FATAL] Unbehandelter Fehler:', err);
  process.exit(1);
});
