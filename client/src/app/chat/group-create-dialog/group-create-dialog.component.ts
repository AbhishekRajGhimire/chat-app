import { Component, Inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { DirectoryUser } from '../../profile.service';

@Component({
  selector: 'app-group-create-dialog',
  templateUrl: './group-create-dialog.component.html',
  styleUrls: ['./group-create-dialog.component.scss'],
  standalone: false,
})
export class GroupCreateDialogComponent {
  title = '';
  search = '';
  selected = new Set<string>();

  constructor(
    private ref: MatDialogRef<GroupCreateDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: { users: DirectoryUser[] }
  ) {}

  get users(): DirectoryUser[] {
    const q = this.search.trim().toLowerCase();
    const all = this.data?.users ?? [];
    if (!q) return all;
    return all.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        u.display_name.toLowerCase().includes(q)
    );
  }

  toggle(username: string): void {
    if (this.selected.has(username)) this.selected.delete(username);
    else this.selected.add(username);
  }

  isSelected(username: string): boolean {
    return this.selected.has(username);
  }

  get canCreate(): boolean {
    return this.title.trim().length > 0 && this.selected.size > 0;
  }

  cancel(): void {
    this.ref.close();
  }

  create(): void {
    if (!this.canCreate) return;
    this.ref.close({
      title: this.title.trim(),
      members: Array.from(this.selected),
    });
  }
}
