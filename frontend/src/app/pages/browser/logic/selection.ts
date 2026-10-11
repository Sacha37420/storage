/**
 * Modèle de sélection : fonctions pures sur un état immuable. `order` est la
 * liste des identifiants dans l'ordre AFFICHÉ (après tri et filtre) — c'est
 * lui qui définit ce qu'est une « plage ». Testé dans selection.spec.ts.
 */

export interface SelectionState {
  selected: ReadonlySet<string>;
  /** Point fixe d'une plage (Maj+clic, Maj+flèche). */
  anchor: string | null;
  /** Élément qui porte le focus clavier. */
  cursor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), anchor: null, cursor: null };

/** Clic simple : cet élément et lui seul. */
export function selectOnly(id: string): SelectionState {
  return { selected: new Set([id]), anchor: id, cursor: id };
}

/** Ctrl+clic, case à cocher, Espace : ajoute ou retire sans toucher au reste. */
export function toggle(state: SelectionState, id: string): SelectionState {
  const selected = new Set(state.selected);
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  return { selected, anchor: id, cursor: id };
}

function between(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i === -1 || j === -1) return j === -1 ? [] : [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/**
 * Maj+clic : de l'ancre jusqu'à `id`, dans l'ordre affiché. L'ancre ne bouge
 * pas, si bien qu'un second Maj+clic REMPLACE la plage au lieu de l'étendre.
 * `additive` (Ctrl+Maj) conserve en plus ce qui était déjà sélectionné.
 */
export function selectRange(state: SelectionState, order: readonly string[], id: string, additive = false): SelectionState {
  const anchor = state.anchor && order.includes(state.anchor) ? state.anchor : id;
  const range = between(order, anchor, id);
  const selected = additive ? new Set([...state.selected, ...range]) : new Set(range);
  return { selected, anchor, cursor: id };
}

export function selectAll(state: SelectionState, order: readonly string[]): SelectionState {
  return { selected: new Set(order), anchor: state.anchor ?? order[0] ?? null, cursor: state.cursor ?? order[0] ?? null };
}

/** Échap : vide la sélection mais garde le curseur, pour continuer au clavier. */
export function clearSelection(state: SelectionState): SelectionState {
  return { selected: new Set(), anchor: state.cursor, cursor: state.cursor };
}

export type CursorMove = number | 'first' | 'last';

/**
 * Flèches, Début, Fin. Sans modificateur : le curseur se déplace et devient la
 * seule sélection. `extend` (Maj) : plage depuis l'ancre. `keep` (Ctrl) : le
 * curseur se déplace seul, la sélection ne change pas.
 */
export function moveCursor(
  state: SelectionState, order: readonly string[], move: CursorMove,
  opts: { extend?: boolean; keep?: boolean } = {},
): SelectionState {
  if (order.length === 0) return state;
  const current = state.cursor ? order.indexOf(state.cursor) : -1;
  let index: number;
  if (move === 'first') index = 0;
  else if (move === 'last') index = order.length - 1;
  else if (current === -1) index = move > 0 ? 0 : order.length - 1;
  else index = Math.max(0, Math.min(order.length - 1, current + move));
  const id = order[index];
  if (opts.keep) return { ...state, cursor: id };
  if (opts.extend) return selectRange(state, order, id);
  return selectOnly(id);
}

/** Rectangle glissé : `base` (sélection au début du geste si Ctrl/Maj, vide sinon) plus ce que le rectangle touche. */
export function lasso(base: ReadonlySet<string>, touched: readonly string[], state: SelectionState): SelectionState {
  const selected = new Set([...base, ...touched]);
  const last = touched[touched.length - 1] ?? state.cursor;
  return { selected, anchor: last, cursor: last };
}

/** Retire ce qui n'est plus affiché (changement de dossier, filtre, suppression). */
export function prune(state: SelectionState, order: readonly string[]): SelectionState {
  const visible = new Set(order);
  const keep = (id: string | null) => (id && visible.has(id) ? id : null);
  const selected = new Set([...state.selected].filter(id => visible.has(id)));
  if (selected.size === state.selected.size && keep(state.anchor) === state.anchor && keep(state.cursor) === state.cursor) {
    return state;
  }
  return { selected, anchor: keep(state.anchor), cursor: keep(state.cursor) };
}
