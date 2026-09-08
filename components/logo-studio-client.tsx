'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';

import { AppHeader } from '@/components/app-header';
import {
  LOGO_STUDIO_MAX_IMAGE_BYTES,
  LOGO_STUDIO_MAX_IMAGES,
  type LogoStudioResponse,
} from '@/lib/logo-studio';

type LocalLogoImage = {
  file: File;
  previewUrl: string;
};

function fileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取 ${file.name}`));
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error(`${file.name} 没有返回图片内容`));
    reader.readAsDataURL(file);
  });
}

function responseError(body: unknown, status: number) {
  if (body && typeof body === 'object' && typeof (body as Record<string, unknown>).error === 'string') {
    return (body as Record<string, string>).error;
  }
  return `Logo 处理失败：HTTP ${status}`;
}

export function LogoStudioClient() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<LocalLogoImage[]>([]);
  const imagesRef = useRef<LocalLogoImage[]>([]);
  const [instruction, setInstruction] = useState('');
  const [result, setResult] = useState<LogoStudioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => () => {
    imagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl));
  }, []);

  const selectFiles = (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;
    setError(null);
    setResult(null);
    if (images.length + files.length > LOGO_STUDIO_MAX_IMAGES) {
      setError(`最多上传 ${LOGO_STUDIO_MAX_IMAGES} 张图片，当前已有 ${images.length} 张。`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    const invalidFile = files.find((file) => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
      || file.size === 0
      || file.size > LOGO_STUDIO_MAX_IMAGE_BYTES);
    if (invalidFile) {
      setError(`${invalidFile.name} 必须是 1B–8MB 的 PNG、JPG 或 WebP 图片。`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setImages((current) => [
      ...current,
      ...files.map((file) => ({ file, previewUrl: URL.createObjectURL(file) })),
    ]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImage = (index: number) => {
    setImages((current) => {
      const removed = current[index];
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((_, imageIndex) => imageIndex !== index);
    });
    setResult(null);
    setError(null);
  };

  const ready = images.length > 0 && Boolean(instruction.trim());

  const generateLogo = async () => {
    if (!ready) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const payload = {
        instruction,
        images: await Promise.all(images.map(async (image) => ({
          fileName: image.file.name,
          mimeType: image.file.type,
          dataUrl: await fileAsDataUrl(image.file),
        }))),
      };
      const response = await fetch('/api/logo-studio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(body, response.status));
      setResult(body as LogoStudioResponse);
    } catch (processingError) {
      setError(processingError instanceof Error ? processingError.message : String(processingError));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="logo-studio-page">
        <header className="logo-studio-hero">
          <div>
            <span className="eyebrow">Logo 智能处理工作台</span>
            <h1>上传 1–2 张图，说一句要求，直接生成完整 Logo</h1>
            <p>图1、图2会自动编号。你可以说“图1取 Logo，图2参考字体和颜色”，模型理解对应关系后生成一个完整版本。</p>
          </div>
          <ol aria-label="处理步骤">
            <li><strong>1</strong><span>上传图片</span></li>
            <li><strong>2</strong><span>描述要求</span></li>
            <li><strong>3</strong><span>生成一版</span></li>
          </ol>
        </header>

        <div className="logo-studio-grid">
          <section className="studio-card studio-inputs">
            <div className="studio-card-heading">
              <div><span>输入</span><h2>图片和一句修改要求</h2></div>
            </div>

            <button
              className="studio-upload"
              disabled={images.length >= LOGO_STUDIO_MAX_IMAGES}
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              <strong>{images.length >= LOGO_STUDIO_MAX_IMAGES ? '已上传 2 张图片' : `＋ 添加图片（${images.length}/2）`}</strong>
              <span>支持 PNG、JPG、WebP，最多 2 张，单张不超过 8MB</span>
            </button>
            <input
              ref={fileInputRef}
              hidden
              accept="image/png,image/jpeg,image/webp"
              multiple
              type="file"
              onChange={(event) => selectFiles(event.target.files)}
            />

            {images.length > 0 ? (
              <div className="studio-image-list">
                {images.map((image, index) => (
                  <article className="studio-image-card" key={image.previewUrl}>
                    <div className="studio-image-preview">
                      <Image alt={`图${index + 1}预览`} height={900} src={image.previewUrl} unoptimized width={900} />
                      <strong>图{index + 1}</strong>
                    </div>
                    <div className="studio-image-fields">
                      <div className="studio-image-title">
                        <span title={image.file.name}>{image.file.name}</span>
                        <button type="button" onClick={() => removeImage(index)}>移除</button>
                      </div>
                      <p>在下面直接用“图{index + 1}”说明要取它的 Logo、字体、颜色或其他内容。</p>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="studio-empty">
                <strong>上传客户发来的参考图</strong>
                <span>可以只传一张，也可以一次选择两张；系统会自动标成图1、图2。</span>
              </div>
            )}

            <label className="studio-overall-instruction">
              <span>你希望怎么改</span>
              <textarea
                placeholder="例如：图1取中间的 Logo，图2参考下面文字的字体和蓝色，改成“汉方嘉铁永坊店”，上下排版"
                value={instruction}
                onChange={(event) => {
                  setInstruction(event.target.value);
                  setResult(null);
                  setError(null);
                }}
              />
            </label>

            <button className="button primary studio-run" disabled={!ready || running} type="button" onClick={() => void generateLogo()}>
              {running ? '正在理解图片并生成一个完整 Logo，可能需要 30–120 秒…' : '理解并生成一个完整 Logo'}
            </button>
            {!ready && (images.length > 0 || instruction) && <small className="studio-hint">至少上传一张图片，再写一句修改要求。</small>}
            {error && <div className="error-banner studio-error" role="alert"><span>{error}</span></div>}
          </section>

          <section className="studio-card studio-result">
            <div className="studio-card-heading">
              <div><span>结果</span><h2>完整 Logo</h2></div>
              {result && <small>{Math.round(result.durationMs / 1000)} 秒</small>}
            </div>
            {!result ? (
              <div className="studio-result-empty">
                <span aria-hidden="true">AI</span>
                <strong>等待生成</strong>
                <p>这里只返回一个完整版本，不再展示文字骨架、三个候选和拆分后的文字图层。</p>
              </div>
            ) : (
              <div className="studio-result-content">
                <div className={`studio-status ${result.status === 'generated' ? 'success' : 'review'}`}>
                  <strong>{result.status === 'generated' ? '已理解并生成一个完整版本' : '这句话还不能唯一理解'}</strong>
                  <span>{result.analysis.summary}</span>
                </div>

                <div className="studio-analysis-block">
                  <h3>模型的理解</h3>
                  <article>
                    <p><b>保留：</b>{result.analysis.source.keep.join('；') || '无'}</p>
                    <p><b>删除：</b>{result.analysis.source.remove.join('；') || '无'}</p>
                    {result.analysis.output.targetText && <p><b>新文字：</b>{result.analysis.output.targetText}</p>}
                    <p><b>排版：</b>{result.analysis.output.layout}</p>
                    <p><b>颜色：</b>{result.analysis.source.colorReference || '按原要求'}</p>
                  </article>
                </div>

                {result.analysis.ambiguities.length > 0 && (
                  <div className="studio-ambiguities">
                    <strong>需要你补充一句</strong>
                    <ul>{result.analysis.ambiguities.map((item) => <li key={item}>{item}</li>)}</ul>
                  </div>
                )}

                {result.generatedImage && (
                  <div className="studio-generated">
                    <div className="studio-complete-logo">
                      <Image alt="模型生成的完整 Logo" height={1600} src={result.generatedImage.dataUrl} unoptimized width={1600} />
                    </div>
                    <h3>{result.analysis.output.description}</h3>
                    <a className="button primary full" download="generated-logo.png" href={result.generatedImage.dataUrl}>下载这个 Logo</a>
                    <small>后台把客户上传的 1–2 张参考图、准确文字骨架和完整要求放进同一次图片生成，直接得到完整 Logo，再去除白底转为透明 PNG；请继续按画面核对，当前不会自动覆盖商品任务里的 Logo。</small>
                  </div>
                )}

                <div className="studio-models">
                  <span>理解：{result.models.analysis}</span>
                  <span>生成：{result.models.generation ?? '未调用'}</span>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
