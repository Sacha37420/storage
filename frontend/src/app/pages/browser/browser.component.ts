import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { catchError, of } from 'rxjs';

import { ApiService, Me, Share, SharesResponse, ShareMember, ShareMemberRole, StoredFile } from '../../core/api.service';

function extractError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error;
    if (typeof body === 'string') return body;
    if (body && typeof body === 'object') {
      const first = Object.values(body as Record<string, unknown>)[0];
      if (Array.isArray(first)) return String(first[0]);
      if (typeof first === 'string') return first;
      if (body.detail) return String(body.detail);
    }
    return `Erreur ${err.status}`;
  }
  return 'Erreur inattendue.';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

@Component({
  selector: 'app-browser',
  standalone: true,
  imports: [DatePipe, FormsModule],
  templateUrl: './browser.component.html',
  styleUrl: './browser.component.scss',
})
export class BrowserComponent {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  readonly formatSize = formatSize;

  me = signal<Me | null>(null);
  shares = signal<SharesResponse | null>(null);

  namespace = signal<string>('');
  pathPrefix = signal<string>(''); // sans '/' final ; '' = racine du namespace
  allFiles = signal<StoredFile[]>([]);

  loading = signal(true);
  error = signal<string | null>(null);

  creatingShare = signal(false);
  newShareName = '';
  newShareError = signal<string | null>(null);

  managingShare = signal(false);
  members = signal<ShareMember[]>([]);
  newMemberEmail = '';
  newMemberWriteAccess = false;
  memberError = signal<string | null>(null);

  uploading = signal(false);
  uploadProgress = signal(0);
  dragOver = signal(false);

  private prefixWithSlash = computed(() => {
    const p = this.pathPrefix();
    return p ? `${p}/` : '';
  });

  breadcrumbSegments = computed<string[]>(() => {
    const p = this.pathPrefix();
    return p ? p.split('/') : [];
  });

  folders = computed<string[]>(() => {
    const prefix = this.prefixWithSlash();
    const set = new Set<string>();
    for (const f of this.allFiles()) {
      if (!f.relative_path.startsWith(prefix)) continue;
      const rest = f.relative_path.slice(prefix.length);
      const idx = rest.indexOf('/');
      if (idx !== -1) set.add(rest.slice(0, idx));
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  });

  files = computed<StoredFile[]>(() => {
    const prefix = this.prefixWithSlash();
    return this.allFiles()
      .filter(f => f.relative_path.startsWith(prefix) && !f.relative_path.slice(prefix.length).includes('/'))
      .sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  });

  canWrite = computed<boolean>(() => {
    const me = this.me();
    const ns = this.namespace();
    if (!me || !ns) return false;
    if (ns === me.username) return true;
    return (this.shares()?.owned ?? []).some(s => s.name === ns);
  });

  isOwnedShare = computed<boolean>(() => {
    const ns = this.namespace();
    return (this.shares()?.owned ?? []).some(s => s.name === ns);
  });

  currentShare = computed<Share | null>(() => {
    const ns = this.namespace();
    const all = this.shares();
    return all?.owned.find(s => s.name === ns) ?? all?.member_of.find(s => s.name === ns) ?? null;
  });

  constructor() {
    this.api.getMe()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(me => {
        this.me.set(me);
        this.refreshShares();
      });

    this.route.url
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(segments => {
        const parts = segments.map(s => s.path);
        const ns = parts[0] || this.me()?.username || '';
        this.namespace.set(ns);
        this.pathPrefix.set(parts.slice(1).join('/'));
        this.managingShare.set(false);
        if (ns) this.loadNamespace(ns);
      });
  }

  private refreshShares(): void {
    this.api.getShares()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(shares => {
        this.shares.set(shares);
        // Le premier chargement de /api/me/ peut précéder la résolution de
        // route côté SPA : si aucun namespace n'est encore fixé (arrivée sur
        // '/'), on retombe maintenant sur son propre espace personnel.
        if (!this.namespace()) this.goToNamespace(this.me()!.username);
      });
  }

  private loadNamespace(namespace: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.listFiles(namespace)
      .pipe(
        catchError((err: HttpErrorResponse) => {
          this.error.set(extractError(err));
          return of<StoredFile[]>([]);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(files => {
        this.allFiles.set(files);
        this.loading.set(false);
      });
  }

  goToNamespace(namespace: string): void {
    this.router.navigate(['/', namespace]);
  }

  openFolder(folder: string): void {
    const segments = this.pathPrefix() ? [...this.breadcrumbSegments(), folder] : [folder];
    this.router.navigate(['/', this.namespace(), ...segments]);
  }

  goToBreadcrumb(index: number): void {
    // index = -1 → racine du namespace
    const segments = this.breadcrumbSegments().slice(0, index + 1);
    this.router.navigate(['/', this.namespace(), ...segments]);
  }

  fileName(f: StoredFile): string {
    return f.relative_path.slice(this.prefixWithSlash().length);
  }

  // ── Partages ────────────────────────────────────────────────────────────

  submitNewShare(): void {
    const name = this.newShareName.trim().toLowerCase();
    if (!name) return;
    this.newShareError.set(null);
    this.api.createShare(name).subscribe({
      next: share => {
        this.shares.update(s => s && { ...s, owned: [...s.owned, share] });
        this.newShareName = '';
        this.creatingShare.set(false);
        this.goToNamespace(share.name);
      },
      error: err => this.newShareError.set(extractError(err)),
    });
  }

  toggleManageShare(): void {
    const next = !this.managingShare();
    this.managingShare.set(next);
    if (next) this.loadMembers();
  }

  private loadMembers(): void {
    this.api.getShareMembers(this.namespace()).subscribe(members => this.members.set(members));
  }

  submitAddMember(): void {
    const email = this.newMemberEmail.trim().toLowerCase();
    if (!email) return;
    this.memberError.set(null);
    const role: ShareMemberRole = this.newMemberWriteAccess ? 'write' : 'read';
    this.api.addShareMember(this.namespace(), email, role).subscribe({
      next: member => {
        this.members.update(list => [...list.filter(m => m.member_email !== member.member_email), member]);
        this.newMemberEmail = '';
        this.newMemberWriteAccess = false;
      },
      error: err => this.memberError.set(extractError(err)),
    });
  }

  removeMember(email: string): void {
    this.api.removeShareMember(this.namespace(), email).subscribe(() => {
      this.members.update(list => list.filter(m => m.member_email !== email));
    });
  }

  confirmDeleteShare(): void {
    const name = this.namespace();
    if (!confirm(`Supprimer définitivement le partage « ${name} » et tous ses fichiers ?`)) return;
    this.api.deleteShare(name).subscribe(() => {
      this.shares.update(s => s && { ...s, owned: s.owned.filter(sh => sh.name !== name) });
      this.goToNamespace(this.me()!.username);
    });
  }

  // ── Fichiers ────────────────────────────────────────────────────────────

  onFilePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) this.uploadFiles(input.files);
    input.value = '';
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(true);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(false);
    if (event.dataTransfer?.files?.length) this.uploadFiles(event.dataTransfer.files);
  }

  private uploadFiles(fileList: FileList): void {
    const files = Array.from(fileList);
    const namespace = this.namespace();
    const prefix = this.prefixWithSlash();
    this.uploading.set(true);
    this.uploadProgress.set(0);

    const uploadNext = (index: number): void => {
      if (index >= files.length) {
        this.uploading.set(false);
        this.loadNamespace(namespace);
        return;
      }
      const file = files[index];
      this.api.uploadFile(namespace, `${prefix}${file.name}`, file).subscribe({
        next: event => {
          if (event.type === HttpEventType.UploadProgress && event.total) {
            this.uploadProgress.set(Math.round((100 * event.loaded) / event.total));
          } else if (event.type === HttpEventType.Response) {
            uploadNext(index + 1);
          }
        },
        error: err => {
          this.error.set(extractError(err));
          this.uploading.set(false);
        },
      });
    };
    uploadNext(0);
  }

  download(f: StoredFile): void {
    this.api.downloadFile(f.namespace, f.relative_path).subscribe(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = this.fileName(f);
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  removeFile(f: StoredFile): void {
    if (!confirm(`Supprimer « ${this.fileName(f)} » ?`)) return;
    this.api.deleteFile(f.namespace, f.relative_path).subscribe(() => {
      this.allFiles.update(list => list.filter(x => x.relative_path !== f.relative_path));
    });
  }
}
