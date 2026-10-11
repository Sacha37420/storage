import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpEvent, HttpRequest } from '@angular/common/http';
import { Observable } from 'rxjs';

interface EnvWindow {
  __env?: { apiUrl?: string; maxUploadBytes?: number };
}

/** Limite par défaut du backend (MAX_UPLOAD_BYTES), si env.js ne la donne pas. */
const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export interface Me {
  email: string;
  username: string;
  groups: string[];
}

export interface Share {
  name: string;
  owner_username: string;
  required_groups: string;
  /** Nom du partage parent, ou null s'il est à la racine de la hiérarchie. */
  parent: string | null;
  created_at: string;
}

export type ShareMemberRole = 'read' | 'write';
export type ShareAccessReason = 'owner' | 'group' | 'member';

export interface ShareMember {
  member_email: string;
  role: ShareMemberRole;
  added_at: string;
}

/**
 * Nœud de l'arborescence renvoyée par GET /api/shares/ (champ `tree`).
 *
 * `accessible = false` signifie : ce partage n'est listé que comme
 * conteneur, pour naviguer jusqu'à un descendant auquel on a réellement
 * accès (cf. api/discovery.py côté backend, décision de sécurité
 * documentée) — aucun champ au-delà de name/owner_username/children n'est
 * renvoyé pour lui, et tenter d'y accéder (GET /api/files/<name>/) échoue
 * en 403 (le backend n'accorde jamais de droit via la hiérarchie).
 */
export interface ShareTreeNode {
  name: string;
  owner_username: string;
  accessible: boolean;
  access?: ShareAccessReason;
  can_write?: boolean;
  required_groups?: string;
  created_at?: string;
  children: ShareTreeNode[];
}

export interface SharesResponse {
  owned: Share[];
  member_of: Share[];
  tree: ShareTreeNode[];
}

export interface StoredFile {
  namespace: string;
  relative_path: string;
  size: number;
  content_type: string;
  uploaded_by_email: string;
  created_at: string;
  updated_at: string;
}

/** Encode chaque segment d'un chemin logique sans toucher aux '/' séparateurs
 * (le backend les attend tels quels : Django path converter <path:...>). */
function encodePath(relativePath: string): string {
  return relativePath.split('/').map(encodeURIComponent).join('/');
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  private get base(): string {
    return (window as unknown as EnvWindow).__env?.apiUrl
      ?? 'http://localhost:8093';
  }

  /** Taille maximale d'un fichier, connue avant l'envoi pour refuser tout de suite. */
  get maxUploadBytes(): number {
    const v = Number((window as unknown as EnvWindow).__env?.maxUploadBytes);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_UPLOAD_BYTES;
  }

  /**
   * Suppression qui survit à la fermeture de l'onglet (`keepalive`) : HttpClient
   * est annulé quand la page se décharge, fetch+keepalive ne l'est pas. Sert
   * uniquement à valider une suppression en attente d'annulation au moment où
   * l'utilisateur quitte la page — voir BrowserStore.flushPendingDelete().
   */
  deleteFileOnUnload(namespace: string, relativePath: string, token: string): void {
    const url = `${this.base}/api/files/${encodeURIComponent(namespace)}/content/${encodePath(relativePath)}`;
    try {
      void fetch(url, { method: 'DELETE', keepalive: true, headers: { Authorization: `Bearer ${token}` } })
        .catch(() => undefined);
    } catch { /* page déjà déchargée : rien à faire */ }
  }

  getMe(): Observable<Me> {
    return this.http.get<Me>(`${this.base}/api/me/`);
  }

  getShares(): Observable<SharesResponse> {
    return this.http.get<SharesResponse>(`${this.base}/api/shares/`);
  }

  createShare(name: string, parent?: string | null): Observable<Share> {
    return this.http.post<Share>(`${this.base}/api/shares/`, { name, parent: parent || undefined });
  }

  deleteShare(name: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/shares/${encodeURIComponent(name)}/`);
  }

  /** Rattache (nom d'un partage possédé) ou détache (null) un partage dans
   * la hiérarchie. Propriétaire uniquement ; le backend vérifie que le
   * nouveau parent appartient au même propriétaire et qu'aucun cycle n'est créé. */
  setShareParent(name: string, parent: string | null): Observable<Share> {
    return this.http.patch<Share>(
      `${this.base}/api/shares/${encodeURIComponent(name)}/`,
      { parent: parent ?? '' },
    );
  }

  getShareMembers(name: string): Observable<ShareMember[]> {
    return this.http.get<ShareMember[]>(`${this.base}/api/shares/${encodeURIComponent(name)}/members/`);
  }

  addShareMember(name: string, memberEmail: string, role: ShareMemberRole = 'read'): Observable<ShareMember> {
    return this.http.post<ShareMember>(
      `${this.base}/api/shares/${encodeURIComponent(name)}/members/`,
      { member_email: memberEmail, role },
    );
  }

  removeShareMember(name: string, memberEmail: string): Observable<void> {
    return this.http.delete<void>(
      `${this.base}/api/shares/${encodeURIComponent(name)}/members/${encodeURIComponent(memberEmail)}/`,
    );
  }

  listFiles(namespace: string, prefix?: string): Observable<StoredFile[]> {
    const url = `${this.base}/api/files/${encodeURIComponent(namespace)}/`;
    return this.http.get<StoredFile[]>(url, {
      params: prefix ? { prefix } : {},
    });
  }

  /** Upload avec progression : à combiner avec HttpEventType côté appelant. */
  uploadFile(namespace: string, relativePath: string, file: File): Observable<HttpEvent<StoredFile>> {
    const form = new FormData();
    form.append('relative_path', relativePath);
    form.append('file', file);
    const req = new HttpRequest(
      'POST',
      `${this.base}/api/files/${encodeURIComponent(namespace)}/`,
      form,
      { reportProgress: true },
    );
    return this.http.request<StoredFile>(req);
  }

  deleteFile(namespace: string, relativePath: string): Observable<void> {
    const url = `${this.base}/api/files/${encodeURIComponent(namespace)}/content/${encodePath(relativePath)}`;
    return this.http.delete<void>(url);
  }

  /** URL de téléchargement — nécessite le header Authorization (posé par
   * authInterceptor), donc jamais utilisée directement dans un <a href>,
   * seulement via downloadFile() qui récupère le blob en XHR authentifié. */
  downloadFile(namespace: string, relativePath: string): Observable<Blob> {
    const url = `${this.base}/api/files/${encodeURIComponent(namespace)}/content/${encodePath(relativePath)}`;
    return this.http.get(url, { responseType: 'blob' });
  }
}
