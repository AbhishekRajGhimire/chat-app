export interface Reaction { emoji: string; count: number; mine: boolean; }
export interface Attachment { id: number; filename: string; mime: string; size: number; kind: 'image' | 'file'; }
export interface PendingAttachment {
  localId: string; file: File; status: 'uploading' | 'done' | 'failed'; progress: number; attachment?: Attachment;
}
export interface Message {
  id?: string;
  from: string;
  to: string;
  message: string;
  datetime: any;
  status?: 'sending' | 'sent' | 'failed';
  reactions?: Reaction[];
  replyTo?: string | null;
  replyPreview?: string | null;
  editedAt?: string | null;
  deleted?: boolean;
  attachments?: Attachment[];
  senderAvatarUrl?: string | null;
}
export interface ReadRow { username: string; last_read_at: string | null; }
