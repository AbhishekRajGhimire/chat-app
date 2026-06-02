export interface Reaction { emoji: string; count: number; mine: boolean; }
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
}
export interface ReadRow { username: string; last_read_at: string | null; }
