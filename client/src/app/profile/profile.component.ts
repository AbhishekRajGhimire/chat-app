import { Component, OnInit } from '@angular/core';
import { UntypedFormBuilder, UntypedFormGroup, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { ProfileService, UserProfile } from '../profile.service';

@Component({
  selector: 'app-profile',
  templateUrl: './profile.component.html',
  styleUrls: ['./profile.component.scss'],
})
export class ProfileComponent implements OnInit {
  form!: UntypedFormGroup;
  loading = true;
  saving = false;
  errorMessage = '';

  constructor(
    private fb: UntypedFormBuilder,
    private profileService: ProfileService,
    private router: Router
  ) {}

  ngOnInit(): void {
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
}
