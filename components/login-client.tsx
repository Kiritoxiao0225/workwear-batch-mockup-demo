'use client';

import { useEffect, useRef, useState } from 'react';
import { HOME_PAGE } from '@/lib/app-pages';

type Mode = 'login' | 'register' | 'reset' | 'setup';
class AuthRequestError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) { super(message); }
}
async function postJson(url: string, body: unknown) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  const parsed = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new AuthRequestError(typeof parsed.error === 'string' ? parsed.error : `请求失败（HTTP ${response.status}）`, typeof parsed.retryAfterSeconds === 'number' ? parsed.retryAfterSeconds : undefined);
  return parsed;
}
function PasswordField({ id, label, value, onChange, current = false, disabled = false }: {
  id: string; label: string; value: string; onChange: (value: string) => void; current?: boolean; disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return <div className="login-field"><label htmlFor={id}>{label}</label><div className="auth-password">
    <input id={id} name={id} type={visible ? 'text' : 'password'} autoComplete={current ? 'current-password' : 'new-password'}
      value={value} onChange={event => onChange(event.target.value)} required minLength={current ? 1 : 8} maxLength={256} disabled={disabled}
      placeholder={current ? '请输入密码' : '至少 8 位，建议使用字母、数字或符号'} />
    <button type="button" className="auth-eye" aria-label={`${visible ? '隐藏' : '显示'}${label}`} aria-pressed={visible} onClick={() => setVisible(!visible)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
    </button></div></div>;
}
export function LoginClient({ next, initialMode = 'login', sessionExpired = false }: { next: string; initialMode?: Mode; sessionExpired?: boolean }) {
  const [mode, setMode] = useState<Mode>(initialMode), [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState(''), [code, setCode] = useState(''), [password, setPassword] = useState(''), [confirm, setConfirm] = useState('');
  const [proof, setProof] = useState(''), [cooldown, setCooldown] = useState(0), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(sessionExpired ? '登录已失效，请使用原账号重新登录，登录后会回到刚才的页面。' : '');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null), pending = useRef(false), passwordInput = useRef<HTMLDivElement>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  useEffect(() => { if (step === 2) passwordInput.current?.querySelector('input')?.focus(); }, [step]);
  const href = (view: Mode) => `/login?mode=${view}${next === HOME_PAGE ? '' : `&next=${encodeURIComponent(next)}`}`;
  const startCooldown = (seconds: number) => {
    setCooldown(seconds); if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => setCooldown(value => { if (value <= 1 && timer.current) clearInterval(timer.current); return Math.max(0, value - 1); }), 1000);
  };
  const sendCode = async () => {
    if (pending.current || mode === 'login') return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await postJson('/api/auth/email/send', { email, purpose: mode });
      startCooldown(typeof result.cooldownSeconds === 'number' ? result.cooldownSeconds : 60);
      setNotice(result.deliveryState === 'unknown' ? '发送结果尚未确认，如收到验证码可继续验证，请勿重复发送。' : '验证码已发送，5 分钟内有效，请检查收件箱或垃圾邮件。');
    } catch (error) {
      if (error instanceof AuthRequestError && error.retryAfterSeconds) startCooldown(error.retryAfterSeconds);
      setError(error instanceof Error ? error.message : String(error));
    }
    finally { pending.current = false; setBusy(false); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (pending.current) return;
    if (step === 2 && password !== confirm) { setError('两次输入的密码不一致，请重新确认'); return; }
    pending.current = true; setBusy(true); setError('');
    try {
      if (mode === 'login') {
        await postJson('/api/auth/login', { email, password });
        window.location.replace(next); return;
      }
      if (step === 1) {
        const result = await postJson('/api/auth/email/verify', { email, code, purpose: mode });
        if (typeof result.verificationToken !== 'string') throw new Error('邮箱验证未完成，请重新获取验证码');
        const verifiedMode = result.purpose === 'register' || result.purpose === 'reset' || result.purpose === 'setup' ? result.purpose : mode;
        setProof(result.verificationToken); setEmail(email.trim().toLowerCase());
        setNotice(verifiedMode !== mode ? verifiedMode === 'setup'
          ? '此邮箱已有账号，但尚未设置密码。邮箱已验证，请直接设置密码，原有资料保持不变。'
          : '此邮箱已有账号。邮箱已验证，可直接重置密码，原有资料保持不变；记得密码也可返回登录。' : '');
        setMode(verifiedMode); window.history.replaceState(null, '', href(verifiedMode)); setStep(2); return;
      }
      await postJson('/api/auth/email/complete', { email, purpose: mode, verificationToken: proof, password, confirmPassword: confirm });
      setPassword(''); setConfirm(''); setProof('');
      if (mode === 'register') { window.location.replace(next); return; }
      setNotice(mode === 'reset' ? '密码已重置，请使用新密码登录。' : '密码设置成功，请使用邮箱和密码登录。');
      setMode('login'); setStep(1); setCode(''); window.history.replaceState(null, '', href('login'));
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { pending.current = false; setBusy(false); }
  };
  const title = { login: '账号登录', register: '邮箱注册', reset: '找回密码', setup: '首次设置密码' }[mode];
  const subtitle = { login: '登录后，继续制作你的图稿和电商主图。', register: '验证邮箱并设置密码，即可创建账号。', reset: '通过注册邮箱验证身份，找回你的账号。', setup: '为已通过验证码注册的账号补充登录密码。' }[mode];
  const emailReady = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim());
  return <div className="login-wrap auth-wrap">
    <aside className="login-aside"><div className="brand"><span className="brand-mark" aria-hidden="true">衣</span><span><strong>工作服效果图</strong><small>图稿与电商主图制作台</small></span></div>
      <h2>传参考图和商品素材<br/>拿到能直接用的图稿和主图</h2>
      <ul><li>图稿生成：照参考图和要求出 Logo、图案，可局部修补、无损放大、去背景</li><li>电商主图：拖入商品文件夹，AI 整理素材、排好方案，确认后出整套主图</li><li>制作都在后台排队，关掉页面也会继续</li><li>按实际发生的动作计费，失败不扣</li></ul>
      <p className="login-foot">内测期间需管理员开通额度后才能发起制作</p>
    </aside>
    <main className="login-main">
      <div className="auth-mobile-brand"><b>衣</b>工作服效果图</div>
      {mode !== 'login' && <a className="auth-back" href={href('login')}>← 返回登录</a>}
      <h1>{title}</h1><p className="login-sub">{subtitle}</p>
      {mode !== 'login' && <div className="auth-steps" aria-label={`第 ${step} 步，共 2 步`}><span className={step === 1 ? 'active' : ''}><b>{step === 2 ? '✓' : '1'}</b>验证邮箱</span><i/><span className={step === 2 ? 'active' : ''}><b>2</b>{mode === 'reset' ? '重置密码' : '设置密码'}</span></div>}
      {notice && <p className="login-notice" role="status">{notice}</p>}
      <form className="login-form" onSubmit={submit}>
        {step === 1 ? <div className="login-field"><label htmlFor="email">{mode === 'login' ? '账号' : mode === 'register' ? '邮箱' : '注册邮箱'}</label>
          <input id="email" name="email" type="email" autoComplete={mode === 'login' ? 'username' : 'email'} value={email}
            onChange={event => { setEmail(event.target.value); setCode(''); }} disabled={busy} placeholder={mode === 'login' ? '请输入注册邮箱' : 'name@example.com'} required maxLength={254}/>
          {mode !== 'login' && <small className="auth-hint">{mode === 'register' ? '此邮箱将作为你的登录账号。' : '请输入原账号使用的邮箱，原有资料保持不变。'}</small>}
        </div> : <p className="auth-verified">邮箱已验证：<strong>{email}</strong></p>}
        {mode === 'login' ? <div className="auth-login-password"><a className="auth-forgot" href={href('reset')}>忘记密码？</a><PasswordField id="password" label="密码" value={password} onChange={setPassword} current disabled={busy}/></div>
          : step === 1 ? <div className="login-field"><label htmlFor="code">邮箱验证码</label><div className="login-code"><input id="code" name="code" type="text" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" required maxLength={6} value={code} placeholder="6 位数字" disabled={busy} onChange={event => setCode(event.target.value.replace(/\D/gu, '').slice(0, 6))}/><button className="button" type="button" disabled={!emailReady || busy || cooldown > 0} onClick={() => void sendCode()}>{cooldown > 0 ? `${cooldown} 秒后重发` : '获取验证码'}</button></div><small className="auth-hint">请查收邮箱中的 6 位验证码，5 分钟内有效。</small></div>
          : <div className="auth-password-fields" ref={passwordInput}><PasswordField id="password" label={mode === 'reset' ? '新密码' : '登录密码'} value={password} onChange={setPassword} disabled={busy}/><PasswordField id="confirmPassword" label="确认密码" value={confirm} onChange={setConfirm} disabled={busy}/></div>}
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="button primary login-submit" type="submit" disabled={busy}>{busy ? '正在处理…' : mode === 'login' ? '登录' : step === 1 ? '验证邮箱，下一步' : mode === 'register' ? '注册并进入工作台' : mode === 'reset' ? '重置密码' : '保存密码'}</button>
      </form>
      {mode === 'login' ? <><div className="auth-divider">还没有账号？</div><a className="button auth-register" href={href('register')}>用邮箱注册</a><p className="auth-legacy">之前用邮箱验证码登录？ <a href={href('setup')}>首次设置密码</a></p></>
        : mode === 'register' ? <p className="auth-return">已有账号？ <a href={href('login')}>直接登录</a></p>
          : <p className="auth-hint auth-bottom-note">{mode === 'reset' ? '重置后需使用新密码重新登录。' : '设置密码不会新建账号，也不会改变原有素材和积分。'}</p>}
      {step === 2 && error && <button type="button" className="auth-reverify" disabled={busy} onClick={() => { setStep(1); setCode(''); setProof(''); setPassword(''); setConfirm(''); setError(''); setNotice('请重新获取验证码。'); }}>重新验证邮箱</button>}
      {(mode === 'login' || mode === 'register') && <p className="login-terms">继续即表示同意《服务条款》与《隐私政策》。<br/>你的素材、图稿和主图仅在自己的工作区内可见。</p>}
    </main>
  </div>;
}
