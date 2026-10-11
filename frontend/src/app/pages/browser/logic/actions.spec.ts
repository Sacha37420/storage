import { describe, expect, it } from 'vitest';
import { ACTIONS, ActionContext, actionForKey, actionsFor, matchShortcut, shortcutLabel } from './actions';
import { Entry } from './entries';

const file = (name: string): Entry => ({ id: `f:${name}`, kind: 'file', name, path: name, size: 1, updatedAt: null, count: 1 });
const folder = (name: string): Entry => ({ id: `d:${name}`, kind: 'folder', name, path: name, size: 0, updatedAt: null, count: 0 });
const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({ selection: [], total: 5, canWrite: true, atRoot: true, ...over });
const ids = (c: ActionContext, where: 'bar' | 'menu') => actionsFor(c, where).map(a => a.id);

describe('visibilité', () => {
  it('sans sélection, en écriture : créer et téléverser', () => {
    expect(ids(ctx(), 'bar')).toEqual(['upload-files', 'upload-folder', 'new-folder']);
  });

  it('sans sélection, en lecture seule : rien dans la barre', () => {
    expect(ids(ctx({ canWrite: false }), 'bar')).toEqual([]);
  });

  it('fichiers sélectionnés, en écriture : télécharger et supprimer', () => {
    expect(ids(ctx({ selection: [file('a'), file('b')] }), 'bar')).toEqual(['download', 'delete']);
  });

  it('en lecture seule : télécharger, jamais supprimer', () => {
    const c = ctx({ selection: [file('a')], canWrite: false });
    expect(ids(c, 'bar')).toEqual(['download']);
    expect(ids(c, 'menu')).not.toContain('delete');
  });

  it('dossier seul : ouvrir et supprimer, pas télécharger', () => {
    const m = ids(ctx({ selection: [folder('d')] }), 'menu');
    expect(m).toContain('open');
    expect(m).toContain('delete');
    expect(m).not.toContain('download');
  });

  it('« ouvrir » disparaît dès qu\'il y a plusieurs éléments', () => {
    expect(ids(ctx({ selection: [folder('d'), folder('e')] }), 'menu')).not.toContain('open');
  });

  it('« tout sélectionner » disparaît quand tout l\'est, ou quand la liste est vide', () => {
    expect(ids(ctx({ selection: [file('a')], total: 1 }), 'menu')).not.toContain('select-all');
    expect(ids(ctx({ total: 0 }), 'menu')).not.toContain('select-all');
  });

  it('« dossier parent » seulement hors de la racine', () => {
    expect(ids(ctx({ atRoot: false }), 'menu')).toContain('go-parent');
    expect(ids(ctx(), 'menu')).not.toContain('go-parent');
  });

  it('chaque identifiant est unique', () => {
    expect(new Set(ACTIONS.map(a => a.id)).size).toBe(ACTIONS.length);
  });
});

describe('clavier', () => {
  it('Suppr supprime la sélection quand la liste a le focus, pas ailleurs', () => {
    const c = ctx({ selection: [file('a')] });
    expect(actionForKey({ key: 'Delete' }, c, true)?.id).toBe('delete');
    expect(actionForKey({ key: 'Delete' }, c, false)).toBeNull();
  });

  it('Suppr sans droit d\'écriture ou sans sélection : rien', () => {
    expect(actionForKey({ key: 'Delete' }, ctx({ selection: [file('a')], canWrite: false }), true)).toBeNull();
    expect(actionForKey({ key: 'Delete' }, ctx(), true)).toBeNull();
  });

  it('Ctrl+A et Cmd+A, partout dans la page', () => {
    expect(actionForKey({ key: 'a', ctrlKey: true }, ctx(), false)?.id).toBe('select-all');
    expect(actionForKey({ key: 'A', metaKey: true }, ctx(), false)?.id).toBe('select-all');
    expect(actionForKey({ key: 'a' }, ctx(), true)).toBeNull();
  });

  it('Entrée ouvre un dossier', () => {
    expect(actionForKey({ key: 'Enter' }, ctx({ selection: [folder('d')] }), true)?.id).toBe('open');
    expect(actionForKey({ key: 'Enter' }, ctx({ selection: [file('a')] }), true)).toBeNull();
  });

  it('Échap, Retour arrière, /', () => {
    expect(actionForKey({ key: 'Escape' }, ctx({ selection: [file('a')] }), false)?.id).toBe('clear-selection');
    expect(actionForKey({ key: 'Backspace' }, ctx({ atRoot: false }), false)?.id).toBe('go-parent');
    expect(actionForKey({ key: '/', shiftKey: true }, ctx(), false)?.id).toBe('filter');
  });

  it('matchShortcut : les modificateurs doivent correspondre', () => {
    expect(matchShortcut({ key: 'Delete', shiftKey: true }, 'Delete')).toBe(false);
    expect(matchShortcut({ key: 'a', ctrlKey: true, altKey: true }, 'Control+a')).toBe(false);
    expect(matchShortcut({ key: 'Enter', ctrlKey: true }, 'Enter')).toBe(false);
  });

  it('libellés français', () => {
    expect(shortcutLabel('Control+a')).toBe('Ctrl+A');
    expect(shortcutLabel('Delete')).toBe('Suppr');
    expect(shortcutLabel(undefined)).toBe('');
  });
});
