import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ApiService, Share, ShareMember, ShareMemberRole } from '../../../core/api.service';
import { BrowserStore, extractError } from '../browser.store';

/** Gestion du partage courant (propriétaire seulement) : membres, emplacement, suppression. */
@Component({
  selector: 'app-share-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './share-panel.component.html',
  styleUrl: './share-panel.component.scss',
})
export class SharePanelComponent implements OnInit {
  protected store = inject(BrowserStore);
  private api = inject(ApiService);

  protected members = signal<ShareMember[]>([]);
  protected newMemberEmail = '';
  protected newMemberWriteAccess = false;
  protected memberError = signal<string | null>(null);

  protected moving = signal(false);
  protected newParentName = '';
  protected moveError = signal<string | null>(null);

  ngOnInit(): void {
    this.api.getShareMembers(this.store.namespace()).subscribe(members => this.members.set(members));
  }

  protected toggleMove(): void {
    const next = !this.moving();
    this.moving.set(next);
    this.moveError.set(null);
    if (next) this.newParentName = this.store.currentShare()?.parent ?? '';
  }

  protected submitMove(): void {
    const parent = this.newParentName.trim().toLowerCase() || null;
    this.moveError.set(null);
    this.api.setShareParent(this.store.namespace(), parent).subscribe({
      next: () => { this.store.refreshShares(); this.moving.set(false); },
      error: err => this.moveError.set(extractError(err)),
    });
  }

  protected submitAddMember(): void {
    const email = this.newMemberEmail.trim().toLowerCase();
    if (!email) return;
    this.memberError.set(null);
    const role: ShareMemberRole = this.newMemberWriteAccess ? 'write' : 'read';
    this.api.addShareMember(this.store.namespace(), email, role).subscribe({
      next: member => {
        this.members.update(list => [...list.filter(m => m.member_email !== member.member_email), member]);
        this.newMemberEmail = '';
        this.newMemberWriteAccess = false;
      },
      error: err => this.memberError.set(extractError(err)),
    });
  }

  protected removeMember(email: string): void {
    this.api.removeShareMember(this.store.namespace(), email).subscribe(() => {
      this.members.update(list => list.filter(m => m.member_email !== email));
    });
  }

  protected confirmDeleteShare(): void {
    const name = this.store.namespace();
    if (!confirm(`Supprimer définitivement le partage « ${name} » et tous ses fichiers ?`)) return;
    this.api.deleteShare(name).subscribe({
      next: () => { this.store.refreshShares(); this.store.goTo(this.store.me()!.username); },
      // Le backend refuse (400) tant que le partage a des enfants.
      error: err => this.store.notice.set(extractError(err)),
    });
  }

  /** Parents possibles : mes partages, hors celui-ci et sa descendance (le backend refuserait un cycle). */
  protected parentOptions(): Share[] {
    const owned = this.store.shares()?.owned ?? [];
    const excluded = new Set<string>([this.store.namespace()]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of owned) {
        if (s.parent && excluded.has(s.parent) && !excluded.has(s.name)) { excluded.add(s.name); grew = true; }
      }
    }
    return owned.filter(s => !excluded.has(s.name));
  }
}
