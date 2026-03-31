import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatToolbarModule } from '@angular/material/toolbar';
import { BrandLockupComponent } from './brand-lockup/brand-lockup.component';
import { ToolbarShellComponent } from './toolbar-shell/toolbar-shell.component';

@NgModule({
  declarations: [BrandLockupComponent, ToolbarShellComponent],
  imports: [CommonModule, MatToolbarModule],
  exports: [BrandLockupComponent, ToolbarShellComponent],
})
export class UiModule {}
