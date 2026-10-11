import { describe, expect, it } from 'vitest';
import {
  FileMeta, buildEntries, filesOfEntries, filterEntries, folderNameError, formatSize, normalize, sortEntries,
  splitName, uniqueName,
} from './entries';

const f = (relative_path: string, size = 1, updated_at = '2026-01-01T00:00:00Z'): FileMeta => ({
  namespace: 'ns', relative_path, size, content_type: '', uploaded_by_email: '', created_at: updated_at, updated_at,
});

const files = [
  f('a.txt', 10, '2026-01-03T00:00:00Z'),
  f('photos/x.jpg', 100, '2026-01-01T00:00:00Z'),
  f('photos/ete/y.jpg', 200, '2026-01-05T00:00:00Z'),
  f('photos/ete/z.jpg', 50, '2026-01-02T00:00:00Z'),
  f('Zoo.txt', 5),
];

describe('buildEntries', () => {
  it('racine : dossiers déduits, puis fichiers du niveau', () => {
    const e = buildEntries(files, '');
    expect(e.map(x => `${x.kind}:${x.name}`)).toEqual(['folder:photos', 'file:a.txt', 'file:Zoo.txt']);
  });

  it('un dossier porte la somme, le compte et la date la plus récente de son contenu', () => {
    const photos = buildEntries(files, '')[0];
    expect(photos.size).toBe(350);
    expect(photos.count).toBe(3);
    expect(photos.updatedAt).toBe('2026-01-05T00:00:00Z');
    expect(photos.path).toBe('photos');
  });

  it('sous-dossier', () => {
    const e = buildEntries(files, 'photos');
    expect(e.map(x => x.name)).toEqual(['ete', 'x.jpg']);
    expect(e[0].path).toBe('photos/ete');
    expect(e[1].file?.relative_path).toBe('photos/x.jpg');
  });

  it('un préfixe de nom n\'est pas un dossier parent (photos2 ≠ photos/)', () => {
    const e = buildEntries([f('photos2/a'), f('photos/b')], 'photos');
    expect(e.map(x => x.name)).toEqual(['b']);
  });

  it('dossier inexistant : vide', () => {
    expect(buildEntries(files, 'nulle-part')).toEqual([]);
  });

  it('dossier en attente : affiché vide, seulement à son niveau', () => {
    const e = buildEntries(files, '', ['nouveau', 'photos/album', 'photos']);
    const nouveau = e.find(x => x.name === 'nouveau');
    expect(nouveau).toMatchObject({ kind: 'folder', pending: true, count: 0, size: 0 });
    expect(e.filter(x => x.name === 'photos')).toHaveLength(1);
    expect(e.find(x => x.name === 'photos')?.pending).toBeUndefined();
    expect(e.find(x => x.name === 'album')).toBeUndefined();
    expect(buildEntries(files, 'photos', ['photos/album']).find(x => x.name === 'album')?.pending).toBe(true);
  });

  it('identifiants distincts pour un fichier et un dossier de même nom', () => {
    const e = buildEntries([f('a'), f('a/b')], '');
    expect(new Set(e.map(x => x.id)).size).toBe(2);
  });
});

describe('sortEntries', () => {
  const e = buildEntries(files, '');
  const names = (k: 'name' | 'size' | 'date', d: 'asc' | 'desc') => sortEntries(e, { key: k, dir: d }).map(x => x.name);

  it('par nom, sans tenir compte de la casse ; dossiers d\'abord', () => {
    expect(names('name', 'asc')).toEqual(['photos', 'a.txt', 'Zoo.txt']);
    expect(names('name', 'desc')).toEqual(['photos', 'Zoo.txt', 'a.txt']);
  });

  it('par taille', () => {
    expect(names('size', 'asc')).toEqual(['photos', 'Zoo.txt', 'a.txt']);
    expect(names('size', 'desc')).toEqual(['photos', 'a.txt', 'Zoo.txt']);
  });

  it('par date', () => {
    expect(names('date', 'desc')).toEqual(['photos', 'a.txt', 'Zoo.txt']);
  });

  it('ordre naturel des nombres', () => {
    const n = sortEntries(buildEntries([f('img10'), f('img2'), f('img1')], ''), { key: 'name', dir: 'asc' });
    expect(n.map(x => x.name)).toEqual(['img1', 'img2', 'img10']);
  });

  it('ne modifie pas le tableau reçu', () => {
    const before = e.map(x => x.name);
    sortEntries(e, { key: 'size', dir: 'desc' });
    expect(e.map(x => x.name)).toEqual(before);
  });
});

describe('filtre', () => {
  it('insensible à la casse et aux accents', () => {
    const e = buildEntries([f('Été.txt'), f('hiver.txt')], '');
    expect(filterEntries(e, 'ete').map(x => x.name)).toEqual(['Été.txt']);
    expect(filterEntries(e, ' ÉTÉ ').map(x => x.name)).toEqual(['Été.txt']);
    expect(normalize('Çà et Là')).toBe('ca et la');
  });

  it('filtre vide : tout', () => {
    expect(filterEntries(buildEntries(files, ''), '  ')).toHaveLength(3);
  });
});

describe('filesOfEntries', () => {
  it('un dossier vaut tout son contenu ; pas de doublon', () => {
    const e = buildEntries(files, '');
    const picked = filesOfEntries(files, [e[0], e[1], e[0]]);
    expect(picked.map(x => x.relative_path).sort()).toEqual(['a.txt', 'photos/ete/y.jpg', 'photos/ete/z.jpg', 'photos/x.jpg']);
  });
});

describe('noms', () => {
  it('splitName', () => {
    expect(splitName('photo.jpg')).toEqual(['photo', '.jpg']);
    expect(splitName('archive.tar.gz')).toEqual(['archive.tar', '.gz']);
    expect(splitName('.gitignore')).toEqual(['.gitignore', '']);
    expect(splitName('LISEZMOI')).toEqual(['LISEZMOI', '']);
  });

  it('uniqueName : a.txt → a (2).txt → a (3).txt', () => {
    expect(uniqueName('a.txt', new Set())).toBe('a.txt');
    expect(uniqueName('a.txt', new Set(['a.txt']))).toBe('a (2).txt');
    expect(uniqueName('a.txt', new Set(['a.txt', 'a (2).txt']))).toBe('a (3).txt');
  });

  it('uniqueName : repart du numéro existant, gère l\'absence d\'extension', () => {
    expect(uniqueName('a (2).txt', new Set(['a (2).txt']))).toBe('a (3).txt');
    expect(uniqueName('notes', new Set(['notes']))).toBe('notes (2)');
    expect(uniqueName('.env', new Set(['.env']))).toBe('.env (2)');
  });

  it('folderNameError', () => {
    const siblings = new Set(['photos']);
    expect(folderNameError('  ', siblings)).toBeTruthy();
    expect(folderNameError('a/b', siblings)).toBeTruthy();
    expect(folderNameError('..', siblings)).toBeTruthy();
    expect(folderNameError('photos', siblings)).toBeTruthy();
    expect(folderNameError('nouveau', siblings)).toBeNull();
  });

  it('formatSize', () => {
    expect(formatSize(0)).toBe('0 o');
    expect(formatSize(1023)).toBe('1023 o');
    expect(formatSize(1536)).toBe('1.5 Ko');
    expect(formatSize(20 * 1024 * 1024)).toBe('20 Mo');
  });
});
