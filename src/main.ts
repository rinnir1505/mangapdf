import './style.css';
import {
  APP_NAME,
  MAX_PAGES,
  PAGE_LONG_EDGE_PT,
  QUALITY_ORDER,
  QUALITY_PRESETS,
  LARGE_OUTPUT_BYTES,
  SHARE_SAFE_BYTES,
  type QualityMode,
} from './config';
import { formatBytes, sanitizeFileName } from './lib/format';
import { yieldToUI } from './lib/schedule';
import { makeThumbnail, prepareForPdf } from './lib/imagePrep';
import { displaySize, readJpegInfo, type JpegInfo } from './lib/jpeg';
import { naturalCompare } from './lib/naturalSort';
import { AbortError, writeImagePdf } from './lib/pdfWriter';
import { canSharePdf, inAppBrowserName, isIOS, savePdf, sharePdf } from './lib/share';

/* ────────── 型と状態 ────────── */

interface Page {
  id: string;
  file: File;
  info: JpegInfo;
  thumbUrl: string | null;
  thumbStatus: 'idle' | 'loading' | 'ready' | 'error';
}

interface OutputFile {
  blob: Blob;
  name: string;
  pageCount: number;
  /** 完了画面を離れるまで保持する。途中で解放すると iOS で保存できなくなる */
  url: string;
}

type Screen = 'start' | 'editor' | 'progress' | 'done';
type Notice = { kind: 'warn' | 'error'; text: string } | null;

const state = {
  screen: 'start' as Screen,
  pages: [] as Page[],
  quality: 'original' as QualityMode,
  baseName: 'manga',
  split: false,
  outputs: [] as OutputFile[],
  progress: { done: 0, total: 0 },
  notice: null as Notice,
  busyLabel: null as string | null,
  saving: null as { label: string; hint: string } | null,
};

const root = document.querySelector<HTMLDivElement>('#app')!;
const fileInput = document.querySelector<HTMLInputElement>('#file-input')!;

let listEl: HTMLElement | null = null;
let progressRefs: { count: HTMLElement; fill: HTMLElement } | null = null;
let abortController: AbortController | null = null;
let thumbObserver: IntersectionObserver | null = null;

/* ────────── DOM ヘルパ ────────── */

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value as object);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function uid(): string {
  return `p${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function totalBytes(): number {
  return state.pages.reduce((sum, page) => sum + page.file.size, 0);
}

function setNotice(kind: 'warn' | 'error', text: string): void {
  state.notice = { kind, text };
}

/* ────────── 画面 ────────── */

function render(): void {
  listEl = null;
  progressRefs = null;
  thumbObserver?.disconnect();
  thumbObserver = null;
  root.replaceChildren();

  if (state.busyLabel) {
    root.append(renderBusy(state.busyLabel));
    return;
  }

  const inApp = inAppBrowserName();
  if (inApp) root.append(renderInAppWarning(inApp));

  switch (state.screen) {
    case 'start':
      root.append(renderMasthead(), renderStart());
      break;
    case 'editor':
      root.append(renderMasthead(), ...renderEditor());
      break;
    case 'progress':
      root.append(renderProgress());
      break;
    case 'done':
      root.append(renderMasthead(), renderDone());
      break;
  }

  if (state.saving) root.append(renderSavingOverlay(state.saving));
}

function renderSavingOverlay(saving: { label: string; hint: string }): HTMLElement {
  const overlay = h(
    'div',
    { class: 'overlay', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'overlay-card' },
      h('div', { class: 'spinner' }),
      h('div', { class: 'overlay-label', text: saving.label }),
      h('div', { class: 'overlay-hint', text: saving.hint }),
      // 共有が応答しないまま閉じ込められないよう、必ず抜け道を用意する
      h('button', {
        class: 'btn btn-quiet',
        text: '閉じる',
        onclick: () => {
          state.saving = null;
          render();
        },
      }),
    ),
  );
  return overlay;
}

/**
 * 実際にバイトが動くのは保存のときだけで、そこには進捗イベントが無い。
 * せめて容量から所要時間の見当を伝えて、固まったと誤解されないようにする。
 */
function waitHint(bytes: number): string {
  const size = formatBytes(bytes);
  if (bytes >= 300 * 1024 * 1024) {
    return `${size} あります。大きいため1分以上かかることがあります。この画面のままお待ちください。`;
  }
  if (bytes >= 100 * 1024 * 1024) {
    return `${size} あります。少し時間がかかります。`;
  }
  return `${size} を準備しています。`;
}

function renderMasthead(): HTMLElement {
  return h(
    'header',
    { class: 'masthead' },
    h('h1', { text: APP_NAME }),
    h('p', { text: '漫画のJPGをまとめて1つのPDFに' }),
  );
}

function renderBusy(label: string): HTMLElement {
  return h(
    'div',
    { class: 'progress-screen' },
    h('div', { class: 'progress-head', text: label }),
    h('div', { class: 'progress-note', text: 'そのままお待ちください' }),
  );
}

function renderStart(): HTMLElement {
  return h(
    'main',
    { class: 'start' },
    h(
      'p',
      { class: 'start-lead' },
      h('strong', { text: '画像を選ぶだけ。' }),
      document.createElement('br'),
      '順番を確かめて、PDFにします。',
    ),
    h('button', { class: 'btn', onclick: openPicker }, '画像を選ぶ'),
    h('div', { class: 'steps' },
      h('span', { text: '選ぶ' }),
      h('span', { text: '並べる' }),
      h('span', { text: 'PDFにする' }),
    ),
    h(
      'div',
      { class: 'privacy' },
      h('strong', { text: '画像は外部へ送信されません' }),
      'PDFの作成はすべてこの端末の中で行われます。原稿がサーバーに保存されることはありません。登録も料金も不要です。',
    ),
    state.notice ? renderNotice(state.notice) : null,
  );
}

function renderInAppWarning(appName: string): HTMLElement {
  const box = h('div', { class: 'notice notice-error inapp-warning' });
  box.append(
    h('strong', { text: `${appName}の中で開いています` }),
    h('span', {
      text:
        'このままではPDFを保存できません。' +
        'ブラウザ（Safariなど）で開き直してください。',
    }),
  );
  if (appName === 'LINE') {
    box.append(
      h('span', {
        class: 'inapp-how',
        text: '画面の右下にある「…」または矢印のマークから「Safariで開く」を選べます。',
      }),
    );
  }
  box.append(
    h(
      'button',
      {
        class: 'btn btn-secondary',
        onclick: () => {
          void navigator.clipboard?.writeText(location.href).then(
            () => setNoticeAndRender('warn', 'URLをコピーしました。Safariに貼り付けて開いてください。'),
            () => setNoticeAndRender('warn', 'URLをコピーできませんでした。アドレス欄から手動でコピーしてください。'),
          );
        },
      },
      'このページのURLをコピー',
    ),
  );
  return box;
}

function setNoticeAndRender(kind: 'warn' | 'error', text: string): void {
  setNotice(kind, text);
  render();
}

function renderNotice(notice: NonNullable<Notice>): HTMLElement {
  return h('div', {
    class: `notice ${notice.kind === 'error' ? 'notice-error' : 'notice-warn'}`,
    text: notice.text,
  });
}

function renderEditor(): HTMLElement[] {
  const pageCount = state.pages.length;
  const nodes: HTMLElement[] = [];

  nodes.push(
    h(
      'div',
      { class: 'summary' },
      h('div', { class: 'summary-item' },
        h('div', { class: 'summary-label', text: 'ページ数' }),
        h('div', { class: 'summary-value', text: `${pageCount} ページ` }),
      ),
      h('div', { class: 'summary-item' },
        h('div', { class: 'summary-label', text: '元画像の合計' }),
        h('div', { class: 'summary-value', text: formatBytes(totalBytes()) }),
      ),
    ),
  );

  if (state.notice) nodes.push(renderNotice(state.notice));

  // 画質
  const qualityField = h('div', { class: 'field' },
    h('div', { class: 'field-label', text: '画質' }),
  );
  const qualityList = h('div', { class: 'quality-list', role: 'radiogroup' });
  for (const mode of QUALITY_ORDER) {
    const preset = QUALITY_PRESETS[mode];
    const selected = state.quality === mode;
    qualityList.append(
      h(
        'button',
        {
          class: 'quality-option',
          role: 'radio',
          'aria-checked': String(selected),
          onclick: () => {
            state.quality = mode;
            state.notice = null;
            render();
          },
        },
        h('span', { class: 'radio-dot' }),
        h('span', { class: 'quality-text' },
          h('span', { class: 'quality-name', text: preset.label }),
          h('span', { class: 'quality-note', text: preset.note }),
        ),
        mode === 'original'
          ? h('span', { class: 'quality-size', text: `約 ${formatBytes(totalBytes())}` })
          : null,
      ),
    );
  }
  qualityField.append(qualityList);
  if (state.quality === 'original') {
    qualityField.append(
      h('div', {
        class: 'field-hint',
        text: '原寸は再圧縮しないため、画質が落ちず作成も最速です。容量は元画像とほぼ同じになります。',
      }),
    );
  } else {
    qualityField.append(
      h('div', {
        class: 'field-hint',
        text: '縮小して再圧縮します。完成後の容量は次の画面に表示されます。',
      }),
    );
  }
  nodes.push(qualityField);

  // 分割
  if (pageCount > 2) {
    const parts = partCount();
    const isOriginal = state.quality === 'original';
    const perPart = isOriginal ? formatBytes(totalBytes() / parts) : null;
    const splitField = h('div', { class: 'field' });

    splitField.append(
      h(
        'button',
        {
          class: 'toggle-row',
          role: 'checkbox',
          'aria-checked': String(state.split),
          onclick: () => {
            state.split = !state.split;
            render();
          },
        },
        h('span', { class: 'checkbox-box', text: state.split ? '✓' : '' }),
        h('span', { class: 'quality-text' },
          h('span', { class: 'quality-name', text: `PDFを${parts}つに分ける` }),
          h('span', {
            class: 'quality-note',
            text: perPart
              ? `${splitSizes(pageCount, parts).join('・')} ページずつ（各 約${perPart}）`
              : `${splitSizes(pageCount, parts).join('・')} ページずつ`,
          }),
        ),
      ),
    );
    nodes.push(splitField);
  }

  // 容量が大きすぎる場合の警告
  if (state.quality === 'original' && !state.split && totalBytes() > LARGE_OUTPUT_BYTES) {
    nodes.push(
      h('div', { class: 'notice notice-warn' },
        `このままだと約 ${formatBytes(totalBytes())} のPDFになります。`,
        document.createElement('br'),
        'iPhoneでは大きすぎて共有や保存が進まないことがあります。',
        '「高画質」に変えるか、上の分割をお使いください。',
      ),
    );
  }

  // ファイル名
  nodes.push(
    h('div', { class: 'field' },
      h('div', { class: 'field-label', text: 'ファイル名' }),
      h('input', {
        class: 'text-input',
        type: 'text',
        value: state.baseName,
        inputmode: 'text',
        autocapitalize: 'off',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: 'manga',
        oninput: (event: Event) => {
          state.baseName = (event.target as HTMLInputElement).value;
        },
      }),
      h('div', { class: 'field-hint', text: '「.pdf」は自動でつきます' }),
    ),
  );

  // ページ一覧
  nodes.push(h('div', { class: 'screen-title', text: 'ページ順' }));
  listEl = h('div', { class: 'page-list' });
  for (const page of state.pages) listEl.append(renderPageCard(page));
  nodes.push(listEl);
  setupThumbObserver();

  nodes.push(
    h('div', { class: 'btn-stack' },
      h('button', { class: 'btn btn-secondary', onclick: openPicker }, '画像を選びなおす'),
    ),
  );

  nodes.push(
    h('div', { class: 'sticky-actions' },
      h(
        'button',
        { class: 'btn', disabled: pageCount === 0, onclick: () => void generate() },
        `PDFを作成（${pageCount}ページ）`,
      ),
    ),
  );

  return nodes;
}

function renderPageCard(page: Page): HTMLElement {
  const index = state.pages.indexOf(page);
  const size = displaySize(page.info);

  const img = h('img', {
    class: 'page-thumb',
    alt: '',
    decoding: 'async',
    ...(page.thumbUrl ? { src: page.thumbUrl } : {}),
  });

  const handle = h('button', {
    class: 'icon-btn drag-handle',
    'aria-label': 'ドラッグして並べ替え',
    text: '⋮⋮',
  });

  const card = h(
    'div',
    { class: 'page-card', dataset: { pageId: page.id } },
    h('span', { class: 'page-num', text: String(index + 1) }),
    img,
    h('span', { class: 'page-meta' },
      h('span', { class: 'page-name', text: page.file.name }),
      h('span', {
        class: 'page-sub',
        text: `${size.width}×${size.height} · ${formatBytes(page.file.size)}`,
      }),
    ),
    h('span', { class: 'page-actions' },
      h('button', {
        class: 'icon-btn',
        'aria-label': '上へ移動',
        disabled: index === 0,
        text: '↑',
        onclick: () => movePage(page.id, -1),
      }),
      h('button', {
        class: 'icon-btn',
        'aria-label': '下へ移動',
        disabled: index === state.pages.length - 1,
        text: '↓',
        onclick: () => movePage(page.id, 1),
      }),
      handle,
      h('button', {
        class: 'icon-btn btn-danger-text',
        'aria-label': 'このページを削除',
        text: '✕',
        onclick: () => removePage(page.id),
      }),
    ),
  );

  attachDrag(handle, card);
  return card;
}

function renderProgress(): HTMLElement {
  const { done, total } = state.progress;
  const percent = total ? Math.round((done / total) * 100) : 0;

  const count = h('div', { class: 'progress-count' },
    h('span', { text: String(done) }),
    h('small', { text: ` / ${total} ページ` }),
  );
  const fill = h('div', { class: 'bar-fill' });
  fill.style.width = `${percent}%`;

  progressRefs = { count, fill };

  return h(
    'main',
    { class: 'progress-screen' },
    h('div', { class: 'progress-head', text: 'PDFを作成しています' }),
    count,
    h('div', { class: 'bar' }, fill),
    h('div', {
      class: 'progress-note',
      text: 'このまま画面を開いたままお待ちください。他のアプリに切り替えると止まることがあります。',
    }),
    h('button', { class: 'btn btn-quiet', onclick: cancelGenerate }, 'キャンセル'),
  );
}

function renderDone(): HTMLElement {
  const wrap = h('main', { class: 'stack' });
  wrap.append(h('div', { class: 'done-banner', text: '✓ PDFが完成しました' }));

  const shareable = canSharePdf();

  for (const output of state.outputs) {
    const card = h('div', { class: 'done-card' });
    card.append(
      h('div', { class: 'done-file' },
        h('span', { class: 'done-name', text: output.name }),
        h('span', { class: 'done-size', text: formatBytes(output.blob.size) }),
      ),
      h('div', { class: 'page-sub', text: `${output.pageCount} ページ` }),
    );

    const actions = h('div', { class: 'btn-stack' });
    const ios = isIOS();
    if (shareable) {
      actions.append(
        h(
          'button',
          { class: 'btn', onclick: () => handleShare(output) },
          // iOS の共有シートには「"ファイル"に保存」が含まれる。
          // 保存もここから行うのが確実なので、ボタン名でそう伝える。
          ios ? '保存・共有する' : '共有する',
        ),
      );
    }
    actions.append(
      h(
        'button',
        {
          class: shareable ? 'btn btn-secondary' : 'btn',
          onclick: () => handleSave(output),
        },
        ios ? 'PDFを開いて確認' : 'PDFを保存',
      ),
    );
    card.append(actions);
    wrap.append(card);
  }

  if (state.notice) wrap.append(renderNotice(state.notice));

  if (shareable) {
    wrap.append(
      h('div', {
        class: 'field-hint',
        text: isIOS()
          ? '「保存・共有する」を押すと、Google Drive・メール・「”ファイル”に保存」から渡し先を選べます。'
          : '「共有する」からGoogle Driveやメールなど、お使いのアプリへ渡せます。',
      }),
    );
  }

  wrap.append(
    h('div', { class: 'btn-stack' },
      h('button', { class: 'btn btn-secondary', onclick: backToEditor }, '設定を変えて作りなおす'),
      h('button', { class: 'btn btn-quiet', onclick: resetAll }, '最初から作る'),
    ),
  );

  return wrap;
}

/* ────────── 並べ替え ────────── */

function attachDrag(handle: HTMLElement, card: HTMLElement): void {
  let dragging = false;

  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    dragging = true;
    card.classList.add('dragging');
    handle.setPointerCapture(event.pointerId);
  });

  handle.addEventListener('pointermove', (event) => {
    if (!dragging || !listEl) return;
    const under = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-page-id]');
    if (!under || under === card || under.parentElement !== listEl) return;
    const rect = under.getBoundingClientRect();
    const placeAfter = event.clientY > rect.top + rect.height / 2;
    listEl.insertBefore(card, placeAfter ? under.nextSibling : under);
  });

  const finish = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove('dragging');
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    commitOrderFromDom();
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
}

function commitOrderFromDom(): void {
  if (!listEl) return;
  const order = new Map<string, number>();
  Array.from(listEl.children).forEach((child, index) => {
    const id = (child as HTMLElement).dataset.pageId;
    if (id) order.set(id, index);
  });
  state.pages.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  renumber();
}

function renumber(): void {
  if (!listEl) return;
  Array.from(listEl.children).forEach((child, index) => {
    const el = child as HTMLElement;
    const num = el.querySelector('.page-num');
    if (num) num.textContent = String(index + 1);
    const [up, down] = el.querySelectorAll<HTMLButtonElement>('.page-actions .icon-btn');
    if (up) up.disabled = index === 0;
    if (down) down.disabled = index === state.pages.length - 1;
  });
}

function movePage(id: string, delta: number): void {
  const from = state.pages.findIndex((page) => page.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= state.pages.length) return;
  const [page] = state.pages.splice(from, 1);
  if (page) state.pages.splice(to, 0, page);
  render();
}

function removePage(id: string): void {
  const index = state.pages.findIndex((page) => page.id === id);
  if (index < 0) return;
  const [page] = state.pages.splice(index, 1);
  if (page?.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
  if (state.pages.length === 0) {
    state.screen = 'start';
    state.notice = null;
  }
  render();
}

/* ────────── サムネイル ────────── */

const thumbQueue: string[] = [];
let thumbRunning = false;

function setupThumbObserver(): void {
  if (!listEl) return;
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = (entry.target as HTMLElement).dataset.pageId;
        if (id) enqueueThumb(id);
        thumbObserver?.unobserve(entry.target);
      }
    },
    { rootMargin: '300px 0px' },
  );
  for (const card of Array.from(listEl.children)) thumbObserver.observe(card);
}

function enqueueThumb(id: string): void {
  const page = state.pages.find((item) => item.id === id);
  if (!page) return;
  if (page.thumbStatus !== 'idle') {
    if (page.thumbStatus === 'ready') applyThumb(page);
    return;
  }
  if (!thumbQueue.includes(id)) thumbQueue.push(id);
  void runThumbQueue();
}

async function runThumbQueue(): Promise<void> {
  if (thumbRunning) return;
  thumbRunning = true;
  try {
    while (thumbQueue.length) {
      const id = thumbQueue.shift();
      if (!id) continue;
      const page = state.pages.find((item) => item.id === id);
      if (!page || page.thumbStatus !== 'idle') continue;
      page.thumbStatus = 'loading';
      try {
        page.thumbUrl = await makeThumbnail(page.file, page.info);
        page.thumbStatus = 'ready';
        applyThumb(page);
      } catch {
        page.thumbStatus = 'error';
      }
      await yieldToUI();
    }
  } finally {
    thumbRunning = false;
  }
}

function applyThumb(page: Page): void {
  if (!listEl || !page.thumbUrl) return;
  const card = listEl.querySelector<HTMLElement>(
    `[data-page-id="${CSS.escape(page.id)}"]`,
  );
  const img = card?.querySelector('img');
  if (img && img.getAttribute('src') !== page.thumbUrl) img.src = page.thumbUrl;
}

/* ────────── ファイル選択 ────────── */

function openPicker(): void {
  fileInput.value = '';
  fileInput.click();
}

fileInput.addEventListener('change', () => {
  const files = fileInput.files;
  if (files && files.length) void ingestFiles(Array.from(files));
  fileInput.value = '';
});

function isJpeg(file: File): boolean {
  if (file.type === 'image/jpeg' || file.type === 'image/jpg') return true;
  if (file.type) return false;
  return /\.jpe?g$/i.test(file.name);
}

async function ingestFiles(files: File[]): Promise<void> {
  const jpegs = files.filter(isJpeg);
  const wrongType = files.length - jpegs.length;
  jpegs.sort((a, b) => naturalCompare(a.name, b.name));

  state.busyLabel = '画像を読み込んでいます';
  render();
  await yieldToUI();

  for (const page of state.pages) {
    if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
  }
  thumbQueue.length = 0;

  const pages: Page[] = [];
  let unreadable = 0;
  for (const file of jpegs) {
    const info = await readJpegInfo(file);
    if (!info || !info.width || !info.height) {
      unreadable++;
      continue;
    }
    pages.push({ id: uid(), file, info, thumbUrl: null, thumbStatus: 'idle' });
  }

  state.pages = pages;
  state.outputs = [];
  state.split = false;
  state.busyLabel = null;
  state.notice = null;

  const problems: string[] = [];
  if (wrongType > 0) problems.push(`${wrongType}件はJPG以外のため除きました（現在はJPGに対応しています）`);
  if (unreadable > 0) problems.push(`${unreadable}件は画像として読み取れませんでした`);
  if (pages.length > MAX_PAGES) {
    problems.push(`現在は${MAX_PAGES}ページまでを推奨しています（いまは${pages.length}ページ）`);
  }
  if (problems.length) setNotice('warn', problems.join('。'));

  if (pages.length === 0) {
    state.screen = 'start';
    if (!problems.length) setNotice('warn', '読み込めるJPG画像がありませんでした');
  } else {
    state.screen = 'editor';
    if (state.baseName === 'manga') state.baseName = suggestName(pages);
  }
  render();
}

function suggestName(pages: Page[]): string {
  const first = pages[0]?.file.name ?? '';
  const stem = first.replace(/\.[^.]+$/, '').replace(/[_-]?\d+$/, '').trim();
  return stem.length >= 2 ? stem.slice(0, 40) : 'manga';
}

/* ────────── PDF 作成 ────────── */

/**
 * 何分割するか。原寸なら完成容量が元画像の合計とほぼ等しいので、
 * 1 ファイルが SHARE_SAFE_BYTES に収まる数を逆算できる。
 * 縮小する場合は容量が読めないため 2 分割にとどめる。
 */
function partCount(): number {
  if (state.quality !== 'original') return 2;
  const needed = Math.ceil(totalBytes() / SHARE_SAFE_BYTES);
  return Math.min(state.pages.length, Math.max(2, needed));
}

function splitSizes(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const extra = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

function chunkPages(): Page[][] {
  if (!state.split || state.pages.length <= 1) return [state.pages];
  const chunks: Page[][] = [];
  let at = 0;
  for (const size of splitSizes(state.pages.length, partCount())) {
    chunks.push(state.pages.slice(at, at + size));
    at += size;
  }
  return chunks;
}

function updateProgress(done: number, total: number): void {
  state.progress = { done, total };
  if (!progressRefs) return;
  const [value] = progressRefs.count.children;
  if (value) value.textContent = String(done);
  progressRefs.fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
}

async function generate(): Promise<void> {
  if (!state.pages.length) return;

  const chunks = chunkPages();
  const controller = new AbortController();
  abortController = controller;

  state.notice = null;
  revokeOutputs();
  state.progress = { done: 0, total: state.pages.length };
  state.screen = 'progress';
  render();
  await yieldToUI();

  const outputs: OutputFile[] = [];
  let completed = 0;

  try {
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      if (!chunk || !chunk.length) continue;

      const blob = await writeImagePdf(
        chunk.length,
        async (i) => {
          const page = chunk[i]!;
          return prepareForPdf(page.file, page.info, state.quality);
        },
        {
          longEdgePt: PAGE_LONG_EDGE_PT,
          signal: controller.signal,
          onProgress: () => updateProgress(++completed, state.pages.length),
        },
      );

      const name =
        chunks.length > 1
          ? sanitizeFileName(`${state.baseName}_${index + 1}`)
          : sanitizeFileName(state.baseName);
      outputs.push({ blob, name, pageCount: chunk.length, url: URL.createObjectURL(blob) });
    }

    state.outputs = outputs;
    state.screen = 'done';
  } catch (error) {
    state.screen = 'editor';
    if (!(error instanceof AbortError)) {
      setNotice('error', failureMessage());
      console.error(error);
    }
  } finally {
    abortController = null;
    render();
  }
}

function failureMessage(): string {
  if (state.quality === 'original') {
    return 'PDFを作成できませんでした。画質を「高画質」か「共有用」に変えるか、2つに分けてもう一度お試しください。';
  }
  if (state.quality === 'high') {
    return 'PDFを作成できませんでした。画質を「共有用」に変えるか、2つに分けてもう一度お試しください。';
  }
  return 'PDFを作成できませんでした。ページ数を減らしてもう一度お試しください。';
}

function cancelGenerate(): void {
  abortController?.abort();
  state.screen = 'editor';
  render();
}

function handleShare(output: OutputFile): void {
  // navigator.share はユーザー操作から同期的に呼ぶ必要があるため、
  // 画面を書き換える前に呼び出しておく。
  const shared = sharePdf(output.blob, output.name);

  state.saving = { label: '共有の準備をしています', hint: waitHint(output.blob.size) };
  render();

  void shared.then((result) => {
    state.saving = null;
    if (result === 'unsupported') {
      setNotice(
        'warn',
        'この環境では共有できませんでした。ファイルが大きすぎる可能性があります。' +
          '画質を下げるか、分割してお試しください。',
      );
    }
    render();
  });
}

function handleSave(output: OutputFile): void {
  const result = savePdf(output.url, output.name);
  if (result === 'opened') {
    setNotice(
      'warn',
      '新しいタブでPDFを開きました。画面下の共有ボタン（□に↑）から「”ファイル”に保存」を選ぶと保存できます。この画面は残してあるので、戻ればやり直せます。',
    );
    render();
  } else if (result === 'blocked') {
    setNotice(
      'warn',
      'ポップアップがブロックされました。「共有する」から保存してください。',
    );
    render();
  }
}

function revokeOutputs(): void {
  for (const output of state.outputs) URL.revokeObjectURL(output.url);
  state.outputs = [];
}

function backToEditor(): void {
  revokeOutputs();
  state.screen = 'editor';
  state.notice = null;
  render();
}

function resetAll(): void {
  for (const page of state.pages) {
    if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
  }
  thumbQueue.length = 0;
  state.pages = [];
  revokeOutputs();
  state.split = false;
  state.baseName = 'manga';
  state.notice = null;
  state.screen = 'start';
  render();
}

/* ────────── 起動 ────────── */

render();
