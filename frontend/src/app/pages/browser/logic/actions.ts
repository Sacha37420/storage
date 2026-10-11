/**
 * LA table des actions. La barre d'outils, le menu contextuel (clic droit,
 * appui long) et le clavier la lisent tous les trois : ajouter une action,
 * c'est ajouter une entrée ici, rien d'autre. Aucun import Angular.
 */
import { Entry } from './entries';

export interface ActionContext {
  selection: readonly Entry[];
  /** Nombre d'éléments affichés. */
  total: number;
  canWrite: boolean;
  /** Vrai à la racine de l'espace (pas de dossier parent). */
  atRoot: boolean;
}

/** Ce que les actions savent demander à l'interface — implémenté par BrowserStore. */
export interface ActionHost {
  open(entry: Entry): void;
  download(entries: readonly Entry[]): void;
  remove(entries: readonly Entry[]): void;
  selectAll(): void;
  clearSelection(): void;
  newFolder(): void;
  pickFiles(): void;
  pickFolder(): void;
  goParent(): void;
  focusFilter(): void;
}

export type ActionGroup = 'create' | 'selection' | 'view';

export interface FileAction {
  id: string;
  label: string;
  /** Libellé court pour la barre d'outils, quand `label` y serait trop long. */
  short?: string;
  icon: string;
  group: ActionGroup;
  /** Combinaison au format 'Control+a', 'Delete', '/'. */
  shortcut?: string;
  /** Vrai : le raccourci vaut partout dans la page (hors champ de saisie), pas seulement quand la liste a le focus. */
  global?: boolean;
  danger?: boolean;
  inBar?: boolean;
  inMenu?: boolean;
  visible(ctx: ActionContext): boolean;
  run(host: ActionHost, ctx: ActionContext): void;
}

const hasFile = (ctx: ActionContext) => ctx.selection.some(e => e.kind === 'file');

export const ACTIONS: readonly FileAction[] = [
  {
    id: 'open', label: 'Ouvrir', icon: 'open', group: 'selection', shortcut: 'Enter', inMenu: true,
    visible: ctx => ctx.selection.length === 1 && ctx.selection[0].kind === 'folder',
    run: (host, ctx) => host.open(ctx.selection[0]),
  },
  {
    id: 'download', label: 'Télécharger', icon: 'download', group: 'selection', inBar: true, inMenu: true,
    visible: hasFile,
    run: (host, ctx) => host.download(ctx.selection),
  },
  {
    id: 'delete', label: 'Supprimer', icon: 'trash', group: 'selection', shortcut: 'Delete', danger: true, inBar: true, inMenu: true,
    visible: ctx => ctx.canWrite && ctx.selection.length > 0,
    run: (host, ctx) => host.remove(ctx.selection),
  },
  {
    id: 'upload-files', label: 'Téléverser des fichiers', short: 'Téléverser', icon: 'upload', group: 'create', inBar: true, inMenu: true,
    visible: ctx => ctx.canWrite && ctx.selection.length === 0,
    run: host => host.pickFiles(),
  },
  {
    id: 'upload-folder', label: 'Téléverser un dossier', icon: 'folder-up', group: 'create', inBar: true, inMenu: true,
    visible: ctx => ctx.canWrite && ctx.selection.length === 0,
    run: host => host.pickFolder(),
  },
  {
    id: 'new-folder', label: 'Nouveau dossier', icon: 'folder-plus', group: 'create', inBar: true, inMenu: true,
    visible: ctx => ctx.canWrite && ctx.selection.length === 0,
    run: host => host.newFolder(),
  },
  {
    id: 'select-all', label: 'Tout sélectionner', icon: 'check-all', group: 'view', shortcut: 'Control+a', global: true, inMenu: true,
    visible: ctx => ctx.total > 0 && ctx.selection.length < ctx.total,
    run: host => host.selectAll(),
  },
  {
    id: 'clear-selection', label: 'Désélectionner', icon: 'close', group: 'view', shortcut: 'Escape', global: true, inMenu: true,
    visible: ctx => ctx.selection.length > 0,
    run: host => host.clearSelection(),
  },
  {
    id: 'go-parent', label: 'Dossier parent', icon: 'up', group: 'view', shortcut: 'Backspace', global: true, inMenu: true,
    visible: ctx => !ctx.atRoot && ctx.selection.length === 0,
    run: host => host.goParent(),
  },
  {
    id: 'filter', label: 'Filtrer', icon: 'search', group: 'view', shortcut: '/', global: true,
    visible: () => true,
    run: host => host.focusFilter(),
  },
];

export interface KeyLike { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; }

/** 'Control+a' correspond à Ctrl+A ET à Cmd+A (macOS). Maj et Alt doivent correspondre exactement. */
export function matchShortcut(e: KeyLike, shortcut: string): boolean {
  const parts = shortcut === '+' ? ['+'] : shortcut.split('+');
  const key = parts[parts.length - 1];
  const wantCtrl = parts.includes('Control');
  const wantShift = parts.includes('Shift');
  const wantAlt = parts.includes('Alt');
  const ctrl = !!(e.ctrlKey || e.metaKey);
  if (ctrl !== wantCtrl || !!e.altKey !== wantAlt) return false;
  // Un caractère imprimable porte déjà Maj dans sa valeur ('/' = Maj+':' sur un clavier français).
  if (key.length > 1 && !!e.shiftKey !== wantShift) return false;
  return e.key.length === 1 ? e.key.toLowerCase() === key.toLowerCase() : e.key === key;
}

export function actionsFor(ctx: ActionContext, where: 'bar' | 'menu'): FileAction[] {
  return ACTIONS.filter(a => (where === 'bar' ? a.inBar : a.inMenu) && a.visible(ctx));
}

/** Action déclenchée par cette touche, ou null. `inList` : la liste a le focus. */
export function actionForKey(e: KeyLike, ctx: ActionContext, inList: boolean): FileAction | null {
  for (const a of ACTIONS) {
    if (!a.shortcut || !matchShortcut(e, a.shortcut)) continue;
    if (!a.global && !inList) continue;
    if (a.visible(ctx)) return a;
  }
  return null;
}

const KEY_LABELS: Record<string, string> = {
  Control: 'Ctrl', Delete: 'Suppr', Enter: 'Entrée', Escape: 'Échap', Backspace: 'Retour arr.', Shift: 'Maj',
};

export function shortcutLabel(shortcut: string | undefined): string {
  if (!shortcut) return '';
  return shortcut.split('+').map(p => KEY_LABELS[p] ?? p.toUpperCase()).join('+');
}
