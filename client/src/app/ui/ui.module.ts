import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatDialogModule } from '@angular/material/dialog';
import { BrandLockupComponent } from './brand-lockup/brand-lockup.component';
import { ToolbarShellComponent } from './toolbar-shell/toolbar-shell.component';
import { AvatarComponent } from './avatar/avatar.component';
import { AvatarCropperComponent } from './avatar-cropper/avatar-cropper.component';

@NgModule({
  declarations: [BrandLockupComponent, ToolbarShellComponent, AvatarComponent, AvatarCropperComponent],
  imports: [CommonModule, FormsModule, MatToolbarModule, MatDialogModule],
  exports: [BrandLockupComponent, ToolbarShellComponent, AvatarComponent, AvatarCropperComponent],
})
export class UiModule {}
