'use client';
import {ownedClassName} from './owned-class-name';


import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import gsap from 'gsap';
import { ArrowRight, Eye, EyeOff, LoaderCircle, ChevronLeft } from 'lucide-react';
import { Logo, Alert, FloatingNotice, post } from './shared';
import { socialErrors, socialNext, type SocialProvider } from '@/lib/social-auth-rules';
import socialStyles from './social-auth.module.css';
import { LoginIntroSheet } from './login-intro-sheet';
import {PublicLinks} from './public-links';
import {trackEvent} from '@/lib/analytics';

export function AuthScreen({ mode = 'login' }: { mode?: 'login' | 'signup' | 'invite' | 'reset-password' }) {
  const router = useRouter();
  const art = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [focused, setFocused] = useState('');
  const [canSetPassword, setCanSetPassword] = useState(false);
  const [providers, setProviders] = useState({ google: false, kakao: false });

  useEffect(() => {
    setReady(true);
    const issue = new URLSearchParams(window.location.search).get('error');
    if (issue && socialErrors[issue]) setError(socialErrors[issue]);
    postAuthState();
    async function postAuthState() {
      try {
        const result = await fetch('/api/auth').then(response => response.json());
        setCanSetPassword(!!result.canSetPassword);
        setProviders({ google: result.providers?.google === true, kakao: result.providers?.kakao === true });
      } catch {}
    }
  }, [mode]);

  useEffect(() => {
    const media = gsap.matchMedia();
    const ctx = gsap.context(() => {
      media.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.from('.auth-center-mark', { y: 28, opacity: 0, duration: .55, ease: 'power3.out' });
        gsap.from('.auth-form > *', { opacity: 0, y: 13, stagger: .04, duration: .4, ease: 'power3.out' });
      });
    }, art);
    return () => { media.revert(); ctx.revert(); };
  }, [mode]);

  useEffect(() => {
    if (mode !== 'login' || !art.current) return;
    const logos = art.current.querySelectorAll('.login-art-logo');
    gsap.set(logos, { rotation: 0, transformOrigin: '50% 50%' });
    // The mark keeps its clockwise rhythm independently of field focus.
    const media=gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)',()=>{
      gsap.to(logos,{rotation:360,duration:18,repeat:-1,ease:'none'});
    });
    return()=>{media.revert();gsap.killTweensOf(logos);};
  }, [mode]);

  useEffect(() => {
    if (!art.current) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const attention = art.current.querySelectorAll('.auth-logo-attention, .auth-mobile-mark');
    const reaction = art.current.querySelector('.art-bottom');
    gsap.to(attention, { x: reduced ? 0 : focused === 'email' ? 7 : focused === 'password' ? 3 : 0, y: reduced ? 0 : busy ? -10 : focused === 'password' && !show ? -6 : 0, duration: reduced ? 0 : .2, ease: 'power3.out', overwrite: 'auto' });
    if (!reduced && reaction) gsap.fromTo(reaction, { y: 5, opacity: .45 }, { y: 0, opacity: 1, duration: .2, ease: 'power3.out', overwrite: 'auto' });
    return () => {
      gsap.killTweensOf(attention, 'x,y');
      if (reaction) gsap.killTweensOf(reaction, 'y,opacity');
    };
  }, [focused, show, busy]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy || mode === 'signup') return;
    if(mode==='login')trackEvent('cta_start_click',{placement:'hero'});
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const result = await post('/api/auth', {
        action: mode === 'login' ? 'login' : canSetPassword ? 'set_password' : mode === 'invite' ? 'accept_invite' : 'reset_password',
        email,
        password,
      });
      if (mode === 'login' || result.user) {
        const next = new URLSearchParams(window.location.search).get('next');
        router.push(socialNext(next, result.user?.role || 'student'));
        router.refresh();
      } else {
        setNotice(result.message || '메일을 확인해 주세요.');
      }
    } catch (err) {
      setError((err as Error).message);
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const form = art.current?.querySelector('.auth-form');
        if (form) gsap.fromTo(form, { x: -5 }, { x: 0, duration: .25, ease: 'elastic.out(1,.2)' });
      }
    } finally {
      setBusy(false);
    }
  }

  function socialSignIn(provider: SocialProvider) {
    if (busy) return;
    setNotice('');
    if (!providers[provider]) { setError(socialErrors[`${provider}_not_configured`]); return; }
    trackEvent('cta_start_click',{placement:'hero'});
    setError(''); setBusy(true);
    const next = socialNext(new URLSearchParams(window.location.search).get('next'));
    window.location.assign(`/api/auth/${provider}/start?next=${encodeURIComponent(next)}`);
  }


  const keepsSecret = mode === 'login' && focused === 'password' && !show;
  const heading = mode === 'login' || mode === 'signup' ? '나만의 답을 시작해요.' : mode === 'invite' ? '나의 답을 시작해요.' : '비밀번호 재설정';
  const intro = mode === 'login' ? '내 기록에서 시작하는 나만의 면접 준비.' : mode === 'signup' ? '편한 계정으로 시작하세요.' : canSetPassword ? '새 비밀번호를 정해 주세요.' : mode === 'invite' ? '초대 메일의 계정 연결 링크를 열어주세요.' : '가입한 이메일을 입력하세요.';

  return <><main className={ownedClassName('auth-page auth-centered' + (keepsSecret ? ' auth-keeps-secret' : ''),true)} ref={art}>
    <header className={ownedClassName("auth-entry-header",true)}>
      <Link href="/" className={ownedClassName("auth-entry-brand")} aria-label="각자의답 홈"><Logo size={48}/></Link>
      {mode !== 'login' && <Link href="/login" className={ownedClassName("auth-entry-back")}><ChevronLeft size={16}/>로그인으로</Link>}
    </header>
    <div className={ownedClassName("auth-entry-decoration",true)} aria-hidden="true">
      <img className={ownedClassName("auth-outline-left",true)} src="/auth/brand-outline.svg" alt=""/>
      <img className={ownedClassName("auth-smile-left",true)} src="/auth/brand-smile.svg" alt=""/>
      <img className={ownedClassName("auth-outline-top",true)} src="/auth/brand-outline.svg" alt=""/>
      <img className={ownedClassName("auth-outline-right",true)} src="/auth/brand-outline.svg" alt=""/>
    </div>
    <section className={ownedClassName("auth-center-main",true)} aria-labelledby="auth-title">
      <form id="auth-form" className={ownedClassName("auth-form",true)} method="post" aria-busy={!ready || busy} onSubmit={submit}>
        <div className={ownedClassName("auth-center-mark",true)}>
          <div className={ownedClassName("auth-logo-attention",true)}><img className={ownedClassName("login-art-logo",true)} src="/brand-logo.svg" alt="" width={82} height={82}/><span className={ownedClassName("auth-privacy-cue",true)} aria-hidden="true"><EyeOff size={20} strokeWidth={1.6}/></span></div>
        </div>
        <div className={ownedClassName("auth-center-intro",true)}><h1 id="auth-title" tabIndex={-1} style={{scrollMarginTop:24,outline:'none'}} className={ownedClassName(undefined,true)}>{heading}</h1><p className={ownedClassName("auth-intro",true)}>{intro}</p></div>
        {error && <Alert>{error}</Alert>}
        {notice && <FloatingNotice onDismiss={()=>setNotice('')}>{notice}</FloatingNotice>}
        {(mode === 'login' || mode === 'signup') && <>
          <div className={ownedClassName(socialStyles.buttons,true)}>
            <button type="button" disabled={busy} onClick={()=>socialSignIn('kakao')} className={ownedClassName(socialStyles.provider+' '+socialStyles.kakao,true)}><img src="/auth/kakao.svg" alt="" width={24} height={24} className={ownedClassName(undefined,true)}/>카카오로 시작</button>
            <button type="button" disabled={busy} onClick={()=>socialSignIn('google')} className={ownedClassName(socialStyles.provider+' '+socialStyles.google,true)}><img src="/auth/google.svg" alt="" width={24} height={24} className={ownedClassName(undefined,true)}/>Google로 시작</button>
          </div>
          {mode === 'login' && <div className={ownedClassName(socialStyles.divider,true)}>또는 이메일로 로그인</div>}
        </>}
        {(mode==='login'||!canSetPassword) && mode !== 'signup' && <div className={ownedClassName("auth-field",true)}><label htmlFor="auth-email" className={ownedClassName(undefined,true)}>이메일</label><input id="auth-email" type="email" name="email" autoComplete="email" placeholder="이메일 주소를 입력해 주세요" value={email} onChange={event=>setEmail(event.target.value)} onFocus={()=>setFocused('email')} onBlur={()=>setFocused('')} required className={ownedClassName(undefined,true)}/></div>}
        {(mode === 'login' || canSetPassword) && <div className={ownedClassName("auth-field",true)}><div className={ownedClassName("auth-field-heading",true)}><label htmlFor="auth-password" className={ownedClassName(undefined,true)}>비밀번호</label>{mode === 'login' && <Link href="/reset-password">비밀번호 찾기</Link>}</div><div className={ownedClassName("password-field",true)}><input id="auth-password" type={show?'text':'password'} name="password" autoComplete={mode==='login'?'current-password':'new-password'} placeholder="비밀번호를 입력해 주세요" value={password} onChange={event=>setPassword(event.target.value)} onFocus={()=>setFocused('password')} onBlur={()=>setFocused('')} required minLength={10} className={ownedClassName(undefined,true)}/><button type="button" aria-label={show?'비밀번호 숨기기':'비밀번호 표시'} onClick={()=>setShow(!show)} className={ownedClassName(undefined,true)}>{show?<EyeOff size={22}/>:<Eye size={22}/>}</button></div></div>}
        {mode !== 'signup' && <button disabled={!ready||busy||(mode==='invite'&&!canSetPassword)} className={ownedClassName("button primary auth-submit",true)}><span className={ownedClassName(undefined,true)}>{!ready?'준비하는 중':busy?'연결하는 중':mode==='login'?'로그인':canSetPassword?'비밀번호 저장':mode==='invite'?'초대 링크로 연결':'재설정 메일 보내기'}</span>{busy?<LoaderCircle size={22} className={ownedClassName("spin")}/>:<ArrowRight size={23}/>}</button>}
        <div className={ownedClassName("auth-foot",true)}>{mode==='login'?<div className={ownedClassName(socialStyles.signupFoot,true)}>아직 계정이 없으신가요? <Link href="/signup">회원가입</Link></div>:<Link href="/login">로그인으로 돌아가기</Link>}</div>
      </form>
    </section>
    <footer className={ownedClassName("auth-entry-footer",true)}><PublicLinks/>{mode==='login'&&<Link href="/invite">초대 계정 연결</Link>}<span className={ownedClassName(undefined,true)}>© {new Date().getFullYear()} 각자의답</span></footer>
  </main>{mode==='login'&&<LoginIntroSheet disabled={busy}/>}</>;
}
