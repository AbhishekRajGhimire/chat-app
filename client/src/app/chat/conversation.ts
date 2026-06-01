/** A sidebar conversation — a DM (keyed by peer username) or a group (keyed by id). */
export interface ConversationEntry {
  kind: 'direct' | 'group';
  /** Stable routing key: the peer username (direct) or `conv:<id>` (group). */
  key: string;
  displayName: string;
  /** Direct only: the peer's username. */
  username?: string;
  /** Group only. */
  conversationId?: number;
  memberCount?: number;
  last_message?: string | null;
  last_message_at?: string | null;
  unreadCount?: number;
}

/** Raw entry shape returned by GET /api/chats_history (DMs + groups). */
export interface RawConversation {
  kind: 'direct' | 'group';
  username?: string;
  display_name?: string;
  conversation_id?: number;
  title?: string;
  member_count?: number;
  last_message?: string | null;
  last_message_at?: string | null;
}

export function toEntry(raw: RawConversation): ConversationEntry {
  if (raw.kind === 'group') {
    return {
      kind: 'group',
      key: `conv:${raw.conversation_id}`,
      displayName: raw.title || 'Group',
      conversationId: raw.conversation_id,
      memberCount: raw.member_count,
      last_message: raw.last_message ?? null,
      last_message_at: raw.last_message_at ?? null,
      unreadCount: 0,
    };
  }
  return {
    kind: 'direct',
    key: raw.username || '',
    displayName: raw.display_name || raw.username || '',
    username: raw.username,
    last_message: raw.last_message ?? null,
    last_message_at: raw.last_message_at ?? null,
    unreadCount: 0,
  };
}
