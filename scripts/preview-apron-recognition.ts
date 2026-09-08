import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { APRON_RECOGNITION_PROMPT, APRON_REFINEMENT_PROMPT, APRON_RECOGNITION_VERSION } from '../lib/catalog-apron-recognition';
import { apronRecognitionModel, prepareApronRefinement, refineApronRecognition, recognizeApronImage } from '../lib/server/catalog-apron-recognition';
process.loadEnvFile('.env.local');
const directory = path.resolve('output/apron-recognition');
await mkdir(directory, { recursive: true });
const manifest = JSON.parse(await readFile('output/catalog/garment-import-manifest.json', 'utf8'));
const entry = manifest.entries.find((item: { styleCode: string; colorName: string }) => item.styleCode === '103JJ' && item.colorName === '卡其');
if (!entry || entry.layout !== 'front_only') throw new Error('缺少 103JJ 卡其单面底图');
const source = await readFile(path.join(manifest.outputDirectory, entry.filename));
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
if (hash(source) !== entry.sha256) throw new Error('103JJ 卡其源图 hash 不一致');
const input = await sharp(source).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).flatten({ background: 'white' }).png().toBuffer();
await writeFile(path.join(directory, '103JJ-khaki-input.png'), input);
const audit = { model: apronRecognitionModel(), version: APRON_RECOGNITION_VERSION, input: '103JJ-khaki-input.png', sourceHash: entry.sha256, inputHash: hash(input), promptHash: hash(APRON_RECOGNITION_PROMPT), prompt: APRON_RECOGNITION_PROMPT };
await writeFile(path.join(directory, 'request.json'), JSON.stringify(audit, null, 2));
console.log(JSON.stringify({ ...audit, prompt: path.join(directory, 'request.json') }, null, 2));
if (process.argv.includes('--run')) {
  const result = await recognizeApronImage(input);
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv.includes('--prepare-refinement') || process.argv.includes('--refine')) {
  const first = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
  const focused = await prepareApronRefinement(input, first.recognition);
  if (!focused) throw new Error('首轮没有可靠围裙区域，不能进行局部复核');
  await writeFile(path.join(directory, '103JJ-khaki-refinement.png'), focused.image);
  await writeFile(path.join(directory, 'refinement-request.json'), JSON.stringify({ version: APRON_RECOGNITION_VERSION, input: '103JJ-khaki-refinement.png', inputHash: hash(focused.image), promptHash: hash(APRON_REFINEMENT_PROMPT), prompt: APRON_REFINEMENT_PROMPT, crop: focused.crop }, null, 2));
  console.log({ refinementInputHash: hash(focused.image), refinementPromptHash: hash(APRON_REFINEMENT_PROMPT), crop: focused.crop });
  if (process.argv.includes('--refine')) {
    const refined = await refineApronRecognition(input, first);
    await writeFile(path.join(directory, 'refined-result.json'), JSON.stringify(refined, null, 2));
    console.log(JSON.stringify(refined, null, 2));
  }
}
