import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION, clearSelection, lasso, moveCursor, prune, selectAll, selectOnly, selectRange, toggle,
} from './selection';

const order = ['a', 'b', 'c', 'd', 'e'];
const ids = (s: { selected: ReadonlySet<string> }) => [...s.selected].sort();

describe('clic', () => {
  it('clic simple : cet élément seul, ancre et curseur dessus', () => {
    const s = selectOnly('c');
    expect(ids(s)).toEqual(['c']);
    expect(s.anchor).toBe('c');
    expect(s.cursor).toBe('c');
  });

  it('clic simple remplace la sélection précédente', () => {
    expect(ids(selectOnly('d'))).toEqual(['d']);
  });

  it('Ctrl+clic ajoute puis retire, sans toucher au reste', () => {
    let s = toggle(selectOnly('a'), 'c');
    expect(ids(s)).toEqual(['a', 'c']);
    s = toggle(s, 'a');
    expect(ids(s)).toEqual(['c']);
    expect(s.anchor).toBe('a');
  });
});

describe('Maj+clic', () => {
  it('vers le bas depuis l\'ancre', () => {
    expect(ids(selectRange(selectOnly('b'), order, 'd'))).toEqual(['b', 'c', 'd']);
  });

  it('vers le haut depuis l\'ancre', () => {
    expect(ids(selectRange(selectOnly('d'), order, 'a'))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('un second Maj+clic remplace la plage : l\'ancre ne bouge pas', () => {
    let s = selectRange(selectOnly('c'), order, 'e');
    s = selectRange(s, order, 'a');
    expect(ids(s)).toEqual(['a', 'b', 'c']);
    expect(s.anchor).toBe('c');
    expect(s.cursor).toBe('a');
  });

  it('sans ancre : sélectionne le seul élément cliqué', () => {
    expect(ids(selectRange(EMPTY_SELECTION, order, 'c'))).toEqual(['c']);
  });

  it('Ctrl+Maj+clic ajoute la plage à l\'existant', () => {
    const s = toggle(selectOnly('a'), 'c'); // a, c ; ancre c
    expect(ids(selectRange(s, order, 'e', true))).toEqual(['a', 'c', 'd', 'e']);
  });

  it('la plage suit l\'ordre AFFICHÉ, pas un ordre fixe (après un tri)', () => {
    const sorted = ['e', 'a', 'd', 'b', 'c'];
    expect(ids(selectRange(selectOnly('a'), sorted, 'b'))).toEqual(['a', 'b', 'd']);
  });

  it('ancre disparue de la liste (filtre) : repart de l\'élément cliqué', () => {
    expect(ids(selectRange(selectOnly('zz'), order, 'b'))).toEqual(['b']);
  });
});

describe('tout / rien', () => {
  it('tout sélectionner', () => {
    expect(ids(selectAll(EMPTY_SELECTION, order))).toEqual(order);
  });

  it('tout sélectionner sur une liste vide', () => {
    const s = selectAll(EMPTY_SELECTION, []);
    expect(s.selected.size).toBe(0);
    expect(s.cursor).toBeNull();
  });

  it('Échap vide la sélection mais garde le curseur', () => {
    const s = clearSelection(selectRange(selectOnly('b'), order, 'd'));
    expect(s.selected.size).toBe(0);
    expect(s.cursor).toBe('d');
  });
});

describe('clavier', () => {
  it('flèche bas sans curseur : premier élément ; flèche haut : dernier', () => {
    expect(moveCursor(EMPTY_SELECTION, order, 1).cursor).toBe('a');
    expect(moveCursor(EMPTY_SELECTION, order, -1).cursor).toBe('e');
  });

  it('flèche : déplace et sélectionne le seul élément atteint', () => {
    const s = moveCursor(selectOnly('b'), order, 1);
    expect(ids(s)).toEqual(['c']);
  });

  it('bute aux extrémités', () => {
    expect(moveCursor(selectOnly('a'), order, -1).cursor).toBe('a');
    expect(moveCursor(selectOnly('e'), order, 1).cursor).toBe('e');
  });

  it('Maj+flèche étend, puis rétrécit en revenant', () => {
    let s = moveCursor(selectOnly('b'), order, 1, { extend: true });
    s = moveCursor(s, order, 1, { extend: true });
    expect(ids(s)).toEqual(['b', 'c', 'd']);
    s = moveCursor(s, order, -1, { extend: true });
    expect(ids(s)).toEqual(['b', 'c']);
  });

  it('Ctrl+flèche déplace le curseur sans changer la sélection', () => {
    const s = moveCursor(selectOnly('b'), order, 2, { keep: true });
    expect(ids(s)).toEqual(['b']);
    expect(s.cursor).toBe('d');
  });

  it('Début / Fin, avec et sans Maj', () => {
    expect(moveCursor(selectOnly('c'), order, 'first').cursor).toBe('a');
    expect(ids(moveCursor(selectOnly('c'), order, 'last', { extend: true }))).toEqual(['c', 'd', 'e']);
  });

  it('liste vide : rien ne change', () => {
    expect(moveCursor(EMPTY_SELECTION, [], 1)).toBe(EMPTY_SELECTION);
  });
});

describe('rectangle glissé', () => {
  it('sans modificateur : exactement ce que le rectangle touche', () => {
    expect(ids(lasso(new Set(), ['b', 'c'], selectOnly('e')))).toEqual(['b', 'c']);
  });

  it('avec Ctrl : s\'ajoute à la sélection de départ', () => {
    expect(ids(lasso(new Set(['a']), ['c', 'd'], selectOnly('a')))).toEqual(['a', 'c', 'd']);
  });

  it('rectangle qui se referme : revient à la base', () => {
    expect(ids(lasso(new Set(['a']), [], selectOnly('a')))).toEqual(['a']);
  });
});

describe('prune', () => {
  it('retire ce qui n\'est plus affiché, ancre et curseur compris', () => {
    const s = prune(selectRange(selectOnly('b'), order, 'd'), ['a', 'b']);
    expect(ids(s)).toEqual(['b']);
    expect(s.anchor).toBe('b');
    expect(s.cursor).toBeNull();
  });

  it('rend le même objet quand rien ne change', () => {
    const s = selectOnly('b');
    expect(prune(s, order)).toBe(s);
  });
});
