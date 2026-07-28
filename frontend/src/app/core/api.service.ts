import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpEvent, HttpRequest } from '@angular/common/http';
import { Observable } from 'rxjs';

interface EnvWindow {
  __env?: { apiUrl?: string };
}

export interface Me {
  email: string;
  username: string;
  groups: string[];
}

export interface Share {
  name: string;
  owner_username: string;
  required_groups: string;
  created_at: string;
}

export type ShareMemberRole = 'read' | 'write';

export interface ShareMember {
  member_email: string;
  role: ShareMemberRole;
  added_at: string;
}

export interface SharesResponse {
  owned: Share[];
  member_of: Share[];
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

  getMe(): Observable<Me> {
    return this.http.get<Me>(`${this.base}/api/me/`);
  }

  getShares(): Observable<SharesResponse> {
    return this.http.get<SharesResponse>(`${this.base}/api/shares/`);
  }

  createShare(name: string): Observable<Share> {
    return this.http.post<Share>(`${this.base}/api/shares/`, { name });
  }

  deleteShare(name: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/shares/${encodeURIComponent(name)}/`);
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
