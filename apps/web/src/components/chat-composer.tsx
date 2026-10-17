'use client';

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowUp, LoaderCircle } from 'lucide-react';
import styles from './chat-composer.module.css';

type ChatComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void | Promise<void>;
  label: string;
  placeholder?: string;
  sendLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  maxLength?: number;
  inputId?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  actions?: ReactNode;
  showCount?: boolean;
};

export function ChatComposer({ value, onChange, onSend, label, placeholder = '', sendLabel = '메시지 보내기', busy = false, disabled = false, maxLength, inputId, textareaRef, actions, showCount = false }: ChatComposerProps) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const input = textareaRef || internalRef;
  const composing = useRef(false);
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  const unavailable = disabled || busy || pending;

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = '40px';
    element.style.height = `${Math.min(128, Math.max(40, element.scrollHeight))}px`;
  }, [value, input]);

  async function submit() {
    if (!value.trim() || unavailable || sending.current || composing.current) return;
    sending.current = true;
    setPending(true);
    try {
      await onSend();
    } finally {
      sending.current = false;
      setPending(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  }

  return <div className={styles.composer} data-chat-composer>
    <form className={styles.shell} aria-label={label} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <textarea
        ref={input}
        id={inputId}
        className={styles.input}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={event => onChange(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return;
          event.preventDefault();
          void submit();
        }}
        disabled={unavailable}
        maxLength={maxLength}
        rows={1}
      />
      <button type="submit" className={styles.send} disabled={!value.trim() || unavailable} aria-busy={busy || pending} aria-label={busy || pending ? '전송 중' : sendLabel} title={busy || pending ? '전송 중' : sendLabel}>
        {busy || pending ? <LoaderCircle size={20} className="spin" aria-hidden="true" /> : <ArrowUp size={20} strokeWidth={2.4} aria-hidden="true" />}
      </button>
    </form>
    <div className={styles.tools}>
      {actions && <div className={styles.actions}>{actions}</div>}
      <div className={styles.helper}>{showCount && <span>{value.length.toLocaleString()}자</span>}<span className={styles.keyboard}>Enter로 전송 · Shift+Enter로 줄바꿈</span></div>
    </div>
  </div>;
}
