/** Adresse de retour après Keycloak — `npm run test:engine`. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loginRedirectUri } from './redirect-uri';

const ORIGIN = 'https://lab.example.org';
const APP = 'https://lab.example.org/lab-admin/';
const back = (href: string, appUrl: string | undefined = APP) => loginRedirectUri(href, appUrl, ORIGIN);

test('on revient à la page demandée', () => {
  assert.equal(back(`${APP}`), APP);
  assert.equal(back(`${APP}projets/mon-app`), `${APP}projets/mon-app`);
  assert.equal(back(`${APP}outils`), `${APP}outils`);
  assert.equal(back(`${APP}?as=hassan`), `${APP}?as=hassan`);
  assert.equal(back(`${APP}projets/mon-app?x=1#state=abc&code=def`), `${APP}projets/mon-app?x=1`);
  assert.equal(back('https://lab.example.org/lab-admin'), 'https://lab.example.org/lab-admin');
});

test('jamais hors de l\'app, jamais vers une URL fournie par un paramètre', () => {
  // Un paramètre qui ressemble à une redirection reste un paramètre de la page courante.
  const withParam = back(`${APP}projets/x?redirect=https://evil.example/&next=//evil.example`);
  assert.ok(withParam.startsWith(`${APP}projets/x?`));
  assert.equal(new URL(withParam).origin, ORIGIN);
  // Hors du préfixe de l'app : retour à l'accueil.
  for (const href of ['https://lab.example.org/lab-admin-api/api/users/', 'https://lab.example.org/storage/',
                      'https://lab.example.org/', 'https://evil.example/lab-admin/projets/x',
                      'https://lab.example.org.evil.example/lab-admin/', 'https://lab.example.org/lab-admin/../storage/x',
                      'javascript:alert(1)', 'data:text/html,x', 'pas une url', '']) {
    assert.equal(back(href), APP, href);
  }
});

test('sans domaine (ports locaux) et sans appUrl', () => {
  assert.equal(loginRedirectUri('http://192.168.1.10:4201/projets/x', 'http://192.168.1.10:4201', 'http://192.168.1.10:4201'),
    'http://192.168.1.10:4201/projets/x');
  assert.equal(loginRedirectUri('http://localhost:4201/debug', undefined, 'http://localhost:4201'), 'http://localhost:4201/debug');
  assert.equal(loginRedirectUri('http://localhost:9999/debug', undefined, 'http://localhost:4201'), 'http://localhost:4201');
});
