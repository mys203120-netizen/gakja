'use client';
import {ownedClassName} from './owned-class-name';


import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowUp, LoaderCircle } from 'lucide-react';
import {resetEnterSequence,sendOnEnter} from '@/lib/client/enter-send';
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
  variant?: 'default' | 'conversation';
  enterToSend?: boolean;
};

export function ChatComposer({ value, onChange, onSend, label, placeholder = '', sendLabel = '메시지 보내기', busy = false, disabled = false, maxLength, inputId, textareaRef, actions, showCount = false, variant = 'default', enterToSend = true }: ChatComposerProps) {
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

  return <div className={ownedClassName(`${styles.composer} ${variant === 'conversation' ? styles.conversation : ''}`,true)} data-chat-composer>
    <form className={ownedClassName(styles.shell,true)} aria-label={label} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <textarea
        ref={input}
        id={inputId}
        className={ownedClassName(styles.input,true)}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={event => onChange(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {sendOnEnter(event,enterToSend,submit,{composing:composing.current,blocked:unavailable});}}
        onBlur={event=>resetEnterSequence(event.currentTarget)}
        disabled={unavailable}
        maxLength={maxLength}
        rows={1}
      />
      {variant === 'conversation' && <div className={ownedClassName(styles.inlineActions,true)}>{actions}{showCount && <span className={ownedClassName(styles.count,true)}>{value.length.toLocaleString()}자</span>}</div>}
      <button type="submit" className={ownedClassName(styles.send,true)} disabled={!value.trim() || unavailable} aria-busy={busy || pending} aria-label={busy || pending ? '전송 중' : sendLabel} title={busy || pending ? '전송 중' : sendLabel}>
        {busy || pending ? <LoaderCircle size={20} className={ownedClassName("spin")} aria-hidden="true" /> : <ArrowUp size={20} strokeWidth={2.4} aria-hidden="true" />}
      </button>
    </form>
    {variant !== 'conversation' && <div className={ownedClassName(styles.tools,true)}>
      {actions && <div className={ownedClassName(styles.actions,true)}>{actions}</div>}
      <div className={ownedClassName(styles.helper,true)}>{showCount && <span className={ownedClassName(undefined,true)}>{value.length.toLocaleString()}자</span>}<span className={ownedClassName(styles.keyboard,true)}>{enterToSend?'Enter로 전송 · Shift+Enter로 줄바꿈':'Enter로 줄바꿈 · 연속 두 번 누르면 전송'}</span></div>
    </div>}
  </div>;
}
