'use client';

import { useState } from 'react';

import {
  verifyBrowserLogoText,
  type BrowserLogoTextVerification,
} from '@/lib/client/browser-logo-ocr';

type LogoTextVerificationProps = {
  logoName: string;
  logoUrl: string;
  initialExpectedText?: string;
  initialResult?: BrowserLogoTextVerification | null;
  onResult?: (result: BrowserLogoTextVerification) => Promise<void>;
  title?: string;
};

const FAILURE_LABELS: Record<Exclude<BrowserLogoTextVerification['reason'], 'passed'>, string> = {
  noText: '没有识别到文字',
  textMismatch: '识别文字与目标文字不一致',
  lowConfidence: '文字一致，但识别置信度过低',
};

export function LogoTextVerification({ logoName, logoUrl, initialExpectedText = '', initialResult = null, onResult, title = '3. Logo 文字验收（Stage 0）' }: LogoTextVerificationProps) {
  const [expectedText, setExpectedText] = useState(initialExpectedText);
  const [result, setResult] = useState<BrowserLogoTextVerification | null>(initialResult);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const runVerification = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const checked = await verifyBrowserLogoText(logoUrl, expectedText);
      setResult(checked);
      if (onResult) await onResult(checked);
    } catch (verificationError) {
      setError(verificationError instanceof Error ? verificationError.message : String(verificationError));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="setting-section logo-text-verification">
      <h2>{title}</h2>
      <p>输入客户最终要求的完整文字；图片只在当前浏览器中由 PP-OCRv6 检查。</p>
      <label>
        <span>目标文字</span>
        <input
          aria-label="Logo 目标文字"
          disabled={running}
          placeholder="例如：汉方嘉铁永坊店"
          type="text"
          value={expectedText}
          onChange={(event) => {
            setExpectedText(event.target.value);
            setResult(null);
            setError(null);
          }}
        />
      </label>
      <button
        className="button secondary full"
        disabled={running || expectedText.trim().length === 0}
        type="button"
        onClick={() => void runVerification()}
      >
        {running ? '正在加载模型并识别…' : '自动检查当前 Logo 文字'}
      </button>
      <small>当前文件：{logoName}。首次使用需下载并缓存 OCR 模型；{onResult ? '检查结果保存到当前图案，换图后重新检查。' : '检查结果暂不自动写入任务。'}</small>
      {error && <div className="logo-text-result error" role="alert"><strong>检查失败</strong><span>{error}</span></div>}
      {result && (
        <div className={`logo-text-result ${result.passed ? 'passed' : 'review'}`} aria-live="polite">
          <strong>{result.passed ? '文字门禁通过' : '需要人工处理'}</strong>
          <span>{result.passed ? '规范化后的文字完全一致。' : FAILURE_LABELS[result.reason as Exclude<typeof result.reason, 'passed'>]}</span>
          {!result.passed && result.normalizedExpectedText && result.normalizedRecognizedText.includes(result.normalizedExpectedText) && <p>目标文字已识别，同时检测到额外字符。请核对是图形误识别，还是成品里确实多了文字。</p>}
          <dl>
            <div><dt>目标文字</dt><dd>{result.expectedText}</dd></div>
            <div><dt>识别文字</dt><dd>{result.recognizedText || '—'}</dd></div>
            <div><dt>最低置信度</dt><dd>{Math.round(result.minimumScore * 100)}%</dd></div>
            <div><dt>对比底色</dt><dd>{result.contrastBackground === 'white' ? '白色' : '黑色'}</dd></div>
            <div><dt>推理耗时</dt><dd>{Math.round(result.durationMs)}ms</dd></div>
          </dl>
        </div>
      )}
    </section>
  );
}
