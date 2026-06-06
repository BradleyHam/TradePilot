// Website publish pipeline — SERVER-ONLY, and effectively LOCAL-ONLY.
//
// Turns one finished job's Marketing-tab content into a new project page in
// the sibling painters-wanaka repo:
//   download before/after photos from Supabase Storage
//     → Claude vision gives each an SEO filename + alt
//     → sips resizes + converts to webp
//     → write public/projects/{slug}/{before,after}/*.webp + project.json
//
// Why local-only: it writes to the painters-wanaka working tree on disk and
// shells out to macOS `sips`. It runs when TradePilot runs on Brad's Mac
// (npm run dev). It is NOT meant to run on Vercel — the route guards that.
//
// Safety: it REFUSES to overwrite an existing project folder, so the 19 live
// project pages can never be touched. It auto-commits ONLY the new folder
// (never pushes); Brad pushes to deploy (the site auto-deploys on git push).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { supabaseAdmin } from './supabase/admin';
import { loadJobMarketingContext, markJobMarketingPublished } from './marketing-data';
import {
  labelProjectImage, sanitizeSeoName,
  type VisionImageMediaType,
} from './marketing-ai';
import type { Job, QuoteAttachment, WorkType } from './types';

const STORAGE_BUCKET = 'quote-attachments';
const MAX_DIMENSION = 2200;          // matches painters-wanaka optimize:projects
const VISION_MAX_DIMENSION = 1400;   // smaller copy for the vision call

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.heic', '.heif']);
const VISION_TYPES: Record<string, VisionImageMediaType> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
};

const SERVICE_BY_WORKTYPE: Record<WorkType, string[]> = {
  interior: ['Interior Painting'],
  exterior: ['Exterior Painting'],
  cedar: ['Cedar Restoration'],
  wallpaper: ['Wallpaper Installation'],
  roof: ['Roof Painting'],
  mixed: ['Exterior Painting', 'Interior Painting'],
};

export interface PublishedImage {
  /** The source quote_attachments.id, so hero selections can be resolved to files. */
  id: string;
  folder: 'before' | 'after' | 'process';
  file: string;
  alt: string;
}

export interface PublishResult {
  slug: string;
  title: string;
  /** e.g. "public/projects/cromwell-races-admin-building" */
  relPath: string;
  absPath: string;
  siteRoot: string;
  mainImage: string;
  services: string[];
  beforeCount: number;
  afterCount: number;
  images: PublishedImage[];
  /** Whether the new folder was git-committed (it is never pushed). */
  committed: boolean;
  /** The commit message used, when committed. */
  commitMessage?: string;
  /** Why the commit didn't happen, when it failed (files are still written). */
  commitError?: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '');
}

function deriveServices(job: Job): string[] {
  if (job.workType && SERVICE_BY_WORKTYPE[job.workType]) return SERVICE_BY_WORKTYPE[job.workType];
  return ['Exterior Painting']; // sensible default; Brad can edit project.json
}

function completionDate(job: Job): string {
  const raw = job.endDate || job.updatedAt || new Date().toISOString();
  return raw.slice(0, 10); // YYYY-MM-DD
}

function resolveSiteRoot(): string {
  const root = process.env.PAINTERS_WANAKA_PATH
    || path.resolve(process.cwd(), '..', 'painters-wanaka');
  if (!fs.existsSync(path.join(root, 'public', 'projects'))) {
    throw new Error(
      `Couldn't find the painters-wanaka site at "${root}". Set PAINTERS_WANAKA_PATH ` +
      `in .env.local to the repo path (the folder containing public/projects).`,
    );
  }
  return root;
}

function assertSipsAvailable(): void {
  if (process.platform !== 'darwin') {
    throw new Error('Image optimisation needs macOS `sips` — run this from TradePilot on your Mac.');
  }
  try {
    execFileSync('sips', ['--help'], { stdio: 'ignore' });
  } catch {
    throw new Error('`sips` not found. It ships with macOS — are you on a Mac?');
  }
}

async function downloadAttachment(att: QuoteAttachment): Promise<Buffer> {
  const { data, error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(att.storagePath);
  if (error || !data) throw new Error(`Download failed for ${att.storagePath}: ${error?.message ?? 'no data'}`);
  return Buffer.from(await data.arrayBuffer());
}

/** Produce vision-ready base64 bytes (convert HEIC etc to jpeg via sips). */
function toVisionBytes(buf: Buffer, ext: string): { dataBase64: string; mediaType: VisionImageMediaType } {
  const supported = VISION_TYPES[ext];
  if (supported) return { dataBase64: buf.toString('base64'), mediaType: supported };
  // Unsupported (e.g. HEIC) — convert a small jpeg copy for the model to read.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-vis-'));
  try {
    const src = path.join(tmpDir, `src${ext || '.heic'}`);
    const out = path.join(tmpDir, 'vis.jpg');
    fs.writeFileSync(src, buf);
    execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', String(VISION_MAX_DIMENSION), src, '--out', out], { stdio: 'ignore' });
    return { dataBase64: fs.readFileSync(out).toString('base64'), mediaType: 'image/jpeg' };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Resize to MAX_DIMENSION + convert to webp at destPath. Returns the file actually written. */
function optimizeToWebp(buf: Buffer, ext: string, destWebpPath: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-opt-'));
  try {
    const src = path.join(tmpDir, `src${ext || '.jpg'}`);
    fs.writeFileSync(src, buf);
    try { execFileSync('sips', ['-Z', String(MAX_DIMENSION), src], { stdio: 'ignore' }); } catch { /* keep size */ }
    try {
      execFileSync('sips', ['-s', 'format', 'webp', src, '--out', destWebpPath], { stdio: 'ignore' });
      return destWebpPath;
    } catch {
      // Fallback: write a resized jpeg (the site accepts jpg too).
      const jpg = destWebpPath.replace(/\.webp$/, '.jpg');
      execFileSync('sips', ['-s', 'format', 'jpeg', src, '--out', jpg], { stdio: 'ignore' });
      return jpg;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function isImageAttachment(a: QuoteAttachment): boolean {
  const name = (a.fileName ?? a.storagePath).toLowerCase();
  return IMAGE_EXTS.has(path.extname(name));
}

/**
 * Stage + commit ONLY the new project folder. Never pushes — Brad pushes to
 * deploy. Best-effort: if git isn't available or the commit fails, the files
 * are still on disk and we report the error rather than throwing.
 */
function gitCommitProject(siteRoot: string, relPath: string, message: string): { committed: boolean; error?: string } {
  try {
    execFileSync('git', ['-C', siteRoot, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  } catch {
    return { committed: false, error: 'painters-wanaka is not a git repo (or git unavailable) — commit manually.' };
  }
  try {
    execFileSync('git', ['-C', siteRoot, 'add', '--', relPath], { stdio: 'pipe' });
    // Scope the commit to just this folder so any unrelated working-tree
    // changes in the site repo are left untouched.
    execFileSync('git', ['-C', siteRoot, 'commit', '-m', message, '--', relPath], { stdio: 'pipe' });
    return { committed: true };
  } catch (err) {
    const e = err as { stderr?: Buffer; message?: string };
    const detail = (e.stderr?.toString().trim() || e.message || 'git commit failed').slice(0, 300);
    return { committed: false, error: detail };
  }
}

export async function publishJobToWebsite(
  jobId: string,
  opts: { mode?: 'create' | 'update' } = {},
): Promise<PublishResult> {
  const { job, before, after, process, marketing } = await loadJobMarketingContext(jobId);

  const description = marketing?.description?.trim();
  if (!description) {
    throw new Error('Add a description on the Marketing tab before publishing.');
  }
  const beforeImgs = before.filter(isImageAttachment);
  const afterImgs = after.filter(isImageAttachment);
  const processImgs = process.filter(isImageAttachment);
  if (afterImgs.length === 0) {
    throw new Error('Add at least one after photo before publishing.');
  }

  assertSipsAvailable();
  const siteRoot = resolveSiteRoot();

  const services = (marketing?.services && marketing.services.length > 0)
    ? marketing.services
    : deriveServices(job);
  const baseSlug = slugify(job.name) || `project-${job.id.slice(0, 8)}`;
  const projectDir = path.join(siteRoot, 'public', 'projects', baseSlug);
  const mode = opts.mode ?? 'create';
  const existed = fs.existsSync(projectDir);
  if (existed && mode !== 'update') {
    throw new Error(
      `A project folder "${baseSlug}" already exists on the site. Use "Update ` +
      `published page" to overwrite just this project.`,
    );
  }

  // Build into a temp sibling dir, then swap atomically at the very end. A
  // failed update can then never leave the live folder half-written — the
  // original stays intact until the new one is fully ready. The temp name is
  // dot/underscore-prefixed so getProjects() ignores it even if it lingers.
  const projectsDir = path.dirname(projectDir);
  const tmpDir = path.join(projectsDir, `.__publishing-${baseSlug}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  try {
    fs.mkdirSync(path.join(tmpDir, 'before'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'after'), { recursive: true });
    if (processImgs.length > 0) fs.mkdirSync(path.join(tmpDir, 'process'), { recursive: true });

    const usedNames = new Set<string>();
    const images: PublishedImage[] = [];

    const processBucket = async (atts: QuoteAttachment[], folder: 'before' | 'after' | 'process') => {
      for (const att of atts) {
        const ext = path.extname((att.fileName ?? att.storagePath)).toLowerCase();
        const buf = await downloadAttachment(att);

        // Vision label (best-effort — fall back to a generic name on failure).
        let seoName: string;
        let alt: string;
        try {
          const vis = toVisionBytes(buf, ext);
          const label = await labelProjectImage({
            dataBase64: vis.dataBase64,
            mediaType: vis.mediaType,
            phase: folder,
            location: job.location,
            services,
          });
          seoName = label.seoName;
          alt = label.alt;
        } catch (err) {
          console.warn('[website-publish] image label failed, using fallback name:', (err as Error).message);
          seoName = sanitizeSeoName(`${services[0]}-${folder}-${job.location ?? 'wanaka'}`);
          alt = `${job.name} ${folder} photo`;
        }

        // De-dupe filenames within this run.
        let unique = seoName;
        let n = 2;
        while (usedNames.has(unique)) unique = `${seoName}-${n++}`;
        usedNames.add(unique);

        const written = optimizeToWebp(buf, ext, path.join(tmpDir, folder, `${unique}.webp`));
        images.push({ id: att.id, folder, file: path.basename(written), alt });
      }
    };

    await processBucket(beforeImgs, 'before');
    await processBucket(afterImgs, 'after');
    await processBucket(processImgs, 'process');

    // Resolve the hero choice made in the preview to the actual written files.
    const byId = new Map(images.map((i) => [i.id, i]));
    const afterList = images.filter((i) => i.folder === 'after');
    const beforeList = images.filter((i) => i.folder === 'before');

    const pickedAfter = marketing?.heroAfterId ? byId.get(marketing.heroAfterId) : undefined;
    const pickedBefore = marketing?.heroBeforeId ? byId.get(marketing.heroBeforeId) : undefined;
    const chosenAfter = (pickedAfter?.folder === 'after' ? pickedAfter : undefined) ?? afterList[0];
    const chosenBefore = (pickedBefore?.folder === 'before' ? pickedBefore : undefined) ?? beforeList[0];

    const heroMode: 'image' | 'slider' =
      marketing?.heroMode ?? (beforeList.length > 0 && afterList.length > 0 ? 'slider' : 'image');

    // afterImgs is guaranteed non-empty (checked above), so chosenAfter exists.
    const mainImage = `after/${(chosenAfter ?? afterList[0]).file}`;

    // WYSIWYG: publish EXACTLY the copy reviewed in the app — never generate here.
    const overview = (marketing?.overview ?? []).map((p) => p.trim()).filter(Boolean);
    const projectTitle = marketing?.title?.trim() || job.name;

    const projectJson: Record<string, unknown> = {
      title: projectTitle,
      slug: baseSlug,
      location: job.location ?? 'Wanaka',
      description,
      overview,
      services,
      completionDate: completionDate(job),
      featured: false,
      mainImage,
    };
    // Before/after slider only when Brad chose it AND both images resolve.
    if (heroMode === 'slider' && chosenBefore && chosenAfter) {
      projectJson.compareSlider = {
        before: `before/${chosenBefore.file}`,
        after: `after/${chosenAfter.file}`,
        beforeAlt: chosenBefore.alt,
        afterAlt: chosenAfter.alt,
      };
    }

    fs.writeFileSync(
      path.join(tmpDir, 'project.json'),
      JSON.stringify(projectJson, null, 2) + '\n',
      'utf8',
    );

    // Swap the finished folder into place (replacing the old one if updating).
    if (existed) fs.rmSync(projectDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, projectDir);

    await markJobMarketingPublished(job, marketing);

    // Auto-commit just this folder (never pushed — Brad pushes to deploy).
    const relPath = path.join('public', 'projects', baseSlug);
    const commitMessage = `${existed ? 'Update' : 'Add'} project: ${projectTitle}`;
    const git = gitCommitProject(siteRoot, relPath, commitMessage);

    return {
      slug: baseSlug,
      title: projectTitle,
      relPath,
      absPath: projectDir,
      siteRoot,
      mainImage,
      services,
      beforeCount: beforeImgs.length,
      afterCount: afterImgs.length,
      images,
      committed: git.committed,
      commitMessage: git.committed ? commitMessage : undefined,
      commitError: git.error,
    };
  } catch (err) {
    // Pre-swap failure: bin the temp dir, leave any existing live folder intact.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }
}
