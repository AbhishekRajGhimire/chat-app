import { Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { ProfileService, UserProfile } from '../../profile.service';
import { AuthService } from '../../auth.service';
import { MatDialog } from '@angular/material/dialog';
import { ChatApi } from '../../core/chat-api.service';
import { AvatarCropperComponent } from '../../ui/avatar-cropper/avatar-cropper.component';
import { avatarSrc } from '../../core/avatar-url';

@Component({
  selector: 'app-mobile-profile',
  templateUrl: './mobile-profile.component.html',
  styleUrls: ['./mobile-profile.component.scss'],
  standalone: false,
})
export class MobileProfileComponent implements OnInit {
  username = '';
  displayName = '';
  bio = '';
  avatarUrl: string | null = null;

  loading = true;
  saving = false;
  errorMessage = '';

  constructor(
    private location: Location,
    private router: Router,
    private profileService: ProfileService,
    private authService: AuthService,
    private dialog: MatDialog,
    private api: ChatApi,
  ) {}

  get avatarImage(): string | null {
    return avatarSrc(this.avatarUrl);
  }

  onPickAvatar(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0]; input.value = '';
    if (!file) return;
    this.dialog.open(AvatarCropperComponent, { data: { file }, panelClass: 'rojin-dialog', autoFocus: false })
      .afterClosed().subscribe((cropped?: File) => {
        if (cropped) this.api.uploadAvatar(cropped).subscribe({
          next: (p) => { this.avatarUrl = p.avatar_url ?? null; },
        });
      });
  }

  removeAvatar(): void {
    this.api.deleteAvatar().subscribe({
      next: (p) => { this.avatarUrl = p.avatar_url ?? null; },
    });
  }

  ngOnInit(): void {
    this.username = localStorage.getItem('username') || '';
    this.profileService.getMyProfile().subscribe({
      next: (p: UserProfile) => {
        this.displayName = p.display_name === p.username ? '' : (p.display_name || '');
        this.bio = p.bio || '';
        this.avatarUrl = p.avatar_url ?? null;
        this.loading = false;
      },
      error: (err: any) => {
        this.loading = false;
        if (err.status === 401 || err.status === 422) {
          this.router.navigate(['/signin']);
          return;
        }
        this.errorMessage = 'Could not load your profile.';
      },
    });
  }

  save(): void {
    if (this.saving) return;
    this.saving = true;
    this.errorMessage = '';
    this.profileService.patchMyProfile({
      display_name: this.displayName.trim() || null,
      bio: this.bio.trim() || null,
    }).subscribe({
      next: () => {
        this.saving = false;
        this.location.back();
      },
      error: (err: any) => {
        this.saving = false;
        if (err.status === 401 || err.status === 422) {
          this.router.navigate(['/signin']);
          return;
        }
        this.errorMessage = 'Could not save profile.';
      },
    });
  }

  goBack(): void {
    this.location.back();
  }

  logout(): void {
    this.authService.signout().subscribe(
      () => {
        localStorage.removeItem('access_token');
        localStorage.removeItem('username');
        this.router.navigate(['/signin']);
      },
      () => this.router.navigate(['/signin']),
    );
  }
}
