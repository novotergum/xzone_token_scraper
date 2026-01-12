/**
 * Update XZONE Bearer Token
 * - Loggt sich per Playwright bei exportarts.zone (Auth0) ein
 * - Fängt den access_token aus /oauth/token RESPONSE ab
 * - Sendet ihn per Webhook an Google Apps Script
 */

const { chromium } = require('playwright');

/* ------------------------------------------------------------------ */
/* ENV                                                                 */
/* ------------------------------------------------------------------ */

const {
  XZONE_EMAIL,
  XZONE_PASSWORD,
  XZONE_BOARD_URL,
  WEBHOOK_URL,
  TOKEN_UPDATE_SECRET,
  HEADLESS
} = process.env;

function assertEnv(name) {
  if (!process.env[name]) {
    console.error(`[FATAL] Umgebungsvariable ${name} fehlt`);
    process.exit(1);
  }
}

assertEnv('XZONE_EMAIL');
assertEnv('XZONE_PASSWORD');
assertEnv('WEBHOOK_URL');
assertEnv('TOKEN_UPDATE_SECRET');

/* ------------------------------------------------------------------ */
/* WEBHOOK                                                             */
/* ------------------------------------------------------------------ */

async function sendTokenToWebhook(token) {
  console.log('[INFO] Sende Token an Apps-Script-Webhook …');

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      secret: TOKEN_UPDATE_SECRET
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Webhook fehlgeschlagen: ${res.status} ${res.statusText} – ${text}`
    );
  }

  console.log('[INFO] Webhook erfolgreich');
}

/* ------------------------------------------------------------------ */
/* TOKEN PROMISE                                                       */
/* ------------------------------------------------------------------ */

let tokenFound = null;
let tokenResolve;
let tokenReject;

const tokenPromise = new Promise((resolve, reject) => {
  tokenResolve = resolve;
  tokenReject = reject;
});

/* ------------------------------------------------------------------ */
/* MAIN                                                                */
/* ------------------------------------------------------------------ */

async function run() {
  console.log('[INFO] Starte Chromium …');

  const browser = await chromium.launch({
    headless: HEADLESS === 'false' ? false : true
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  /* -------------------------------------------------------------- */
  /* AUTH0 TOKEN RESPONSE LISTENER                                   */
  /* -------------------------------------------------------------- */

  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!url.includes('/oauth/token')) return;
      if (!response.ok()) return;
      if (tokenFound) return;

      const json = await response.json().catch(() => null);
      if (!json?.access_token) return;

      tokenFound = json.access_token;

      console.log(
        '[INFO] Auth0 access_token gefunden:',
        tokenFound.substring(0, 20) + '…'
      );

      // Promise SOFORT auflösen
      tokenResolve(tokenFound);

      // Webhook asynchron (kein Blocker)
      sendTokenToWebhook(tokenFound).catch(err =>
        console.error('[ERROR] Webhook:', err.message)
      );

    } catch (err) {
      console.error('[ERROR] Response-Handler:', err);
    }
  });

  /* -------------------------------------------------------------- */
  /* LOGIN FLOW                                                      */
  /* -------------------------------------------------------------- */

  console.log('[INFO] Öffne Login-Seite …');

  await page.goto('https://exportarts.zone/login', {
    waitUntil: 'domcontentloaded',
    timeout: 120_000
  });

  await page.waitForLoadState('networkidle', { timeout: 120_000 });

  const emailSelector =
    '#username, input[name="username"], input[type="email"]';
  const passwordSelector =
    '#password, input[name="password"][type="password"], input[type="password"]';

  await page.waitForSelector(emailSelector, { timeout: 60_000 });

  console.log('[INFO] Fülle Login-Daten …');

  await page.fill(emailSelector, XZONE_EMAIL);
  await page.fill(passwordSelector, XZONE_PASSWORD);

  const submitSelector =
    'button[type="submit"][name="action"][value="default"], button[type="submit"]';

  console.log('[INFO] Sende Login ab …');

  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 120_000 }),
    page.click(submitSelector)
  ]);

  console.log('[INFO] Login abgeschlossen:', page.url());

  /* -------------------------------------------------------------- */
  /* OPTIONAL: BOARD LADEN                                           */
  /* -------------------------------------------------------------- */

  if (XZONE_BOARD_URL) {
    console.log('[INFO] Lade Board:', XZONE_BOARD_URL);

    await page.goto(XZONE_BOARD_URL, {
      waitUntil: 'networkidle',
      timeout: 120_000
    });
  }

  /* -------------------------------------------------------------- */
  /* WAIT FOR TOKEN                                                  */
  /* -------------------------------------------------------------- */

  console.log('[INFO] Warte auf Auth0 Token (max. 30s) …');

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error('Timeout: Kein Token innerhalb von 30s')),
      30_000
    )
  );

  try {
    await Promise.race([tokenPromise, timeoutPromise]);
  } catch (err) {
    console.error('[FATAL]', err.message);
    await browser.close();
    process.exit(1);
  }

  console.log('[INFO] Token erfolgreich aktualisiert');
  await browser.close();
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* START                                                              */
/* ------------------------------------------------------------------ */

run().catch((err) => {
  console.error('[FATAL] Unbehandelter Fehler:', err);
  process.exit(1);
});
