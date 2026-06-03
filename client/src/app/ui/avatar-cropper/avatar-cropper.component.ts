import { Component, ElementRef, Inject, OnDestroy, ViewChild } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

@Component({
  selector: 'app-avatar-cropper',
  templateUrl: './avatar-cropper.component.html',
  styleUrls: ['./avatar-cropper.component.scss'],
  standalone: false,
})
export class AvatarCropperComponent implements OnDestroy {
  @ViewChild('view', { static: true }) view!: ElementRef<HTMLDivElement>;
  private bitmap?: ImageBitmap;
  private objUrl = '';
  readonly VIEW = 260;                       // circular viewport px
  baseScale = 1; zoom = 1; tx = 0; ty = 0;   // image transform within the viewport
  ready = false;
  private dragging = false; private lastX = 0; private lastY = 0;

  constructor(private ref: MatDialogRef<AvatarCropperComponent, File>,
              @Inject(MAT_DIALOG_DATA) public data: { file: File }) {
    this.objUrl = URL.createObjectURL(data.file);
    this.load(data.file);
  }

  ngOnDestroy(): void { if (this.objUrl) URL.revokeObjectURL(this.objUrl); }

  private async load(file: File): Promise<void> {
    try {
      // imageOrientation:'from-image' applies EXIF so portraits aren't sideways.
      this.bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as any);
    } catch {
      this.bitmap = await createImageBitmap(file);   // fallback if option unsupported
    }
    this.baseScale = this.VIEW / Math.min(this.bitmap.width, this.bitmap.height);  // cover
    this.zoom = 1; this.tx = 0; this.ty = 0; this.ready = true;
  }

  get scale(): number { return this.baseScale * this.zoom; }
  get imgSrc(): string { return this.objUrl; }
  get imgStyle() {
    if (!this.bitmap) return {};
    const w = this.bitmap.width * this.scale, h = this.bitmap.height * this.scale;
    // image is center-anchored (left/top 50% in CSS); compose the pan on top.
    return { width: `${w}px`, height: `${h}px`,
             transform: `translate(calc(-50% + ${this.tx}px), calc(-50% + ${this.ty}px))` };
  }

  onPointerDown(e: PointerEvent) {
    this.dragging = true; this.lastX = e.clientX; this.lastY = e.clientY;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  onPointerMove(e: PointerEvent) {
    if (!this.dragging) return;
    this.tx += e.clientX - this.lastX; this.ty += e.clientY - this.lastY;
    this.lastX = e.clientX; this.lastY = e.clientY; this.clamp();
  }
  onPointerUp() { this.dragging = false; }
  onZoomInput(v: number) { this.zoom = v; this.clamp(); }
  onWheel(e: WheelEvent) {
    e.preventDefault();
    this.zoom = Math.min(4, Math.max(1, this.zoom * (e.deltaY < 0 ? 1.08 : 0.92)));
    this.clamp();
  }

  private clamp(): void {
    if (!this.bitmap) return;
    const w = this.bitmap.width * this.scale, h = this.bitmap.height * this.scale;
    const maxX = Math.max(0, (w - this.VIEW) / 2), maxY = Math.max(0, (h - this.VIEW) / 2);
    this.tx = Math.min(maxX, Math.max(-maxX, this.tx));
    this.ty = Math.min(maxY, Math.max(-maxY, this.ty));
  }

  cancel(): void { this.ref.close(undefined); }

  save(): void {
    if (!this.bitmap) return;
    const OUT = 512;
    const canvas = document.createElement('canvas');
    canvas.width = OUT; canvas.height = OUT;
    const ctx = canvas.getContext('2d')!;
    const srcSize = this.VIEW / this.scale;                 // source px shown across the viewport
    const cx = this.bitmap.width / 2 - this.tx / this.scale; // center of the viewport in source px
    const cy = this.bitmap.height / 2 - this.ty / this.scale;
    ctx.drawImage(this.bitmap, cx - srcSize / 2, cy - srcSize / 2, srcSize, srcSize, 0, 0, OUT, OUT);
    canvas.toBlob((blob) => {
      if (blob) this.ref.close(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.9);
  }
}
