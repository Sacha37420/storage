/**
 * Gestes de l'explorateur de fichiers — propre à `storage`, HORS catalogue.
 *
 * Ce fichier ne définit aucun test tant que E2E_GESTES n'est pas posé : le
 * runner du lab, qui parcourt tout le dossier e2e/ pour cataloguer et jouer
 * `cloisonnement.spec.ts`, ne le voit donc pas (décision du propriétaire du
 * 2026-10-11 : « un second fichier E2E propre à storage, lancé à la main,
 * hors catalogue »). Il se lance à la main, dans le conteneur `lab-runner` :
 *
 *   E2E_GESTES=1
 *   E2E_APP_URL        https://<domaine>/storage/
 *   E2E_USER           compte de test (son ESPACE PERSONNEL sert de bac à sable)
 *   E2E_PASSWORD
 *   E2E_GESTES_DIST    (facultatif) dossier d'un `ng build` : s'il est posé, les
 *                      fichiers statiques de l'app sont servis depuis ce dossier
 *                      au lieu du frontend déployé — pour éprouver une branche
 *                      contre le backend en service, sans la déployer.
 *   E2E_GESTES_SHOTS   (facultatif) dossier où déposer des captures d'écran des gestes.
 *
 * Tout ce que ces tests créent est préfixé `zz-` et supprimé à la fin, dans
 * l'espace personnel du compte de test uniquement.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ENABLED = !!process.env['E2E_GESTES'];
const APP_URL = process.env['E2E_APP_URL'] ?? '';
const USER = process.env['E2E_USER'] ?? '';
const PASSWORD = process.env['E2E_PASSWORD'] ?? '';
const DIST = process.env['E2E_GESTES_DIST'] ?? '';
const API = APP_URL.replace(/\/storage\/$/, '/storage-api') + '/api';
const SHOTS = process.env['E2E_GESTES_SHOTS'] ?? '';
const UNDO_MS = 7000;

const MIME: Record<string, string> = {
  '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.svg': 'image/svg+xml',
};

if (ENABLED) {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  let context: BrowserContext;
  let page: Page;
  let auth = '';

  /**
   * Sert le build local à la place du frontend déployé ; env.js reste celui du
   * service. Le retour de Keycloak est une redirection HTTP, que Playwright
   * n'intercepte pas : le document d'arrivée peut donc être l'index DÉPLOYÉ,
   * qui réclame SES fichiers (main-<hash>.js, styles-<hash>.css). On répond à
   * ces noms-là aussi par les fichiers du build local.
   */
  async function serveDist(ctx: BrowserContext): Promise<void> {
    if (!DIST) return;
    const index = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8').replace('<base href="/">', '<base href="/storage/">');
    const built = fs.readdirSync(DIST);
    const mainJs = built.find(f => /^main-.*\.js$/.test(f));
    const stylesCss = built.find(f => /^styles-.*\.css$/.test(f));
    if (!mainJs || !stylesCss) throw new Error(`Build incomplet dans ${DIST}`);
    await ctx.route(url => url.href.startsWith(APP_URL), route => {
      let rel = decodeURIComponent(new URL(route.request().url()).pathname.slice(new URL(APP_URL).pathname.length));
      if (rel === 'assets/env.js') return route.continue();
      if (/^main-.*\.js$/.test(rel)) rel = mainJs;
      else if (/^styles-.*\.css$/.test(rel)) rel = stylesCss;
      const file = path.join(DIST, rel);
      if (rel && !rel.includes('..') && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return route.fulfill({ body: fs.readFileSync(file), contentType: MIME[path.extname(file)] ?? 'application/octet-stream' });
      }
      return route.fulfill({ body: index, contentType: 'text/html' });
    });
  }

  const shot = async (name: string): Promise<void> => {
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  };

  type ApiResult = { status: number; json: any };
  /** Appel direct à l'API, depuis la page (même résolution DNS que le navigateur). */
  async function api(method: string, urlPath: string, upload?: { path: string; content: string }): Promise<ApiResult> {
    return page.evaluate(async ({ url, method, auth, upload }) => {
      let body: FormData | undefined;
      if (upload) {
        body = new FormData();
        body.append('relative_path', upload.path);
        body.append('file', new Blob([upload.content], { type: 'text/plain' }), upload.path.split('/').pop());
      }
      const r = await fetch(url, { method, headers: { Authorization: auth }, body });
      let json: unknown = null;
      try { json = await r.json(); } catch { /* pas de corps */ }
      return { status: r.status, json };
    }, { url: API + urlPath, method, auth, upload });
  }
  const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
  const listing = async (): Promise<{ relative_path: string; size: number }[]> => (await api('GET', `/files/${USER}/`)).json;
  const paths = async () => (await listing()).map(f => f.relative_path).filter(p => p.startsWith('zz-')).sort();
  const seed = (p: string, content: string) => api('POST', `/files/${USER}/`, { path: p, content });
  async function purge(): Promise<void> {
    for (const p of await paths()) await api('DELETE', `/files/${USER}/content/${enc(p)}`);
  }

  const row = (id: string) => page.locator(`.entry[data-id="${id}"]`);
  const selectedIds = () => page.$$eval('.entry[aria-selected="true"]', els => els.map(e => (e as HTMLElement).dataset['id']).sort());
  const visibleNames = () => page.$$eval('.entry .name', els => els.map(e => e.textContent?.trim()));
  const textSelected = () => page.evaluate(() => String(getSelection()).length);

  async function login(p: Page): Promise<void> {
    await p.goto(APP_URL);
    if (await p.locator('#username').isVisible().catch(() => false)) {
      await p.locator('#username').fill(USER);
      await p.locator('#password').fill(PASSWORD);
      await p.locator('#kc-login').click();
    }
    await p.waitForURL(u => u.href.startsWith(APP_URL), { timeout: 30_000 });
    await p.waitForSelector('.grid[aria-busy="false"]', { timeout: 30_000 });
  }

  async function reloadList(): Promise<void> {
    await page.goto(`${APP_URL}${USER}`);
    await page.reload();
    await page.waitForSelector('.grid[aria-busy="false"]');
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    if (!APP_URL || !USER || !PASSWORD) throw new Error('E2E_APP_URL, E2E_USER et E2E_PASSWORD sont requis.');
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    await serveDist(context);
    page = await context.newPage();
    page.on('request', r => { const a = r.headers()['authorization']; if (a && r.url().includes('/storage-api/')) auth = a; });
    await login(page);
    if (DIST) expect(await page.locator('app-toolbar').count(), 'le build local doit être celui qui tourne').toBe(1);
    await purge();
    await seed('zz-a.txt', 'a'.repeat(3));
    await seed('zz-b.txt', 'b'.repeat(30));
    await seed('zz-c.txt', 'c'.repeat(300));
    await seed('zz-d.txt', 'd'.repeat(4));
    await seed('zz-e.txt', 'e'.repeat(5));
    await seed('zz-dossier/x.txt', 'x');
    await seed('zz-dossier/sous/y.txt', 'yy');
    await reloadList();
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    try {
      await page.unroute('**/storage-api/**').catch(() => undefined);
      await page.goto(`${APP_URL}${USER}`);
      await page.waitForSelector('.grid[aria-busy="false"]');
      await page.waitForTimeout(UNDO_MS + 1500); // laisse partir une suppression encore en attente
      await purge();
      expect(await paths()).toEqual([]);
    } finally {
      await context.close();
    }
  });

  // ── Lot 1 ────────────────────────────────────────────────────────────────

  test('sélection : clic, Ctrl+clic, Maj+clic, sans surligner de texte', async () => {
    await row('f:zz-b.txt').click();
    expect(await selectedIds()).toEqual(['f:zz-b.txt']);
    await row('f:zz-d.txt').click({ modifiers: ['Control'] });
    expect(await selectedIds()).toEqual(['f:zz-b.txt', 'f:zz-d.txt']);
    await row('f:zz-b.txt').click({ modifiers: ['Control'] });
    expect(await selectedIds()).toEqual(['f:zz-d.txt']);
    await row('f:zz-a.txt').click();
    await row('f:zz-c.txt').click({ modifiers: ['Shift'] });
    expect(await selectedIds()).toEqual(['f:zz-a.txt', 'f:zz-b.txt', 'f:zz-c.txt']);
    // Second Maj+clic : la plage est remplacée, pas étendue.
    await row('f:zz-b.txt').click({ modifiers: ['Shift'] });
    expect(await selectedIds()).toEqual(['f:zz-a.txt', 'f:zz-b.txt']);
    expect(await textSelected()).toBe(0);
    await expect(page.locator('app-toolbar .count')).toHaveText('2 sélectionnés');
  });

  test('sélection : case à cocher, tout sélectionner, Échap, clic dans le vide', async () => {
    await page.keyboard.press('Escape');
    expect(await selectedIds()).toEqual([]);
    await row('f:zz-c.txt').locator('.check').click();
    await row('f:zz-e.txt').locator('.check').click();
    expect(await selectedIds()).toEqual(['f:zz-c.txt', 'f:zz-e.txt']);
    await page.locator('.head .check').click();
    expect((await selectedIds()).length).toBe(6);
    await page.keyboard.press('Escape');
    expect(await selectedIds()).toEqual([]);
    await page.keyboard.press('Control+a');
    expect((await selectedIds()).length).toBe(6);
    expect(await textSelected()).toBe(0);
    const grid = (await page.locator('.grid').boundingBox())!;
    await page.mouse.click(grid.x + grid.width / 2, grid.y + grid.height - 8);
    expect(await selectedIds()).toEqual([]);
  });

  test('sélection par rectangle glissé', async () => {
    const grid = (await page.locator('.grid').boundingBox())!;
    const b = (await row('f:zz-b.txt').boundingBox())!;
    const d = (await row('f:zz-d.txt').boundingBox())!;
    // Départ dans le vide sous la dernière ligne, arrivée au milieu de la ligne « b ».
    await page.mouse.move(grid.x + grid.width - 30, grid.y + grid.height - 10);
    await page.mouse.down();
    await page.mouse.move(grid.x + grid.width - 60, d.y + d.height / 2, { steps: 8 });
    await page.mouse.move(grid.x + 80, b.y + b.height / 2, { steps: 8 });
    await expect(page.locator('.lasso')).toBeVisible();
    await shot('rectangle');
    // Le rectangle est recalculé à l'image suivante : on attend qu'il ait rattrapé la souris.
    await expect.poll(selectedIds).toEqual(expect.arrayContaining(['f:zz-b.txt', 'f:zz-c.txt', 'f:zz-d.txt', 'f:zz-e.txt']));
    const during = await selectedIds();
    await page.mouse.up();
    expect(during).not.toContain('f:zz-a.txt');
    // La sélection tient après le relâchement (le clic qui suit ne la vide pas).
    expect(await selectedIds()).toEqual(during);
    expect(await textSelected()).toBe(0);
    // Avec Ctrl : le rectangle s'ajoute à la sélection existante.
    await row('f:zz-a.txt').click();
    await page.mouse.move(grid.x + grid.width - 30, grid.y + grid.height - 10);
    await page.keyboard.down('Control');
    await page.mouse.down();
    await page.mouse.move(grid.x + 80, d.y + d.height / 2, { steps: 8 });
    await expect.poll(selectedIds).toEqual(expect.arrayContaining(['f:zz-a.txt', 'f:zz-d.txt', 'f:zz-e.txt']));
    await page.mouse.up();
    await page.keyboard.up('Control');
    expect(await selectedIds()).toEqual(expect.arrayContaining(['f:zz-a.txt', 'f:zz-d.txt', 'f:zz-e.txt']));
    await page.keyboard.press('Escape');
  });

  test('clavier : tout est atteignable par Tab, puis flèches, Maj+flèche, Entrée, Retour arrière', async () => {
    await page.locator('.logo').first().focus();
    const stops: string[] = [];
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      stops.push(await page.evaluate(() => {
        const e = document.activeElement as HTMLElement | null;
        return e ? `${e.tagName.toLowerCase()}.${(e.className || '').toString().split(' ').filter(Boolean).join('.')}` : '';
      }));
      if (stops[stops.length - 1].includes('entry')) break;
    }
    const reached = (needle: string) => stops.some(s => s.includes(needle));
    expect(reached('a.space'), `espaces : ${stops.join(' ')}`).toBe(true);
    expect(reached('a.crumb')).toBe(true);
    expect(reached('button.act')).toBe(true);
    expect(reached('button.sort')).toBe(true);
    expect(reached('entry')).toBe(true);

    await page.keyboard.press('Home');
    expect(await selectedIds()).toEqual(['d:zz-dossier']);
    await page.keyboard.press('ArrowDown');
    expect(await selectedIds()).toEqual(['f:zz-a.txt']);
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    expect(await selectedIds()).toEqual(['f:zz-a.txt', 'f:zz-b.txt', 'f:zz-c.txt']);
    await page.keyboard.press('Shift+ArrowUp');
    expect(await selectedIds()).toEqual(['f:zz-a.txt', 'f:zz-b.txt']);
    await page.keyboard.press('Control+ArrowDown');
    await page.keyboard.press('Control+ArrowDown');
    await page.keyboard.press(' ');
    expect(await selectedIds()).toEqual(['f:zz-a.txt', 'f:zz-b.txt', 'f:zz-d.txt']);
    await page.keyboard.press('End');
    expect(await selectedIds()).toEqual(['f:zz-e.txt']);
    // Le focus suit le curseur.
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset['id'])).toBe('f:zz-e.txt');

    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/${USER}/zz-dossier$`));
    await expect(row('d:zz-dossier/sous')).toBeVisible();
    await page.keyboard.press('Backspace');
    await expect(page).toHaveURL(new RegExp(`/${USER}$`));
    await expect(row('f:zz-a.txt')).toBeVisible();
  });

  test('tri par colonne et filtre', async () => {
    const files = async () => (await visibleNames()).filter(n => n !== 'zz-dossier');
    await page.locator('.sort', { hasText: 'Taille' }).click();
    expect(await files()).toEqual(['zz-c.txt', 'zz-b.txt', 'zz-e.txt', 'zz-d.txt', 'zz-a.txt']);
    await expect(page.locator('.head .c-size')).toHaveAttribute('aria-sort', 'descending');
    await page.locator('.sort', { hasText: 'Taille' }).click();
    expect(await files()).toEqual(['zz-a.txt', 'zz-d.txt', 'zz-e.txt', 'zz-b.txt', 'zz-c.txt']);
    expect((await visibleNames())[0]).toBe('zz-dossier'); // dossiers toujours en tête
    await page.locator('.sort', { hasText: 'Nom' }).click();
    expect(await files()).toEqual(['zz-a.txt', 'zz-b.txt', 'zz-c.txt', 'zz-d.txt', 'zz-e.txt']);
    // Le dossier affiche la somme de son contenu (1 + 2 octets).
    await expect(row('d:zz-dossier').locator('.c-size')).toHaveText('3 o');

    await page.locator('.grid').click({ position: { x: 300, y: 5 } }).catch(() => undefined);
    await page.locator('body').press('/');
    expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).type)).toBe('search');
    await page.keyboard.type('ZZ-B');
    expect(await visibleNames()).toEqual(['zz-b.txt']);
    await page.keyboard.press('Escape');
    expect((await visibleNames()).length).toBe(6);
  });

  test('menu contextuel : clic droit sur un élément, dans le vide, et appui long', async () => {
    await row('f:zz-c.txt').click({ button: 'right' });
    await expect(page.locator('.menu')).toBeVisible();
    expect(await selectedIds()).toEqual(['f:zz-c.txt']);
    const items = await page.$$eval('.menu .menu-item .label', els => els.map(e => e.textContent));
    expect(items).toEqual(expect.arrayContaining(['Télécharger', 'Supprimer', 'Tout sélectionner', 'Désélectionner']));
    await expect(page.locator('.menu kbd', { hasText: 'Suppr' })).toBeVisible();
    await shot('menu-contextuel');
    await page.keyboard.press('Escape');
    await expect(page.locator('.menu')).toHaveCount(0);

    // Clic droit sur un élément d'une sélection multiple : la sélection est conservée.
    await row('f:zz-a.txt').click();
    await row('f:zz-b.txt').click({ modifiers: ['Control'] });
    await row('f:zz-b.txt').click({ button: 'right' });
    expect(await selectedIds()).toEqual(['f:zz-a.txt', 'f:zz-b.txt']);
    await page.keyboard.press('Escape');

    // Dans le vide : actions de création.
    const grid = (await page.locator('.grid').boundingBox())!;
    await page.mouse.click(grid.x + grid.width / 2, grid.y + grid.height - 8, { button: 'right' });
    const empty = await page.$$eval('.menu .menu-item .label', els => els.map(e => e.textContent));
    expect(empty).toEqual(expect.arrayContaining(['Téléverser des fichiers', 'Tout sélectionner']));
    expect(empty).not.toContain('Supprimer');
    await page.keyboard.press('Escape');

    // Appui long au doigt (pointeur tactile simulé, 600 ms).
    await page.evaluate(() => {
      const el = document.querySelector('.entry[data-id="f:zz-d.txt"]')!;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: r.x + 100, clientY: r.y + 20 }));
    });
    await page.waitForTimeout(650);
    await expect(page.locator('.menu')).toBeVisible();
    expect(await selectedIds()).toEqual(['f:zz-d.txt']);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  });

  test('menu contextuel : une action du menu s\'exécute (ouvrir un dossier)', async () => {
    await row('d:zz-dossier').click({ button: 'right' });
    await page.locator('.menu .menu-item', { hasText: 'Ouvrir' }).click();
    await expect(page).toHaveURL(new RegExp(`/${USER}/zz-dossier$`));
    await page.locator('.crumb').first().click();
    await expect(row('f:zz-a.txt')).toBeVisible();
  });

  test('double-clic : ouvre un dossier', async () => {
    await row('d:zz-dossier').dblclick();
    await expect(page).toHaveURL(new RegExp(`/${USER}/zz-dossier$`));
    await page.goBack();
    await expect(row('f:zz-a.txt')).toBeVisible();
  });

  test('téléchargement groupé depuis la barre d\'actions', async () => {
    await row('f:zz-a.txt').click();
    await row('f:zz-b.txt').click({ modifiers: ['Control'] });
    const names: string[] = [];
    const onDownload = (d: { suggestedFilename(): string }) => names.push(d.suggestedFilename());
    page.on('download', onDownload);
    await page.locator('app-toolbar [data-action="download"]').click();
    await expect.poll(() => names.sort(), { timeout: 15_000 }).toEqual(['zz-a.txt', 'zz-b.txt']);
    page.off('download', onDownload);
    await page.keyboard.press('Escape');
  });

  test('suppression groupée : rien ne part avant la fin du bandeau, « Annuler » restaure', async () => {
    await row('f:zz-a.txt').click();
    await row('f:zz-b.txt').click({ modifiers: ['Shift'] });
    await page.keyboard.press('Delete');
    await expect(page.locator('.undo')).toContainText('2 éléments supprimés');
    await shot('bandeau-annuler');
    await expect(row('f:zz-a.txt')).toHaveCount(0);
    await expect(row('f:zz-b.txt')).toHaveCount(0);
    // Côté serveur, les fichiers existent toujours.
    expect(await paths()).toEqual(expect.arrayContaining(['zz-a.txt', 'zz-b.txt']));
    await page.locator('.undo-btn').click();
    await expect(page.locator('.undo')).toHaveCount(0);
    await expect(row('f:zz-a.txt')).toBeVisible();
    await expect(row('f:zz-b.txt')).toBeVisible();
    await page.waitForTimeout(UNDO_MS + 1000);
    expect(await paths()).toEqual(expect.arrayContaining(['zz-a.txt', 'zz-b.txt']));
  });

  test('suppression définitive à l\'expiration du bandeau, dossier compris', async () => {
    await row('f:zz-e.txt').click();
    await row('d:zz-dossier').click({ modifiers: ['Control'] });
    await page.locator('app-toolbar [data-action="delete"]').click();
    await expect(page.locator('.undo')).toContainText('2 éléments supprimés (3 fichiers)');
    expect(await paths()).toContain('zz-e.txt');
    await expect(page.locator('.undo')).toHaveCount(0, { timeout: UNDO_MS + 3000 });
    await expect.poll(paths, { timeout: 10_000 }).toEqual(['zz-a.txt', 'zz-b.txt', 'zz-c.txt', 'zz-d.txt']);
    await expect(row('d:zz-dossier')).toHaveCount(0);
  });

  test('suppression : quitter la page pendant le bandeau VALIDE la suppression', async () => {
    const other = await context.newPage();
    await login(other);
    await other.locator('.entry[data-id="f:zz-d.txt"]').click();
    await other.keyboard.press('Delete');
    await expect(other.locator('.undo')).toBeVisible();
    expect(await paths()).toContain('zz-d.txt');
    // Navigation hors de l'app : `pagehide` part, la suppression en attente est envoyée (keepalive).
    await other.goto('about:blank');
    await expect.poll(paths, { timeout: 10_000 }).toEqual(['zz-a.txt', 'zz-b.txt', 'zz-c.txt']);

    // Fermeture de l'onglet : même mécanisme. Constat seulement (pas d'assertion) — selon la
    // façon dont l'outil de test détruit l'onglet, `pagehide` peut ne pas être émis.
    await login(other);
    await other.locator('.entry[data-id="f:zz-c.txt"]').click();
    await other.keyboard.press('Delete');
    await expect(other.locator('.undo')).toBeVisible();
    await other.close({ runBeforeUnload: true });
    await page.waitForTimeout(4000);
    const closed = !(await paths()).includes('zz-c.txt');
    console.log(`CONSTAT fermeture d'onglet pendant le bandeau : ${closed ? 'suppression validée' : 'suppression NON envoyée (le fichier est resté)'}`);
    await reloadList();
    await expect(row('f:zz-d.txt')).toHaveCount(0);
  });

  // ── Mesures ──────────────────────────────────────────────────────────────

  /** Éléments interactifs visibles dont la zone cliquable fait moins de 44 px dans un sens. */
  const smallTargets = () => page.evaluate(() => {
    const out: string[] = [];
    const seen = new Set<Element>();
    for (const el of document.querySelectorAll<HTMLElement>('button, a[href], label.check, .entry, label.filter, select, input:not([type=checkbox]):not([hidden])')) {
      // Une case à cocher est jugée par son <label> (44×44), une ligne par elle-même.
      if (seen.has(el) || el.closest('[hidden]')) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (el.matches('input') && el.closest('label.filter')) continue; // jugé par son conteneur
      if (r.height < 43.5 || r.width < 43.5) out.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().trim().replace(/\s+/g, '.')} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return out;
  });
  const overflow = () => page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);

  test('mesures à 1280 px : pas de débordement, cibles ≥ 44 px', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await reloadList();
    const [scrollW, innerW] = await overflow();
    expect(scrollW).toBeLessThanOrEqual(innerW);
    expect(await smallTargets()).toEqual([]);
    await row('f:zz-a.txt').click();
    await shot('bureau-1280');
    expect(await smallTargets()).toEqual([]);
    await page.keyboard.press('Escape');
    console.log(`MESURE 1280 : scrollWidth=${scrollW} innerWidth=${innerW}`);
  });

  test('mesures à 390 px : pas de débordement, cibles ≥ 44 px, espaces en recouvrement', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await reloadList();
    let [scrollW, innerW] = await overflow();
    expect(scrollW).toBeLessThanOrEqual(innerW);
    expect(await smallTargets()).toEqual([]);
    // Le volet des espaces n'occupe plus la page : il s'ouvre en recouvrement.
    await expect(page.locator('.spaces')).toBeHidden();
    const listTop = (await page.locator('.zone').boundingBox())!.y;
    expect(listTop).toBeLessThan(330);
    await shot('mobile-390');
    await page.locator('.spaces-btn').click();
    await expect(page.locator('.spaces')).toBeVisible();
    expect(await smallTargets()).toEqual([]);
    await page.locator('.spaces-head .icon-btn').click();
    await expect(page.locator('.spaces')).toBeHidden();
    // Avec une sélection : barre d'actions collée en bas, toujours sans débordement.
    await row('f:zz-a.txt').locator('.check').click();
    await row('f:zz-b.txt').locator('.check').click();
    expect(await selectedIds()).toEqual(['f:zz-a.txt', 'f:zz-b.txt']);
    [scrollW, innerW] = await overflow();
    expect(scrollW).toBeLessThanOrEqual(innerW);
    expect(await smallTargets()).toEqual([]);
    const bar = (await page.locator('app-toolbar .bar').boundingBox())!;
    expect(Math.round(bar.y + bar.height)).toBe(844);
    await shot('mobile-390-selection');
    await page.locator('app-toolbar [data-action="clear-selection"]').click();
    console.log(`MESURE 390 : scrollWidth=${scrollW} innerWidth=${innerW} hautDeListe=${Math.round(listTop)}`);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('rupture à 900 px, thème sombre, polices', async () => {
    await page.setViewportSize({ width: 899, height: 800 });
    await expect(page.locator('.spaces-btn')).toBeVisible();
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.locator('.spaces-btn')).toBeHidden();
    await expect(page.locator('.spaces')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });

    await row('f:zz-a.txt').click();
    const colors = () => page.evaluate(() => ({
      zone: getComputedStyle(document.querySelector('.zone')!).backgroundColor,
      selected: getComputedStyle(document.querySelector('.entry.selected')!).backgroundColor,
      text: getComputedStyle(document.querySelector('.entry .name')!).color,
    }));
    const light = await colors();
    await page.locator('.sidebar-footer .icon-btn').first().click();
    const dark = await colors();
    await shot('sombre-1280');
    expect(dark.zone).not.toBe(light.zone);
    expect(dark.selected).not.toBe(light.selected);
    expect(dark.text).not.toBe(light.text);
    await page.locator('.sidebar-footer .icon-btn').first().click();
    await page.keyboard.press('Escape');

    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/"/g, ''));
    });
    expect(fonts).toContain('Foyer UI');
  });

  test('accessibilité : rôles, états et annonces', async () => {
    await expect(page.locator('.grid')).toHaveAttribute('role', 'grid');
    await expect(page.locator('.grid')).toHaveAttribute('aria-multiselectable', 'true');
    expect(await page.locator('.entry[role="row"]').count()).toBeGreaterThan(1);
    await row('f:zz-a.txt').click();
    await expect(row('f:zz-a.txt')).toHaveAttribute('aria-selected', 'true');
    await expect(row('f:zz-b.txt')).toHaveAttribute('aria-selected', 'false');
    await expect.poll(() => page.locator('.cdk-live-announcer-element').textContent()).toContain('1 élément sélectionné');
    // Un seul arrêt de tabulation dans la liste (tabindex itinérant).
    expect(await page.locator('.entry[tabindex="0"]').count()).toBe(1);
    expect(await page.locator('.browser a:not([href])').count()).toBe(0);
    await expect(page.locator('.breadcrumb')).toHaveAttribute('aria-label', 'Chemin');
    await page.keyboard.press('Escape');
  });
}
