/** À quelles adresses le jeton est joint — `npm run test:engine`. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { carriesToken } from './token-scope';

const ORIGIN = 'https://lab.example.org';
/** Ce que rend `tokenBases()` en service. */
const BASES = [
  'https://lab.example.org/lab-admin-api',
  'https://lab.example.org/mcp/api',
  'https://lab.example.org/app-builder-api/api/handoff',
];
const ok = (url: string, bases = BASES, origin = ORIGIN) => carriesToken(url, bases, origin);

test('le jeton part vers les trois API configurées', () => {
  for (const url of [
    'https://lab.example.org/lab-admin-api/api/tools/',
    'https://lab.example.org/lab-admin-api/api/lab-users/groups/',
    'https://lab.example.org/mcp/api/me',
    'https://lab.example.org/mcp/api/projects?as=hassan',
    'https://lab.example.org/mcp/api/projects/mon-app/env/MA_CLE',
    'https://lab.example.org/app-builder-api/api/handoff/specs/',
    'https://lab.example.org/app-builder-api/api/handoff/specs/12/kit/',
    '/mcp/api/me',                                       // relative : résolue sur l'origine de la page
  ]) assert.equal(ok(url), true, url);
});

test('et nulle part ailleurs', () => {
  for (const url of [
    'https://evil.example/mcp/api/me',                                   // autre origine
    'https://lab.example.org.evil.example/mcp/api/me',
    'https://lab.example.org@evil.example/mcp/api/me',
    'https://user:pass@lab.example.org/mcp/api/me',
    'http://lab.example.org/mcp/api/me',                                 // autre protocole = autre origine
    'https://lab.example.org:8443/mcp/api/me',
    '//evil.example/mcp/api/me',
    'https://lab.example.org/lab-admin-api-autre/x',                     // chemin voisin
    'https://lab.example.org/mcp/apix',
    'https://lab.example.org/mcp',                                       // l'entrée MCP, pas l'API web
    'https://lab.example.org/mcp/api/../../storage-api/api/files/',      // remontée
    'https://lab.example.org/app-builder-api/api/handoff/../apps/',
    'https://lab.example.org/app-builder-api/api/apps/',                 // App Builder hors remise
    'https://lab.example.org/app-builder-api/',
    'https://lab.example.org/storage-api/api/files/',                    // une autre app du lab
    'https://lab.example.org/oauth-hub-api/api/providers/github/token/',
    'https://lab.example.org/',
    'javascript:alert(1)', 'data:text/plain,x', 'pas une url', '',
  ]) assert.equal(ok(url), false, url);
});

test('sans App Builder configuré, rien ne part vers lui', () => {
  const bases = BASES.slice(0, 2);
  assert.equal(ok('https://lab.example.org/app-builder-api/api/handoff/specs/', bases), false);
  assert.equal(ok('https://lab.example.org/mcp/api/me', bases), true);
  assert.equal(ok('https://lab.example.org/mcp/api/me', []), false);
  assert.equal(ok('https://lab.example.org/mcp/api/me', ['', 'pas une url', 'javascript:x']), false);
});

test('ports locaux (sans domaine) : une base sans chemin couvre son origine, pas les autres ports', () => {
  const origin = 'http://192.168.1.10:4201';
  const bases = ['http://192.168.1.10:8083', 'http://192.168.1.10:4201/mcp/api', 'http://192.168.1.10:8087/api/handoff'];
  assert.equal(ok('http://192.168.1.10:8083/api/tools/', bases, origin), true);
  assert.equal(ok('http://192.168.1.10:4201/mcp/api/me', bases, origin), true);
  assert.equal(ok('http://192.168.1.10:8087/api/handoff/specs/', bases, origin), true);
  assert.equal(ok('http://192.168.1.10:8087/api/apps/', bases, origin), false);
  assert.equal(ok('http://192.168.1.10:8093/api/files/', bases, origin), false);
  assert.equal(ok('http://192.168.1.10:4201/assets/env.js', bases, origin), false);
});
