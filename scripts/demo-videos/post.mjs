// Title card, burned-in captions, 16:9 and a framed 9:16 cut. Silent on purpose.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const TITLE_S = 3.5;

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'inherit', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || ('ffmpeg ' + code)))));
  });
}

function probe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve(Number(out.trim())) : reject(new Error(err || 'ffprobe'))));
  });
}

function assTime(ms) {
  const cs = Math.max(0, Math.round(ms / 10));
  const s = Math.floor(cs / 100);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');
}

function writeAss(file, cues, { w, h, size, marginV }) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,DejaVu Sans,${size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,3,14,0,2,70,70,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,${esc(c.text)}`);
  fs.writeFileSync(file, header + lines.join('\n') + '\n');
}

function cuesFor(items, durationMs, leadMs) {
  const shifted = items
    .map((c) => ({ text: c.text, at: c.at - leadMs }))
    .filter((c) => c.at < durationMs - 200);
  return shifted.map((c, i) => {
    const start = Math.max(0, c.at);
    const next = i + 1 < shifted.length ? shifted[i + 1].at : durationMs - 200;
    return { text: c.text, start, end: Math.max(start + 400, Math.min(next - 80, durationMs - 80)) };
  }).filter((c) => c.end > c.start);
}

async function titleCard(file, w, h, storyTitle) {
  const dir = path.dirname(file);
  const a = path.join(dir, 't-brand.txt');
  const b = path.join(dir, 't-story.txt');
  const c = path.join(dir, 't-line.txt');
  fs.writeFileSync(a, 'AIdentify');
  fs.writeFileSync(b, storyTitle);
  fs.writeFileSync(c, 'Owner asks. The team drafts. Nothing sends until you approve.');
  const y1 = Math.round(h * 0.40);
  const y2 = y1 + Math.round(h * 0.09);
  const y3 = y2 + Math.round(h * 0.08);
  const s1 = w >= 1600 ? 76 : 64;
  const s2 = w >= 1600 ? 42 : 36;
  const s3 = w >= 1600 ? 28 : 26;
  const dt = (fileTxt, size, y, font) => `drawtext=fontfile=${font}:textfile=${fileTxt}:fontsize=${size}:fontcolor=white:x=(w-text_w)/2:y=${y}`;
  await run([
    '-f', 'lavfi', '-i', `color=c=0x0c0c0c:s=${w}x${h}:d=${TITLE_S}:r=30`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-vf', [dt(a, s1, y1, BOLD), dt(b, s2, y2, FONT), dt(c, s3, y3, FONT)].join(','),
    '-t', String(TITLE_S),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-shortest',
    file,
  ]);
}

async function padStill(file, minSeconds) {
  const d = await probe(file);
  if (d >= minSeconds - 0.05) return file;
  const extra = (minSeconds - d).toFixed(3);
  const out = file.replace(/\.mp4$/, '-hold.mp4');
  await run([
    '-i', file,
    '-vf', `tpad=stop_mode=clone:stop_duration=${extra}`,
    '-af', `apad=pad_dur=${extra}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac',
    out,
  ]);
  return out;
}

async function concat(out, title, body) {
  await run([
    '-i', title, '-i', body,
    '-filter_complex', '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]',
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-movflags', '+faststart',
    out,
  ]);
}

export async function renderStory({ raw, captions, title, work, out16, out9 }) {
  fs.mkdirSync(work, { recursive: true });
  const full = await probe(raw);
  const first = captions.length ? captions[0].at : 800;
  const lead = Math.max(0, (first - 700) / 1000);
  const content = Math.max(1, full - lead);
  const clean = path.join(work, 'clean.mp4');
  await run([
    '-ss', lead.toFixed(3), '-i', raw,
    '-t', content.toFixed(3),
    '-an', '-vf', 'scale=1920:1080:flags=lanczos,fps=30,format=yuv420p',
    '-c:v', 'libx264', clean,
  ]);
  const minBody = 60 - TITLE_S + 2;
  const body = await padStill(clean, minBody);
  const dur = await probe(body);
  const durMs = dur * 1000;
  const wide = cuesFor(captions, durMs, lead * 1000);
  const ass16 = path.join(work, 'cap16.ass');
  const ass9 = path.join(work, 'cap9.ass');
  writeAss(ass16, wide, { w: 1920, h: 1080, size: 42, marginV: 42 });
  writeAss(ass9, wide, { w: 1080, h: 1920, size: 46, marginV: 150 });

  const burned = path.join(work, 'burned.mp4');
  const framed = path.join(work, 'framed.mp4');
  const t16 = path.join(work, 'title16.mp4');
  const t9 = path.join(work, 'title9.mp4');
  await run([
    '-i', body,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-vf', `ass=${ass16}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-shortest', burned,
  ]);
  await run([
    '-i', body,
    '-f', 'lavfi', '-i', `color=c=0x0c0c0c:s=1080x1920:d=${dur.toFixed(3)}:r=30`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-filter_complex', `[0:v]scale=1080:-2:flags=lanczos[vid];[1:v][vid]overlay=(W-w)/2:180,ass=${ass9}[v]`,
    '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-shortest', framed,
  ]);
  await titleCard(t16, 1920, 1080, title);
  await titleCard(t9, 1080, 1920, title);
  await concat(out16, t16, burned);
  await concat(out9, t9, framed);
  return { duration16: await probe(out16), duration9: await probe(out9), lead, content: dur };
}
