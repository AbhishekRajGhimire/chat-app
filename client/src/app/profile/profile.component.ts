import { Component, OnInit } from '@angular/core';
import { UntypedFormBuilder, UntypedFormGroup, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { ProfileService, UserProfile } from '../profile.service';
import { PushService } from '../push.service';
import { MatDialog } from '@angular/material/dialog';
import { ChatApi } from '../core/chat-api.service';
import { ChatStore } from '../core/chat-store.service';
import { AvatarCropperComponent } from '../ui/avatar-cropper/avatar-cropper.component';
import { avatarSrc } from '../core/avatar-url';

@Component({
    selector: 'app-profile',
    templateUrl: './profile.component.html',
    styleUrls: ['./profile.component.scss'],
    standalone: false
})
export class ProfileComponent implements OnInit {
  form!: UntypedFormGroup;
  loading = true;
  saving = false;
  errorMessage = '';

  /** Notifications: 'unsupported' | 'denied' | 'on' | 'off'. */
  notifState: 'unsupported' | 'denied' | 'on' | 'off' = 'off';
  notifBusy = false;
  notifError = '';

  constructor(
    private fb: UntypedFormBuilder,
    private profileService: ProfileService,
    private router: Router,
    private push: PushService,
    private dialog: MatDialog,
    private api: ChatApi,
    private store: ChatStore
  ) {}

  get avatarImage(): string | null {
    return avatarSrc(this.form?.get('avatar_url')?.value);
  }

  onPickAvatar(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0]; input.value = '';
    if (!file) return;
    this.dialog.open(AvatarCropperComponent, { data: { file }, panelClass: 'rojin-dialog', autoFocus: false })
      .afterClosed().subscribe((cropped?: File) => {
        if (cropped) this.api.uploadAvatar(cropped).subscribe({
          next: (p) => { this.form.patchValue({ avatar_url: p.avatar_url ?? '' }); this.store.setMyAvatarUrl(p.avatar_url ?? null); },
        });
      });
  }

  removeAvatar(): void {
    this.api.deleteAvatar().subscribe({
      next: (p) => { this.form.patchValue({ avatar_url: p.avatar_url ?? '' }); this.store.setMyAvatarUrl(p.avatar_url ?? null); },
    });
  }

  ngOnInit(): void {
    this.refreshNotifState();
    this.form = this.fb.group({
      display_name: ['', [Validators.maxLength(120)]],
      avatar_url: ['', [Validators.maxLength(2048)]],
      bio: ['', [Validators.maxLength(2000)]],
    });

    this.profileService.getMyProfile().subscribe({
      next: (p: UserProfile) => {
        this.form.patchValue({
          display_name: p.display_name === p.username ? '' : p.display_name,
          avatar_url: p.avatar_url ?? '',
          bio: p.bio ?? '',
        });
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        if (err.status === 401 || err.status === 422) {
          this.router.navigate(['/signin']);
          return;
        }
        this.errorMessage = 'Could not load your profile.';
      },
    });
  }

  onSubmit(): void {
    if (this.form.invalid || this.saving) {
      return;
    }
    this.saving = true;
    this.errorMessage = '';
    const v = this.form.value;
    this.profileService
      .patchMyProfile({
        display_name: (v.display_name as string)?.trim() || null,
        avatar_url: (v.avatar_url as string)?.trim() || null,
        bio: (v.bio as string)?.trim() || null,
      })
      .subscribe({
        next: () => {
          this.saving = false;
          this.router.navigate(['/']);
        },
        error: (err) => {
          this.saving = false;
          if (err.status === 401 || err.status === 422) {
            this.router.navigate(['/signin']);
            return;
          }
          this.errorMessage = 'Could not save profile.';
        },
      });
  }

  cancel(): void {
    this.router.navigate(['/']);
  }

  private async refreshNotifState(): Promise<void> {
    if (!this.push.supported) {
      this.notifState = 'unsupported';
      return;
    }
    if (this.push.permission === 'denied') {
      this.notifState = 'denied';
      return;
    }
    this.notifState = (await this.push.isSubscribed()) ? 'on' : 'off';
  }

  async toggleNotifications(): Promise<void> {
    if (this.notifBusy || this.notifState === 'unsupported' || this.notifState === 'denied') {
      return;
    }
    this.notifBusy = true;
    this.notifError = '';
    try {
      if (this.notifState === 'on') {
        await this.push.disable();
      } else {
        await this.push.enable();
      }
      await this.refreshNotifState();
    } catch (e: any) {
      this.notifError = e?.message || 'Could not change notifications.';
      await this.refreshNotifState();
    } finally {
      this.notifBusy = false;
    }
  }
}
